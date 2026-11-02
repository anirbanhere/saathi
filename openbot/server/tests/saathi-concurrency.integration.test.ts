import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { saathiMessages, saathiOutbox, users } from "../src/db/schema";
import {
  createConnectionStore,
  hashSecret,
} from "../src/saathi/connection-store";
import { testDatabaseUrl } from "./support/database";

// Independent connections are essential: a single-connection fixture serializes the race away.
const database = createDatabase(testDatabaseUrl(), { max: 4 });
let owner: string;
let connectionId: string;
let channelId: string;
beforeEach(async () => {
  owner = `saathi-concurrency-${randomUUID()}`;
  connectionId = randomUUID();
  channelId = randomUUID();
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await createConnectionStore(database).save({
    id: connectionId,
    ownerUserId: owner,
    tokenHash: hashSecret(connectionId),
    encryptedToken: "encrypted-fixture",
    agentId: "private-fixture-bot",
    channelId,
    threadId: randomUUID(),
    participantId: "user:123",
    status: "connected",
  });
});
afterEach(async () => {
  await database.delete(users).where(eq(users.id, owner));
});
afterAll(async () => {
  await database.$client.close();
});

test("four poll replicas acquire exactly one live connection lease", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      createConnectionStore(database).claimPoll(`replica-${index}`),
    ),
  );
  const claimed = results.filter((value) => value !== null);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.id).toBe(connectionId);
  expect(claimed[0]?.generation).toBe(2);
});

test("concurrent inbound replicas cannot start two turns in one conversation", async () => {
  const ids = [randomUUID(), randomUUID()];
  await database.insert(saathiMessages).values(
    ids.map((id) => ({
      id,
      connectionId,
      messageId: id,
      payload: { type: "text", text: { body: "Find options" } },
    })),
  );
  const results = await Promise.all(
    ids.map((id) => createConnectionStore(database).startMessage(id)),
  );
  expect(results.filter((value) => value !== null)).toHaveLength(1);
  const rows = await database
    .select()
    .from(saathiMessages)
    .where(eq(saathiMessages.connectionId, connectionId));
  expect(rows.filter((value) => value.state === "running")).toHaveLength(1);
  expect(rows.filter((value) => value.state === "queued")).toHaveLength(1);
});

test("concurrent multipart replies stay contiguous and only one sender can reserve the connection", async () => {
  await Promise.all([
    createConnectionStore(database).notify(
      owner,
      channelId,
      `${"A".repeat(4096)}a`,
      "reply-a",
    ),
    createConnectionStore(database).notify(
      owner,
      channelId,
      `${"B".repeat(4096)}b`,
      "reply-b",
    ),
  ]);
  const rows = await database
    .select()
    .from(saathiOutbox)
    .where(eq(saathiOutbox.connectionId, connectionId))
    .orderBy(asc(saathiOutbox.sequence));
  const texts = rows.map((value) => value.text);
  expect(texts).toHaveLength(4);
  expect(texts).toEqual(
    texts[0]?.startsWith("A")
      ? ["A".repeat(4096), "a", "B".repeat(4096), "b"]
      : ["B".repeat(4096), "b", "A".repeat(4096), "a"],
  );
  const reservations = await Promise.all(
    Array.from({ length: 4 }, () =>
      createConnectionStore(database).takeOutbound(),
    ),
  );
  const claimed = reservations.filter((value) => value !== null);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.row.id).toBe(rows[0]?.id);
});
