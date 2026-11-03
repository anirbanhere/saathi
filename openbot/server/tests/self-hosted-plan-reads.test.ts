import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import type { TaskPlan } from "../src/self-hosted/plan-contract";
import { PlanReads } from "../src/self-hosted/plan-reads";
import { SelfHostedStore } from "../src/self-hosted/store";

const folders: string[] = [],
  stores: SelfHostedStore[] = [];
const roles = selfHostedConfig({}).roles;
const fixtureNow = () => Date.parse("2026-10-29T01:00:00Z");
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-reads-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  const store = new SelfHostedStore(path, {
    now: fixtureNow,
  });
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession();
  const task = store.plans.begin(
    a.owner,
    {
      request_id: "read-1",
      goal: "Find demo slots",
      locale: "en-IN",
      date: "2026-10-30",
    },
    roles,
  );
  const step: TaskPlan["steps"][number] = {
    id: "s1",
    description: "Look up mock slots",
    prerequisites: [],
    tool: "demo.clinic.options",
    risk: "READ",
    approval_required: false,
    arguments: { date: "2026-10-30" },
    expected_output: "Mock slots",
    timeout_ms: 1000,
    compensation: "none",
  };
  const plan: TaskPlan = {
    goal: task.input.goal,
    status: "ready",
    question: null,
    unavailable_reason: null,
    steps: [step],
  };
  return { store, path, a, b, task, plan, step };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-reads-")
    )
      throw new Error("Unsafe test cleanup target");
    rmSync(folder, { recursive: true, force: true });
  }
});
test("explicit native reads persist mock observations, replay the same result and survive restart without inference or booking", () => {
  const { store, path, a, b, task, plan } = world();
  store.plans.complete(a.owner, task.id, plan);
  expect(() => store.planReads.run(b.owner, task.id)).toThrow("not found");
  const read = store.planReads.run(a.owner, task.id);
  expect(read.mode).toBe("read_only");
  expect(read.status).toBe("completed");
  expect(read.results[0].status).toBe("completed");
  expect(read.results[0].evidence_mode).toBe("mock");
  expect(read.results[0].output).toMatchObject({
    date: task.input.date,
    mode: "mock",
  });
  expect(store.planReads.run(a.owner, task.id)).toEqual(read);
  expect(store.appointments.list(a.owner)).toEqual([]);
  store.close();
  const reopened = new SelfHostedStore(path, { now: fixtureNow });
  stores.push(reopened);
  expect(reopened.planReads.run(a.owner, task.id)).toEqual(read);
  expect(reopened.plans.get(a.owner, task.id).read_result).toEqual(read);
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(1);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM demo_bookings").get()
      ?.n,
  ).toBe(0);
  db.close();
});
test("non-ready/cancelled plans cannot start reads and manual prerequisites need user action", () => {
  const { store, a, task, plan, step } = world();
  expect(() => store.planReads.run(a.owner, task.id)).toThrow("ready");
  const manual: TaskPlan["steps"][number] = {
    ...step,
    tool: "handoff.manual",
    risk: "DRAFT",
    arguments: {
      instructions: "Unverified guidance; contact the provider manually.",
    },
  };
  store.plans.complete(a.owner, task.id, {
    ...plan,
    steps: [manual, { ...step, id: "s2", prerequisites: ["s1"] }],
  });
  const result = store.planReads.run(a.owner, task.id);
  expect(result.status).toBe("requires_user_action");
  expect(result.results.map((row) => row.status)).toEqual([
    "requires_user_action",
    "requires_user_action",
  ]);
  expect(result.results[1].skipped).toBe(true);
  const cancelled = store.plans.begin(
    a.owner,
    { ...task.input, request_id: "cancelled" },
    roles,
  );
  store.plans.complete(a.owner, cancelled.id, plan);
  store.plans.cancel(a.owner, cancelled.id);
  expect(() => store.planReads.run(a.owner, cancelled.id)).toThrow("ready");
  expect(store.appointments.list(a.owner)).toEqual([]);
});
test("read endpoint enforces ownership, CSRF and empty input; duplicate posts preserve evidence", async () => {
  const { store, a, b, task, plan } = world();
  store.plans.complete(a.owner, task.id, plan);
  const app = createSelfHostedApp({
    store,
    model: "openrouter/free",
    answer: async () => {
      throw new Error("No inference expected");
    },
  });
  const request = (body: unknown, session = a, csrf = session.csrf) =>
    app.request(`http://localhost/api/task-plans/${task.id}/run-readonly`, {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        cookie: `saathi_self_hosted=${session.token}`,
        "x-saathi-csrf": csrf,
      },
      body: JSON.stringify(body),
    });
  expect((await request({}, a, "wrong")).status).toBe(403);
  expect((await request({}, b)).status).toBe(404);
  expect((await request({ tool: "book.appointment" })).status).toBe(422);
  const first = await request({});
  expect(first.status).toBe(200);
  expect(await (await request({})).json()).toEqual(await first.json());
});
test("schema v6 migration preserves pinned plans and adds empty read records", () => {
  const { store, path, a, task, plan } = world();
  store.plans.complete(a.owner, task.id, plan);
  store.close();
  const db = new Database(path);
  try {
    db.exec(
      "DROP TABLE plan_read_runs; DROP TABLE stt_hold_roles; DROP TABLE stt_budget_holds; UPDATE version SET value=6",
    );
  } finally {
    db.close();
  }
  const reopened = new SelfHostedStore(path, { now: fixtureNow });
  stores.push(reopened);
  expect(reopened.plans.get(a.owner, task.id).roles).toEqual(roles);
  expect(reopened.plans.get(a.owner, task.id).plan).toEqual(plan);
  expect(reopened.plans.get(a.owner, task.id).read_result).toBeNull();
  expect(reopened.planReads.run(a.owner, task.id).status).toBe("completed");
});

test("invalid native evidence cannot claim live success, and cached results survive later cancellation", () => {
  const { store, path, a, task, plan } = world();
  store.plans.complete(a.owner, task.id, plan);
  const db = new Database(path);
  try {
    let calls = 0;
    const reads = new PlanReads(db, store.plans, {
      options: () => {
        calls++;
        return { mode: "live", reference: "forged-booking" };
      },
    });
    const result = reads.run(a.owner, task.id);
    expect(result.status).toBe("permanently_failed");
    expect(JSON.stringify(result)).not.toContain("forged-booking");
    store.plans.cancel(a.owner, task.id);
    expect(reads.run(a.owner, task.id)).toEqual(result);
    expect(calls).toBe(1);
  } finally {
    db.close();
  }
});

test("unexpected lookup failure rolls back the whole local batch and never saves partial evidence", () => {
  const { store, path, a, task, plan, step } = world();
  store.plans.complete(a.owner, task.id, {
    ...plan,
    steps: [step, { ...step, id: "s2" }],
  });
  const db = new Database(path);
  try {
    let calls = 0;
    const reads = new PlanReads(db, store.plans, {
      options: (date) => {
        if (++calls === 2)
          throw new Error("Synthetic unexpected lookup failure");
        return store.appointments.options(date);
      },
    });
    expect(() => reads.run(a.owner, task.id)).toThrow("Synthetic unexpected");
    expect(store.plans.get(a.owner, task.id).read_result).toBeNull();
    expect(
      store.plans
        .get(a.owner, task.id)
        .events.some((row) => row.event === "task.read_steps_saved"),
    ).toBe(false);
  } finally {
    db.close();
  }
});
