import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import { ControlReads } from "../src/self-hosted/control-reads";
import { SelfHostedStore } from "../src/self-hosted/store";

const stores: SelfHostedStore[] = [],
  dbs: Database[] = [],
  folders: string[] = [];
const roles = selfHostedConfig({}).roles;
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-controls-"));
  folders.push(folder);
  let now = Date.now();
  const path = join(folder, "state.sqlite"),
    store = new SelfHostedStore(path, { now: () => now });
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession(),
    db = new Database(path);
  dbs.push(db);
  return {
    store,
    a,
    b,
    db,
    path,
    now: () => now,
    clock: (at: number) => {
      now = at;
    },
  };
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const s of stores.splice(0)) s.close();
  for (const f of folders.splice(0)) {
    if (
      dirname(resolve(f)) !== resolve(tmpdir()) ||
      !basename(f).startsWith("saathi-controls-")
    )
      throw Error("Unsafe cleanup");
    rmSync(f, { recursive: true, force: true });
  }
});
const status = (id: string, kind = "demo_appointment", locale = "en-IN") => ({
  intent: "status",
  locale,
  target: { kind, id },
});
function appointment(store: SelfHostedStore, owner: string) {
  return store.appointments.create(owner, {
    request_id: "demo",
    date: new Date(
      Date.parse(`${store.appointments.options().min_date}T00:00:00Z`) +
        86400000,
    )
      .toISOString()
      .slice(0, 10),
    locale: "en-IN",
  });
}
function plan(store: SelfHostedStore, owner: string) {
  return store.plans.begin(
    owner,
    { request_id: "plan", goal: "Synthetic private goal", locale: "en-IN" },
    roles,
  );
}

test("help is localized, explicit and honest about unsupported actions without changing usage or storage", () => {
  const { store, a, db } = world();
  const before = db.query("PRAGMA data_version").get();
  const messages = [];
  for (const locale of ["en-IN", "hi-IN", "ta-IN"] as const) {
    const r = store.controls.read(
      a.owner,
      { intent: "help", locale },
      { planningConfigured: false },
    );
    expect(r.intent).toBe("help");
    expect(r.locale).toBe(locale);
    expect(r.action_executed).toBe(false);
    if (r.intent !== "help") throw Error("Wrong response");
    expect(r.capabilities.draft_planning_configured).toBe(false);
    expect(r.capabilities.live_speech).toBe(false);
    expect(r.capabilities.real_transactions).toBe(false);
    expect(r.supported_intents).toEqual(["help", "status"]);
    expect(r.message.length).toBeGreaterThan(30);
    messages.push(r.message);
  }
  expect(new Set(messages).size).toBe(3);
  expect(db.query("PRAGMA data_version").get()).toEqual(before);
  expect(db.query("SELECT count(*) n FROM inference_usage").get()).toEqual({
    n: 0,
  });
  const configured = store.controls.read(
    a.owner,
    { intent: "help", locale: "en-IN" },
    { planningConfigured: true },
  );
  if (configured.intent !== "help") throw Error("Wrong response");
  expect(configured.capabilities.draft_planning_configured).toBe(true);
});

test("expired mock approval is projected without materializing expiry, audit writes or nonce/quote leakage", () => {
  const { store, a, db, clock, now } = world(),
    task = appointment(store, a.owner);
  const preview = store.appointments.preview(a.owner, task.id, {
    slot_id: "10:00",
    version: task.version,
  });
  const expires = preview.task.expires_at;
  if (expires === null) throw Error("Missing expiry");
  clock(Math.max(now(), expires + 1));
  const before = db.query("PRAGMA data_version").get(),
    audit = db.query("SELECT count(*) n FROM demo_audit").get();
  const result = store.controls.read(a.owner, status(task.id));
  if (result.intent !== "status") throw Error("Wrong response");
  expect(result.status.stored_state).toBe("APPROVAL_PENDING");
  expect(result.status.code).toBe("approval_expired");
  expect(result.status.mode).toBe("mock");
  expect(result.action_executed).toBe(false);
  expect(
    db.query("SELECT state FROM demo_tasks WHERE id=?").get(task.id),
  ).toEqual({ state: "APPROVAL_PENDING" });
  expect(db.query("SELECT count(*) n FROM demo_audit").get()).toEqual(audit);
  expect(db.query("PRAGMA data_version").get()).toEqual(before);
  const text = JSON.stringify(result);
  for (const secret of [
    preview.nonce,
    a.owner,
    a.csrf,
    preview.task.preview?.hash ?? "not-present",
    "Synthetic private goal",
  ])
    expect(text).not.toContain(secret);
});

test("mock confirmation stays explicitly simulated and all persisted task states have localized read labels", () => {
  const { store, a, db, now } = world(),
    demo = appointment(store, a.owner),
    draft = plan(store, a.owner);
  for (const [state, code] of [
    ["AWAITING_SELECTION", "select_slot"],
    ["APPROVAL_PENDING", "review_approval"],
    ["COMPLETED", "mock_confirmed"],
    ["REJECTED", "rejected"],
    ["CANCELLED", "cancelled"],
    ["EXPIRED", "approval_expired"],
    ["UNAVAILABLE", "unavailable"],
  ] as const) {
    db.query("UPDATE demo_tasks SET state=?,expires=? WHERE id=?").run(
      state,
      now() + 60000,
      demo.id,
    );
    for (const locale of ["en-IN", "hi-IN", "ta-IN"] as const) {
      const r = store.controls.read(
        a.owner,
        status(demo.id, "demo_appointment", locale),
      );
      if (r.intent !== "status") throw Error("Wrong response");
      expect(r.status.code).toBe(code);
      expect(r.status.mode).toBe("mock");
      expect(r.message.length).toBeGreaterThan(5);
    }
  }
  for (const [state, code] of [
    ["PLANNING", "planning"],
    ["DRAFT_READY", "draft_ready"],
    ["NEEDS_CLARIFICATION", "needs_clarification"],
    ["UNAVAILABLE", "unavailable"],
    ["FAILED", "failed"],
    ["INTERRUPTED", "interrupted"],
    ["CANCELLED", "cancelled"],
  ] as const) {
    db.query("UPDATE task_plans SET state=?,pending=? WHERE id=?").run(
      state,
      state === "PLANNING" ? 1 : 0,
      draft.id,
    );
    const r = store.controls.read(
      a.owner,
      status(draft.id, "task_plan", "ta-IN"),
    );
    if (r.intent !== "status") throw Error("Wrong response");
    expect(r.status.code).toBe(code);
    expect(r.status.mode).toBe("draft_only");
  }
});

test("cancelled pending inference remains pending; status never replays or clears it, including after reopen", () => {
  const { store, a, db, path } = world(),
    task = plan(store, a.owner);
  store.plans.cancel(a.owner, task.id);
  const result = store.controls.read(a.owner, status(task.id, "task_plan"));
  if (result.intent !== "status") throw Error("Wrong response");
  expect(result.status.pending).toBe(true);
  expect(result.status.code).toBe("cancelled");
  expect(
    db.query("SELECT pending FROM task_plans WHERE id=?").get(task.id),
  ).toEqual({ pending: 1 });
  const usage = db.query("SELECT count(*) n FROM inference_usage").get();
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  const restored = reopened.controls.read(
    a.owner,
    status(task.id, "task_plan"),
  );
  if (restored.intent !== "status") throw Error("Wrong response");
  expect(restored.status.code).toBe("cancelled");
  expect(restored.status.pending).toBe(false);
  expect(db.query("SELECT count(*) n FROM inference_usage").get()).toEqual(
    usage,
  );
});

test("foreign/missing/invalid target, unsupported locale/intent and client capability fields are refused", () => {
  const { store, a, b, db } = world(),
    task = appointment(store, a.owner);
  expect(() => store.controls.read(b.owner, status(task.id))).toThrow(
    "not found",
  );
  expect(() => store.controls.read(a.owner, status(randomUUID()))).toThrow(
    "not found",
  );
  expect(() =>
    store.controls.read(a.owner, status(task.id, "task_plan")),
  ).toThrow("not found");
  for (const input of [
    { intent: "status", locale: "en-IN" },
    status("invalid"),
    { intent: "help", locale: "ml-IN" },
    { intent: "help", locale: "kn-IN" },
    {
      intent: "cancel",
      locale: "en-IN",
      target: { kind: "demo_appointment", id: task.id },
    },
    { intent: "help", locale: "en-IN", owner: b.owner },
    { intent: "help", locale: "en-IN", planningConfigured: true },
    { intent: "help", locale: "en-IN", model: "paid" },
  ])
    expect(() => store.controls.read(a.owner, input)).toThrow(
      "control-read fields",
    );
  db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(a.owner);
  expect(() =>
    store.controls.read(a.owner, { intent: "help", locale: "en-IN" }),
  ).toThrow("active owner session");
});

test("corrupt state metadata/storage errors deny with fixed messages and private task JSON is never projected", () => {
  for (const edit of [
    "UPDATE demo_tasks SET state='synthetic-private-bad'",
    "UPDATE demo_tasks SET state='APPROVAL_PENDING',expires=NULL",
    "UPDATE demo_tasks SET updated='synthetic-private-bad'",
  ]) {
    const { store, a, db } = world(),
      task = appointment(store, a.owner);
    db.exec(edit);
    expect(() => store.controls.read(a.owner, status(task.id))).toThrow(
      "Control status is unavailable.",
    );
  }
  const { store, a, db } = world(),
    task = plan(store, a.owner);
  db.query(
    "UPDATE task_plans SET state='DRAFT_READY',pending=1 WHERE id=?",
  ).run(task.id);
  expect(() =>
    store.controls.read(a.owner, status(task.id, "task_plan")),
  ).toThrow("Control status is unavailable.");
  db.exec(
    "DROP TABLE demo_audit; DROP TABLE demo_decisions; DROP TABLE demo_bookings; DROP TABLE demo_tasks",
  );
  expect(() => store.controls.read(a.owner, status(randomUUID()))).toThrow(
    "Control status is unavailable.",
  );
});

test("explicit HTTP reads keep auth/origin/CSRF/body/query guards and never invoke model or catalogue", async () => {
  const { store, a, b } = world(),
    task = appointment(store, a.owner);
  let calls = 0;
  const app = createSelfHostedApp({
    store,
    model: "synthetic",
    answer: async () => {
      calls++;
      return "Synthetic";
    },
    models: async () => {
      calls++;
      throw Error("No catalogue");
    },
  });
  const headers = {
    origin: "http://localhost:8790",
    "content-type": "application/json",
    cookie: `saathi_self_hosted=${a.token}`,
    "x-saathi-csrf": a.csrf,
  };
  const send = (
    body: unknown,
    changes: Record<string, string> = {},
    query = "",
  ) =>
    app.request(`http://localhost:8790/api/control-read${query}`, {
      method: "POST",
      headers: { ...headers, ...changes },
      body: JSON.stringify(body),
    });
  const help = { intent: "help", locale: "hi-IN" };
  expect((await send(help, { cookie: "" })).status).toBe(401);
  expect((await send(help, { "x-saathi-csrf": "wrong" })).status).toBe(403);
  expect(
    (await send(help, { origin: "https://synthetic.invalid" })).status,
  ).toBe(403);
  expect((await send(help, {}, `?owner=${b.owner}`)).status).toBe(422);
  expect((await send({ ...help, owner: b.owner })).status).toBe(422);
  const response = await send(help);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).locale).toBe("hi-IN");
  const result = await send(status(task.id));
  expect(result.status).toBe(200);
  expect((await result.json()).status.mode).toBe("mock");
  expect(calls).toBe(0);
});

test("status is minimal metadata, not raw content validation, and final session expiry denies delivery", () => {
  const { store, a, db } = world(),
    task = plan(store, a.owner);
  db.query(
    "UPDATE task_plans SET input='synthetic-private-input',roles='synthetic-private-roles',plan='synthetic-private-plan',state='DRAFT_READY',pending=0 WHERE id=?",
  ).run(task.id);
  const result = store.controls.read(a.owner, status(task.id, "task_plan"));
  if (result.intent !== "status") throw Error("Wrong response");
  expect(result.evidence_scope).toBe("stored_task_metadata");
  expect(result.status.code).toBe("draft_ready");
  expect(Object.keys(result.status).sort()).toEqual([
    "code",
    "mode",
    "pending",
    "stored_state",
    "updated_at",
  ]);
  expect(JSON.stringify(result)).not.toContain("synthetic-private");
  const expires = Date.now() + 10000;
  db.query("UPDATE sessions SET expires=? WHERE owner=?").run(expires, a.owner);
  let calls = 0;
  const reads = new ControlReads(db, () =>
    ++calls === 1 ? expires - 1 : expires + 1,
  );
  expect(() => reads.read(a.owner, status(task.id, "task_plan"))).toThrow(
    "active owner session",
  );
});
