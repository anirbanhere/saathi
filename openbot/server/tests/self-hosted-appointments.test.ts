import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SelfHostedStore } from "../src/self-hosted/store";

const stores: SelfHostedStore[] = [];
const folders: string[] = [];
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-appointments-"));
  folders.push(folder);
  let now = Date.parse("2026-10-29T04:00:00Z");
  const path = join(folder, "state.sqlite");
  const store = new SelfHostedStore(path, { now: () => now });
  stores.push(store);
  return {
    store,
    path,
    a: store.createSession(),
    b: store.createSession(),
    clock: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-appointments-")
    )
      throw Error("Refuse unsafe test cleanup");
    rmSync(folder, { recursive: true, force: true });
  }
});
const create = (store: SelfHostedStore, owner: string, request_id = "create") =>
  store.appointments.create(owner, {
    request_id,
    date: "2026-10-30",
    locale: "en-IN",
  });

test("demo booking is owned, approved exactly once and survives restart without replay", () => {
  const { store, path, a, b } = world();
  const task = create(store, a.owner);
  expect(task.mode).toBe("mock");
  expect(task.state).toBe("AWAITING_SELECTION");
  expect(task.plan.length).toBeGreaterThan(2);
  expect(() => store.appointments.get(b.owner, task.id)).toThrow("not found");
  const quote = store.appointments.preview(a.owner, task.id, {
    slot_id: "10:00",
    version: task.version,
  });
  expect(quote.task.preview?.amount).toBe(500);
  expect(quote.task.preview?.currency).toBe("INR");
  expect(quote.task.preview?.hash).toHaveLength(64);
  const body = {
    request_id: "decision",
    decision: "approve" as const,
    version: quote.task.version,
    nonce: quote.nonce,
  };
  const result = store.appointments.decide(a.owner, task.id, body);
  expect(result.state).toBe("COMPLETED");
  expect(result.receipt?.reference).toStartWith("MOCK-");
  expect(store.appointments.decide(a.owner, task.id, body)).toEqual(result);
  expect(() => store.appointments.decide(b.owner, task.id, body)).toThrow(
    "not found",
  );
  expect(() =>
    store.appointments.decide(a.owner, task.id, {
      ...body,
      decision: "reject",
    }),
  ).toThrow("conflicts");
  expect(() =>
    store.appointments.cancel(a.owner, task.id, result.version),
  ).toThrow("completed");
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.appointments.get(a.owner, task.id).receipt).toEqual(
    result.receipt,
  );
  expect(reopened.appointments.decide(a.owner, task.id, body)).toEqual(result);
  expect(
    JSON.stringify(reopened.appointments.get(a.owner, task.id)),
  ).not.toContain(quote.nonce);
});
test("re-review invalidates old approvals; wrong tokens/expired quotes cannot reserve a slot", () => {
  const { store, a, clock, now } = world();
  const task = create(store, a.owner);
  const first = store.appointments.preview(a.owner, task.id, {
    slot_id: "10:00",
    version: task.version,
  });
  const second = store.appointments.preview(a.owner, task.id, {
    slot_id: "11:00",
    version: first.task.version,
  });
  expect(() =>
    store.appointments.decide(a.owner, task.id, {
      request_id: "old",
      decision: "approve",
      version: first.task.version,
      nonce: first.nonce,
    }),
  ).toThrow("changed");
  expect(() =>
    store.appointments.decide(a.owner, task.id, {
      request_id: "bad",
      decision: "approve",
      version: second.task.version,
      nonce: "x".repeat(43),
    }),
  ).toThrow("approval");
  clock(now() + 600001);
  expect(() =>
    store.appointments.decide(a.owner, task.id, {
      request_id: "expired",
      decision: "approve",
      version: second.task.version,
      nonce: second.nonce,
    }),
  ).toThrow("expired");
  expect(store.appointments.get(a.owner, task.id).state).toBe("EXPIRED");
  expect(
    store.appointments.options("2026-10-30").slots.map((s) => s.id),
  ).toContain("11:00");
});
test("two owners cannot reserve the same mock slot; losing preview can be changed", () => {
  const { store, a, b } = world();
  const ta = create(store, a.owner),
    tb = create(store, b.owner);
  const pa = store.appointments.preview(a.owner, ta.id, {
      slot_id: "10:00",
      version: ta.version,
    }),
    pb = store.appointments.preview(b.owner, tb.id, {
      slot_id: "10:00",
      version: tb.version,
    });
  const decide = (owner: string, id: string, p: typeof pa) =>
    store.appointments.decide(owner, id, {
      request_id: "reserve",
      decision: "approve",
      nonce: p.nonce,
      version: p.task.version,
    });
  expect(decide(a.owner, ta.id, pa).state).toBe("COMPLETED");
  expect(decide(b.owner, tb.id, pb).state).toBe("UNAVAILABLE");
  const retry = store.appointments.preview(b.owner, tb.id, {
    slot_id: "11:00",
    version: pb.task.version + 1,
  });
  expect(retry.task.state).toBe("APPROVAL_PENDING");
  expect(
    store.appointments
      .options("2026-10-30")
      .slots.some((s) => s.id === "10:00"),
  ).toBe(false);
});
test("create is repeat-safe; cancellation/rejection are terminal and dates/unknown fields fail closed", () => {
  const { store, a } = world();
  const task = create(store, a.owner);
  expect(create(store, a.owner).id).toBe(task.id);
  expect(() =>
    store.appointments.create(a.owner, {
      request_id: "create",
      date: "2026-10-31",
      locale: "en-IN",
    }),
  ).toThrow("conflicts");
  for (const date of [
    "2026-10-28",
    "2026-11-31",
    "2099-01-01",
    "2026-10-30T10:00Z",
  ])
    expect(() => store.appointments.options(date)).toThrow();
  expect(() =>
    store.appointments.create(a.owner, {
      request_id: "forged",
      date: "2026-10-30",
      locale: "en-IN",
      provider: "live",
    }),
  ).toThrow();
  expect(store.appointments.cancel(a.owner, task.id, task.version).state).toBe(
    "CANCELLED",
  );
  expect(() =>
    store.appointments.preview(a.owner, task.id, {
      slot_id: "10:00",
      version: task.version + 1,
    }),
  ).toThrow();
  const rejected = create(store, a.owner, "reject");
  const quote = store.appointments.preview(a.owner, rejected.id, {
    slot_id: "10:00",
    version: rejected.version,
  });
  expect(
    store.appointments.decide(a.owner, rejected.id, {
      request_id: "reject",
      decision: "reject",
      version: quote.task.version,
      nonce: quote.nonce,
    }).state,
  ).toBe("REJECTED");
});
test("schema v4 upgrade preserves chat, source evidence, preferences and daily usage", () => {
  const { store, path, a } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(a.owner, thread.id, "saved", "Synthetic greeting");
  store.completeRun(a.owner, run.id, "Synthetic reply", {
    sources: [],
    searchedAt: "2026-10-29T00:00:00Z",
    searchCalls: 0,
  });
  store.saveMemory(a.owner, "Synthetic preference", true);
  store.close();
  const db = new Database(path);
  db.exec(
    "DROP TABLE IF EXISTS demo_decisions; DROP TABLE IF EXISTS demo_bookings; DROP TABLE IF EXISTS demo_audit; DROP TABLE IF EXISTS demo_tasks; DROP TABLE stt_hold_roles; DROP TABLE stt_budget_holds; UPDATE version SET value=4",
  );
  db.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.thread(a.owner, thread.id).messages).toHaveLength(2);
  expect(reopened.memories(a.owner)).toHaveLength(1);
  expect(reopened.evidence(a.owner, run.id)?.searchCalls).toBe(0);
  expect(reopened.appointments.list(a.owner)).toEqual([]);
  const check = new Database(path);
  expect(
    check
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  check.close();
});
