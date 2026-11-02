import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createCallStore } from "../src/saathi/call-store";
import { createCallService } from "../src/saathi/calls";
import { testDatabaseUrl } from "./support/database";
const database = createDatabase(testDatabaseUrl(), { max: 3 });
const owner = `call-test-${randomUUID()}`;
const service = createCallService(createCallStore(database), {
  simulation: true,
});
beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "Call test" });
});
afterAll(async () => {
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});
test("persistent approval uses atomic version checks and survives a service restart", async () => {
  const call = await service.request(owner, {
    number: "+919876543210",
    purpose: "Ask opening hours",
    disclosure: "No personal details",
    language: "en-IN",
    maxSeconds: 60,
  });
  const outcomes = await Promise.allSettled([
    service.approve(owner, call.id, call.previewHash),
    service.approve(owner, call.id, call.previewHash),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const restarted = createCallService(createCallStore(database), {
    simulation: true,
  });
  expect((await restarted.list(owner))[0]?.status).toBe("ringing");
  expect(await restarted.list("someone-else")).toEqual([]);
  await restarted.control(owner, call.id, "end");
});
