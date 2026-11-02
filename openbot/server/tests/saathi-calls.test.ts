import { expect, test } from "bun:test";
import {
  createCallService,
  type CallRecord,
  type CallStore,
} from "../src/saathi/calls";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createCallRoutes } from "../src/saathi/call-routes";

function fixture() {
  const rows = new Map<string, CallRecord>();
  const store: CallStore = {
    async insert(row) {
      rows.set(row.id, structuredClone(row));
    },
    async list(owner) {
      return [...rows.values()].filter((row) => row.owner === owner);
    },
    async get(owner, id) {
      const row = rows.get(id);
      return row?.owner === owner ? structuredClone(row) : null;
    },
    async change(owner, id, version, patch) {
      const row = rows.get(id);
      if (!row || row.owner !== owner || row.version !== version) return false;
      rows.set(id, { ...row, ...patch, version: version + 1 });
      return true;
    },
  };
  let now = Date.now();
  return {
    service: createCallService(store, { simulation: true, now: () => now }),
    advance: () => {
      now += 11 * 60_000;
    },
  };
}
const request = {
  number: "+919876543210",
  purpose: "Ask about opening hours",
  disclosure: "First name only",
  language: "en-IN",
  maxSeconds: 120,
};
test("outbound simulation requires a matching unexpired approval and never represents a real call", async () => {
  const { service, advance } = fixture();
  const row = await service.request("owner", request);
  expect(row.status).toBe("awaiting_approval");
  await expect(
    service.approve("other", row.id, row.previewHash),
  ).rejects.toThrow();
  await expect(service.approve("owner", row.id, "wrong")).rejects.toThrow();
  const approved = await service.approve("owner", row.id, row.previewHash);
  expect(approved.status).toBe("ringing");
  expect(approved.simulated).toBe(true);
  await expect(
    service.approve("owner", row.id, row.previewHash),
  ).rejects.toThrow();
  const expired = await service.request("owner", request);
  advance();
  await expect(
    service.approve("owner", expired.id, expired.previewHash),
  ).rejects.toThrow();
});
test("inbound caller ID never becomes owner identity and takeover ends AI control", async () => {
  const { service } = fixture();
  const row = await service.incoming("owner", { number: request.number });
  expect(row.direction).toBe("incoming");
  expect(row.callerVerified).toBe(false);
  expect(row.recording).toBe(false);
  expect(row.summary).toContain("AI assistant");
  await expect(service.control("other", row.id, "answer")).rejects.toThrow();
  await service.control("owner", row.id, "answer");
  const taken = await service.control("owner", row.id, "takeover");
  expect(taken.status).toBe("human_control");
  expect(taken.aiSpeaking).toBe(false);
  expect((await service.control("owner", row.id, "end")).status).toBe("ended");
});
test("duration caps, invalid transitions and unconfigured live calls fail closed", async () => {
  const { service } = fixture();
  await expect(
    service.request("owner", { ...request, maxSeconds: 9000 }),
  ).rejects.toThrow();
  await expect(
    service.request("owner", { ...request, number: "100" }),
  ).rejects.toThrow();
  const row = await service.request("owner", request);
  await expect(service.control("owner", row.id, "answer")).rejects.toThrow();
  expect((await service.list("other")).length).toBe(0);
});
test("call APIs require an owner session and deny the public shared demo", async () => {
  const { service } = fixture();
  function app(publicDemo: boolean) {
    const router = new Hono<{ Variables: AppVariables }>();
    router.use("*", async (context, next) => {
      if (!context.req.header("test-owner"))
        return context.json({ error: "Authentication required" }, 401);
      context.set("actor", {
        id: "owner",
        email: "owner@example.test",
        role: "user",
      });
      await next();
    });
    router.route("/calls", createCallRoutes(service, publicDemo));
    return router;
  }
  expect((await app(false).request("/calls")).status).toBe(401);
  expect(
    (await app(true).request("/calls", { headers: { "test-owner": "owner" } }))
      .status,
  ).toBe(403);
  const privateResponse = await app(false).request("/calls", {
    headers: { "test-owner": "owner" },
  });
  expect(privateResponse.status).toBe(200);
  expect((await privateResponse.json()).liveCalling).toBe(false);
});
