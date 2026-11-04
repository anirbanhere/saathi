import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SelfHostedStore } from "../src/self-hosted/store";

const folders: string[] = [],
  stores: SelfHostedStore[] = [];
const now = () => Date.parse("2026-10-29T01:00:00Z");
const fixture = join(import.meta.dir, "fixtures/schema7");
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-upgrade-")
    )
      throw new Error("Unsafe synthetic upgrade cleanup target");
    rmSync(folder, { recursive: true, force: true });
  }
});

function world() {
  const sql = readFileSync(join(fixture, "snapshot.sql"), "utf8");
  const metadata = JSON.parse(
    readFileSync(join(fixture, "provenance.json"), "utf8"),
  );
  expect(metadata.source).toBe("27de0986f21098a5173061000ba97a02ab01a3a5");
  expect(createHash("sha256").update(sql).digest("hex")).toBe(metadata.sha256);
  const folder = mkdtempSync(join(tmpdir(), "saathi-upgrade-"));
  folders.push(folder);
  const original = join(folder, "original.sqlite"),
    backup = join(folder, "backup.sqlite"),
    path = join(folder, "candidate.sqlite");
  const db = new Database(original);
  db.exec(sql);
  expect(db.query("SELECT value FROM version").get()).toEqual({ value: 7 });
  expect(db.query("PRAGMA integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
  copyFileSync(original, backup);
  copyFileSync(backup, path);
  return { original, backup, path, seed: metadata.seed };
}
function rows(path: string, table: string) {
  // Table names come only from the fixed test list, never external input.
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query(`SELECT * FROM ${table}`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
  } finally {
    db.close();
  }
}
test("authentic deployed schema7 upgrades only its copied synthetic database and preserves owned stable records", () => {
  const w = world();
  const store = new SelfHostedStore(w.path, { now });
  stores.push(store);
  expect(() => new SelfHostedStore(w.path, { now })).toThrow();
  for (const table of [
    "owners",
    "sessions",
    "threads",
    "messages",
    "memories",
    "inference_usage",
    "run_evidence",
    "demo_tasks",
    "demo_bookings",
    "demo_audit",
    "demo_decisions",
    "plan_read_runs",
  ]) {
    expect(rows(w.path, table)).toEqual(rows(w.backup, table));
  }
  expect(rows(w.path, "runs")).toEqual(
    rows(w.backup, "runs")
      .map((encoded) => {
        const row = JSON.parse(encoded);
        if (row.id === w.seed.pendingRun.id) row.state = "interrupted";
        return JSON.stringify(row);
      })
      .sort(),
  );
  expect(rows(w.path, "task_plans")).toEqual(
    rows(w.backup, "task_plans")
      .map((encoded) => {
        const row = JSON.parse(encoded);
        if (row.id === w.seed.pendingPlan.id) {
          row.state = "INTERRUPTED";
          row.pending = 0;
          row.updated = now();
        }
        return JSON.stringify(row);
      })
      .sort(),
  );
  expect(
    store.thread(w.seed.a.owner, w.seed.thread.id).messages.at(-1)?.evidence,
  ).toEqual(w.seed.evidence);
  expect(
    store.appointments.get(w.seed.a.owner, w.seed.booking.id).receipt,
  ).toEqual(w.seed.booking.receipt);
  expect(store.planReads.run(w.seed.a.owner, w.seed.plan.id)).toEqual(
    w.seed.read,
  );
  expect(() => store.thread(w.seed.b.owner, w.seed.thread.id)).toThrow(
    "not found",
  );
  expect(() =>
    store.appointments.get(w.seed.b.owner, w.seed.booking.id),
  ).toThrow("not found");
  expect(() => store.plans.get(w.seed.b.owner, w.seed.plan.id)).toThrow(
    "not found",
  );
  store.close();
  const reopened = new SelfHostedStore(w.path, { now });
  stores.push(reopened);
  expect(
    reopened.beginRun(
      w.seed.a.owner,
      w.seed.thread.id,
      "completed",
      "Synthetic cited question",
    ).id,
  ).toBe(w.seed.run.id);
  expect(
    reopened.appointments.decide(
      w.seed.a.owner,
      w.seed.booking.id,
      w.seed.approval,
    ),
  ).toEqual(w.seed.booking);
  expect(
    reopened.plans.begin(w.seed.a.owner, w.seed.plan.input, w.seed.roles).id,
  ).toBe(w.seed.plan.id);
  expect(reopened.planReads.run(w.seed.a.owner, w.seed.plan.id)).toEqual(
    w.seed.read,
  );
  const db = new Database(w.path, { readonly: true });
  expect(db.query("SELECT value FROM version").get()).toEqual({ value: 15 });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  for (const table of [
    "owned_media",
    "stt_policy_catalogue",
    "stt_budget_holds",
    "stt_hold_roles",
  ])
    expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  db.close();
  expect(readFileSync(w.original)).toEqual(readFileSync(w.backup));
  expect(rows(w.backup, "version")).toEqual([
    JSON.stringify({ id: 1, value: 7 }),
  ]);
});

test("authentic unfinished schema7 attempts recover once without replay or restoring quota", () => {
  const w = world();
  const before = rows(w.backup, "inference_usage");
  const store = new SelfHostedStore(w.path, { now });
  stores.push(store);
  expect(store.run(w.seed.a.owner, w.seed.pendingRun.id).state).toBe(
    "interrupted",
  );
  expect(store.plans.get(w.seed.b.owner, w.seed.pendingPlan.id).state).toBe(
    "INTERRUPTED",
  );
  expect(
    store.beginRun(
      w.seed.a.owner,
      w.seed.pendingThread.id,
      "pending",
      "Synthetic interrupted question",
    ).fresh,
  ).toBe(false);
  expect(
    store.plans.begin(w.seed.b.owner, w.seed.pendingPlan.input, w.seed.roles)
      .state,
  ).toBe("INTERRUPTED");
  const events = rows(w.path, "plan_events");
  expect(events.length).toBe(rows(w.backup, "plan_events").length + 1);
  expect(rows(w.path, "inference_usage")).toEqual(before);
  store.close();
  const reopened = new SelfHostedStore(w.path, { now });
  stores.push(reopened);
  expect(rows(w.path, "plan_events")).toEqual(events);
  expect(rows(w.path, "inference_usage")).toEqual(before);
  expect(rows(w.backup, "version")).toEqual([
    JSON.stringify({ id: 1, value: 7 }),
  ]);
});
