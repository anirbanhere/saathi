import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  saathiConnections as connections,
  saathiMessages as messages,
  saathiOutbox as outbox,
  workItems,
} from "../db/schema";
import { splitReply, type WhatsAppBatch } from "./whatsapp-client";

export const MESSAGE_WORK = "saathi.message";
export type Connection = typeof connections.$inferSelect;
export const hashSecret = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function enqueue(
  tx: Tx,
  connectionId: string,
  text: string,
  reference: string,
) {
  // One connection lock orders complete multipart replies and their delivery across replicas.
  await tx
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .for("update");
  const delivery =
    text.length > 24_000
      ? `${text.slice(0, 23_800)}\n\n[Reply shortened. Open the companion conversation for the complete result and any approval requests.]`
      : text;
  for (const [index, part] of splitReply(delivery).entries()) {
    await tx
      .insert(outbox)
      .values({
        id: hashSecret(`${connectionId}:${reference}:${index}`),
        connectionId,
        text: part,
      })
      .onConflictDoNothing();
  }
}

export function createConnectionStore(db: Database) {
  const active = (value: Connection, worker: string) =>
    and(
      eq(connections.id, value.id),
      eq(connections.generation, value.generation),
      eq(connections.leaseOwner, worker),
      sql`${connections.leaseUntil} > now()`,
      inArray(connections.status, ["pairing", "connected"]),
    );
  return {
    async get(owner: string): Promise<Connection | null> {
      const [row] = await db
        .select()
        .from(connections)
        .where(eq(connections.ownerUserId, owner));
      return row ?? null;
    },
    async byId(id: string): Promise<Connection | null> {
      const [row] = await db
        .select()
        .from(connections)
        .where(eq(connections.id, id));
      return row ?? null;
    },
    async save(value: typeof connections.$inferInsert) {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`saathi:${value.ownerUserId}`}))`,
        );
        await tx
          .delete(connections)
          .where(eq(connections.ownerUserId, value.ownerUserId));
        await tx.insert(connections).values(value);
      });
    },
    async disconnect(owner: string) {
      await db
        .update(connections)
        .set({
          status: "disconnected",
          encryptedToken: "",
          generation: sql`${connections.generation} + 1`,
          leaseOwner: null,
          leaseUntil: null,
          pairingHash: null,
        })
        .where(eq(connections.ownerUserId, owner));
    },
    async claimPoll(worker: string): Promise<Connection | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(connections)
          .where(
            and(
              inArray(connections.status, ["pairing", "connected"]),
              lte(connections.nextPollAt, sql`now()`),
              or(
                isNull(connections.leaseUntil),
                lte(connections.leaseUntil, sql`now()`),
              ),
            ),
          )
          .orderBy(asc(connections.nextPollAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return null;
        const [leased] = await tx
          .update(connections)
          .set({
            leaseOwner: worker,
            generation: sql`${connections.generation} + 1`,
            leaseUntil: sql`now() + interval '45 seconds'`,
          })
          .where(eq(connections.id, row.id))
          .returning();
        return leased ?? null;
      });
    },
    async commitBatch(value: Connection, worker: string, batch: WhatsAppBatch) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(connections)
          .where(active(value, worker))
          .limit(1)
          .for("update");
        if (!current || batch.nextOffset < current.cursor) return false;
        let participant = current.participantId;
        let cancelVersion = current.cancelVersion;
        for (const message of batch.messages) {
          if (!participant) {
            if (
              message.type === "text" &&
              current.pairingHash &&
              current.pairingExpiresAt &&
              current.pairingExpiresAt > new Date() &&
              hashSecret(message.text?.body.trim() ?? "") ===
                current.pairingHash
            ) {
              participant = message.from;
              await tx
                .insert(messages)
                .values({
                  id: hashSecret(`${current.id}:${message.id}`),
                  connectionId: current.id,
                  messageId: message.id,
                  payload: { type: "pairing" },
                  state: "control",
                })
                .onConflictDoNothing();
              await enqueue(
                tx,
                current.id,
                "Saathi is connected. Send a request in Tamil, Hindi, Malayalam, or English. Use /models to view your models or /help for commands.",
                "paired",
              );
            }
            continue;
          }
          if (message.from !== participant || message.type === "reaction")
            continue;
          const id = hashSecret(`${current.id}:${message.id}`);
          const inserted = await tx
            .insert(messages)
            .values({
              id,
              connectionId: current.id,
              messageId: message.id,
              payload: message,
              cancelVersion,
            })
            .onConflictDoNothing()
            .returning({ id: messages.id });
          if (!inserted.length) continue;
          if (/^(\/stop|stop)$/i.test(message.text?.body.trim() ?? "")) {
            cancelVersion++;
            await tx
              .update(messages)
              .set({ state: "control" })
              .where(eq(messages.id, id));
            await enqueue(
              tx,
              current.id,
              "Stopping current and queued WhatsApp turns. Actions already sent may still complete. Existing approval requests remain in the companion; decline unwanted actions there.",
              message.id,
            );
            continue;
          }
          await tx
            .insert(workItems)
            .values({
              kind: MESSAGE_WORK,
              key: id,
              payload: { connectionId: current.id },
            })
            .onConflictDoNothing();
        }
        await tx
          .update(connections)
          .set({
            cancelVersion,
            cursor: batch.nextOffset,
            participantId: participant,
            status: participant ? "connected" : "pairing",
            pairingHash: participant ? null : current.pairingHash,
            leaseOwner: null,
            leaseUntil: null,
            nextPollAt: sql`now() + interval '4.1 seconds'`,
            lastError: null,
          })
          .where(active(value, worker));
        return true;
      });
    },
    async pollFailed(
      value: Connection,
      worker: string,
      fatal: boolean,
      message: string,
    ) {
      await db
        .update(connections)
        .set({
          status: fatal ? "error" : value.status,
          lastError: message,
          leaseOwner: null,
          leaseUntil: null,
          nextPollAt: sql`now() + interval '60 seconds'`,
        })
        .where(active(value, worker));
    },
    async message(id: string) {
      const [row] = await db.select().from(messages).where(eq(messages.id, id));
      return row ?? null;
    },
    async startMessage(id: string) {
      return db.transaction(async (tx) => {
        const [message] = await tx
          .select()
          .from(messages)
          .where(eq(messages.id, id));
        if (!message) return null;
        await tx
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.id, message.connectionId))
          .for("update");
        const running = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.connectionId, message.connectionId),
              eq(messages.state, "running"),
            ),
          )
          .limit(1);
        if (running.length) return null;
        const [row] = await tx
          .update(messages)
          .set({ state: "running" })
          .where(and(eq(messages.id, id), eq(messages.state, "queued")))
          .returning();
        return row ?? null;
      });
    },
    async complete(id: string, reply: string, state = "completed") {
      await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ connectionId: messages.connectionId })
          .from(messages)
          .where(eq(messages.id, id));
        if (!existing) return;
        await tx
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.id, existing.connectionId))
          .for("update");
        const [row] = await tx
          .update(messages)
          .set({ state, reply })
          .where(
            and(
              eq(messages.id, id),
              inArray(messages.state, ["queued", "running"]),
            ),
          )
          .returning();
        if (row) await enqueue(tx, row.connectionId, reply, id);
      });
    },
    async notify(
      owner: string,
      channel: string,
      text: string,
      reference: string,
    ) {
      const [row] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.ownerUserId, owner),
            eq(connections.channelId, channel),
            eq(connections.status, "connected"),
          ),
        );
      if (row)
        await db.transaction((tx) => enqueue(tx, row.id, text, reference));
    },
    async takeOutbound() {
      return db.transaction(async (tx) => {
        const [connection] = await tx
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.status, "connected"),
              lte(connections.nextSendAt, sql`now()`),
              sql`exists (select 1 from ${outbox} where ${outbox.connectionId} = ${connections.id} and ${outbox.state} in ('queued', 'sending'))`,
            ),
          )
          .orderBy(asc(connections.nextSendAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!connection) return null;
        // An earlier sender exceeded its 45-second reservation. Its remote effect is unknown.
        await tx
          .update(outbox)
          .set({ state: "unknown" })
          .where(
            and(
              eq(outbox.connectionId, connection.id),
              eq(outbox.state, "sending"),
            ),
          );
        const [row] = await tx
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.connectionId, connection.id),
              eq(outbox.state, "queued"),
            ),
          )
          .orderBy(asc(outbox.sequence))
          .limit(1);
        if (!row) return null;
        await tx
          .update(outbox)
          .set({ state: "sending" })
          .where(eq(outbox.id, row.id));
        await tx
          .update(connections)
          .set({ nextSendAt: sql`now() + interval '45 seconds'` })
          .where(eq(connections.id, connection.id));
        return { row, connection };
      });
    },
    async finishOutbound(
      id: string,
      state: "sent" | "queued" | "unknown" | "failed",
      remoteId: string | null = null,
    ) {
      await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ connectionId: outbox.connectionId })
          .from(outbox)
          .where(eq(outbox.id, id));
        if (!existing) return;
        await tx
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.id, existing.connectionId))
          .for("update");
        const [row] = await tx
          .update(outbox)
          .set({ state, remoteId })
          .where(and(eq(outbox.id, id), eq(outbox.state, "sending")))
          .returning();
        if (row)
          await tx
            .update(connections)
            .set({
              nextSendAt:
                state === "queued"
                  ? sql`now() + interval '60 seconds'`
                  : sql`now() + interval '5.1 seconds'`,
              lastError:
                state === "unknown"
                  ? "A message has an uncertain delivery result. Check the companion conversation before requesting a resend."
                  : state === "failed"
                    ? "WhatsApp delivery failed. Check your connection and companion conversation."
                    : null,
            })
            .where(eq(connections.id, row.connectionId));
      });
    },
  };
}
export type ConnectionStore = ReturnType<typeof createConnectionStore>;
