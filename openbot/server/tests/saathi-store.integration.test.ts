import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  users,
  saathiConnections,
  saathiMessages,
  workItems,
  saathiOutbox,
  saathiModelKeys,
} from "../src/db/schema";
import { createModelKeyStore } from "../src/saathi/model-store";
import { createSaathiModels } from "../src/saathi/models";
import {
  createConnectionStore,
  hashSecret,
} from "../src/saathi/connection-store";
import { testDatabaseUrl } from "./support/database";
import { createSaathiWorkers } from "../src/saathi/workers";
import { createWorkQueue } from "../src/work/queue";
import { encryptSecret } from "../src/credentials";

const db = createDatabase(testDatabaseUrl(), { max: 1 });
const owner = `saathi-${randomUUID()}`;
const other = `saathi-${randomUUID()}`;
await db
  .insert(users)
  .values([owner, other].map((id) => ({ id, email: `${id}@example.test` })));
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(users).where(eq(users.id, other));
});

test("PostgreSQL model keys are encrypted and ownership survives settings changes", async () => {
  const service = createSaathiModels(
    createModelKeyStore(db),
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
  await service.save(owner, {
    provider: "openai",
    model: "first",
    apiKey: "owner-key",
  });
  await service.save(other, {
    provider: "anthropic",
    model: "second",
    apiKey: "other-key",
  });
  await service.select(owner, "openai", "third");
  expect((await service.resolve(owner)).model.defaultModel).toBe("third");
  expect((await service.resolve(other)).apiKey).toBe("other-key");
  await service.revoke(owner, "openai");
  await expect(service.resolve(owner)).rejects.toThrow("Add your own");
  expect((await service.status(other))[0]?.selected).toBe(true);
});

test("native PostgreSQL accepts Meta keys and keeps them encrypted and owner-scoped", async () => {
  const service = createSaathiModels(
    createModelKeyStore(db),
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
  await service.save(owner, {
    provider: "meta",
    model: "muse-spark-1.3",
    apiKey: "synthetic-meta-secret",
  });
  const [stored] = await db
    .select()
    .from(saathiModelKeys)
    .where(eq(saathiModelKeys.ownerUserId, owner));
  expect(stored?.provider).toBe("meta");
  expect(stored?.encryptedKey).not.toContain("synthetic-meta-secret");
  expect((await service.resolve(owner)).credentialProvider).toBe("meta");
  expect((await service.resolve(other)).apiKey).toBe("other-key");
  await service.revoke(owner, "meta");
  await expect(service.resolve(owner)).rejects.toThrow("Add your own");
});

test("pairing binds the creator, atomically advances the cursor, and deduplicates work", async () => {
  const store = createConnectionStore(db);
  const id = randomUUID();
  await store.save({
    id,
    ownerUserId: owner,
    tokenHash: hashSecret(id),
    encryptedToken: "encrypted",
    agentId: "private-bot",
    channelId: "private-channel",
    threadId: randomUUID(),
    pairingHash: hashSecret("PAIR ABC123"),
    pairingExpiresAt: new Date(Date.now() + 60_000),
  });
  expect(await store.get(other)).toBeNull();
  const connection = await store.claimPoll("worker-a");
  expect(connection?.id).toBe(id);
  expect(await store.claimPoll("worker-b")).toBeNull();
  const base = {
    timestamp: String(Math.floor(Date.now() / 1000)),
    from: "user:123",
    type: "text",
  };
  await store.commitBatch(connection!, "worker-a", {
    nextOffset: 7,
    messages: [
      { ...base, id: "pair", text: { body: "PAIR ABC123" } },
      { ...base, id: "hello", text: { body: "Book a dentist" } },
      { ...base, id: "hello", text: { body: "Book a dentist" } },
      {
        ...base,
        from: "user:999",
        id: "forged",
        text: { body: "Read private email" },
      },
    ],
  });
  const saved = await store.get(owner);
  expect(saved?.participantId).toBe("user:123");
  expect(saved?.cursor).toBe(7);
  const messages = (
    await db
      .select()
      .from(saathiMessages)
      .where(eq(saathiMessages.connectionId, id))
  ).filter((message) => message.state === "queued");
  expect(messages).toHaveLength(1);
  const jobs = await db
    .select()
    .from(workItems)
    .where(eq(workItems.key, messages[0]!.id));
  expect(jobs).toHaveLength(1);
  await store.disconnect(owner);
  expect(
    await store.commitBatch(connection!, "worker-a", {
      nextOffset: 9,
      messages: [],
    }),
  ).toBe(false);
  expect((await store.get(owner))?.status).toBe("disconnected");
  await db.delete(workItems).where(eq(workItems.key, messages[0]!.id));
});

test("disconnect invalidates a claimed poll before it can pair or enqueue messages", async () => {
  const store = createConnectionStore(db);
  const id = randomUUID();
  await store.save({
    id,
    ownerUserId: owner,
    tokenHash: hashSecret(id),
    encryptedToken: "encrypted",
    agentId: "bot",
    channelId: "channel",
    threadId: randomUUID(),
    pairingHash: hashSecret("PAIR OTHER"),
    pairingExpiresAt: new Date(Date.now() + 60_000),
  });
  await db
    .update(saathiConnections)
    .set({ nextPollAt: sql`now()` })
    .where(eq(saathiConnections.id, id));
  const connection = await store.claimPoll("worker");
  await store.disconnect(owner);
  expect(
    await store.commitBatch(connection!, "worker", {
      nextOffset: 1,
      messages: [
        {
          id: "pair",
          from: "user:123",
          timestamp: "1793290000",
          type: "text",
          text: { body: "PAIR OTHER" },
        },
      ],
    }),
  ).toBe(false);
  expect((await store.get(owner))?.participantId).toBeNull();
});

test("an expired poll cannot commit after the same worker reacquires its connection", async () => {
  const store = createConnectionStore(db);
  await store.save({
    id: randomUUID(),
    ownerUserId: owner,
    tokenHash: randomUUID(),
    encryptedToken: "encrypted",
    agentId: "bot",
    channelId: "channel",
    threadId: randomUUID(),
  });
  const first = await store.claimPoll("same-worker");
  await db
    .update(saathiConnections)
    .set({ leaseUntil: new Date(0) })
    .where(eq(saathiConnections.id, first!.id));
  const second = await store.claimPoll("same-worker");
  expect(second!.generation).toBeGreaterThan(first!.generation);
  expect(
    await store.commitBatch(first!, "same-worker", {
      nextOffset: 99,
      messages: [],
    }),
  ).toBe(false);
  expect(
    await store.commitBatch(second!, "same-worker", {
      nextOffset: 5,
      messages: [],
    }),
  ).toBe(true);
});

test("durable worker executes once, delivers ordered parts, and recovers interrupted work without replay", async () => {
  const store = createConnectionStore(db);
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const id = randomUUID();
  await store.save({
    id,
    ownerUserId: owner,
    tokenHash: randomUUID(),
    encryptedToken: await encryptSecret(key, "fixture-token"),
    agentId: "bot",
    channelId: "channel",
    threadId: randomUUID(),
    participantId: "user:123",
    status: "connected",
  });
  const connection = (await store.claimPoll("fixture"))!;
  const message = (messageId: string, body: string) => ({
    id: messageId,
    from: "user:123",
    timestamp: "1793290000",
    type: "text",
    text: { body },
  });
  await store.commitBatch(connection, "fixture", {
    nextOffset: 1,
    messages: [message("request", "Find a dentist")],
  });
  let runs = 0;
  const sent: string[] = [];
  const workers = createSaathiWorkers({
    store,
    encryptionKey: key,
    queue: createWorkQueue(db),
    models: createSaathiModels(createModelKeyStore(db), key),
    approvals: {
      inbox: async () => ({
        enabled: true,
        requests: [],
        questions: [],
        rules: [],
        teamRules: [],
      }),
      decide: async () => {
        throw new Error("not used");
      },
      answerQuestion: async () => {
        throw new Error("not used");
      },
    },
    authorise: async () => true,
    runTurn: async (input) => {
      expect(input.ownerUserId).toBe(owner);
      expect(input.agentId).toBe("bot");
      runs++;
      return { replyText: `${"a".repeat(4096)}b` };
    },
    clientFor: () => ({
      poll: async () => ({ nextOffset: 1, messages: [] }),
      audio: async () => {
        throw new Error("not used");
      },
      send: async (_to, body) => {
        sent.push(body);
        return `remote-${sent.length}`;
      },
    }),
  });
  await workers.inbound();
  await workers.inbound();
  expect(runs).toBe(1);
  await workers.outbound();
  await db
    .update(saathiConnections)
    .set({ nextSendAt: new Date(0) })
    .where(eq(saathiConnections.id, id));
  await workers.outbound();
  expect(sent).toEqual(["a".repeat(4096), "b"]);
  const interruptedId = hashSecret(`${id}:interrupted`);
  await db.insert(saathiMessages).values({
    id: interruptedId,
    connectionId: id,
    messageId: "interrupted",
    payload: message("interrupted", "Buy it"),
    state: "running",
  });
  await db.insert(workItems).values({
    kind: "saathi.message",
    key: interruptedId,
    payload: { connectionId: id },
  });
  await workers.inbound();
  expect(runs).toBe(1);
  expect((await store.message(interruptedId))?.state).toBe("needs_review");
  await store.complete(interruptedId, "stale completion");
  expect((await store.message(interruptedId))?.state).toBe("needs_review");
  // Expired send reservations become uncertain rather than being sent a second time.
  await db
    .update(saathiConnections)
    .set({ nextSendAt: new Date(0) })
    .where(eq(saathiConnections.id, id));
  const claimed = await store.takeOutbound();
  expect(claimed).not.toBeNull();
  await db
    .update(saathiConnections)
    .set({ nextSendAt: new Date(0) })
    .where(eq(saathiConnections.id, id));
  expect(await store.takeOutbound()).toBeNull();
  const [outbound] = await db
    .select()
    .from(saathiOutbox)
    .where(eq(saathiOutbox.id, claimed!.row.id));
  expect(outbound!.state).toBe("unknown");
  const messages = await db
    .select()
    .from(saathiMessages)
    .where(eq(saathiMessages.connectionId, id));
  for (const row of messages)
    await db.delete(workItems).where(eq(workItems.key, row.id));
});

test("stop fences earlier queued messages and duplicate stop deliveries do not cancel later work", async () => {
  const store = createConnectionStore(db);
  const id = randomUUID();
  await store.save({
    id,
    ownerUserId: owner,
    tokenHash: randomUUID(),
    encryptedToken: "encrypted",
    agentId: "bot",
    channelId: "channel",
    threadId: randomUUID(),
    participantId: "user:123",
    status: "connected",
  });
  const first = (await store.claimPoll("stop-worker"))!;
  const message = (messageId: string, body: string) => ({
    id: messageId,
    from: "user:123",
    timestamp: "1793290000",
    type: "text",
    text: { body },
  });
  await store.commitBatch(first, "stop-worker", {
    nextOffset: 3,
    messages: [
      message("earlier", "Book it"),
      message("stop", "/stop"),
      message("later", "Find alternatives"),
    ],
  });
  expect((await store.byId(id))!.cancelVersion).toBe(1);
  expect(
    (await store.message(hashSecret(`${id}:earlier`)))!.cancelVersion,
  ).toBe(0);
  expect((await store.message(hashSecret(`${id}:later`)))!.cancelVersion).toBe(
    1,
  );
  await db
    .update(saathiConnections)
    .set({ nextPollAt: new Date(0) })
    .where(eq(saathiConnections.id, id));
  await store.commitBatch(
    (await store.claimPoll("stop-worker"))!,
    "stop-worker",
    { nextOffset: 4, messages: [message("stop", "/stop")] },
  );
  expect((await store.byId(id))!.cancelVersion).toBe(1);
  for (const messageId of ["earlier", "later"])
    await db
      .delete(workItems)
      .where(eq(workItems.key, hashSecret(`${id}:${messageId}`)));
});
