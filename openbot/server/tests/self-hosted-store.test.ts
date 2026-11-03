import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SelfHostedStore } from "../src/self-hosted/store";

const stores: SelfHostedStore[] = [];
const folders: string[] = [];
test("v3 upgrade preserves owned replies, sources, usage and duplicate identity across reopen", () => {
  const { store, a, b, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const old = store.beginRun(a.owner, thread.id, "old", "Synthetic old reply");
  store.completeRun(a.owner, old.id, "Old answer");
  store.close();
  const db = new Database(path);
  db.exec(
    "DROP TABLE IF EXISTS run_evidence; DROP TABLE stt_budget_holds; UPDATE version SET value=3",
  );
  db.close();
  const migrated = new SelfHostedStore(path);
  stores.push(migrated);
  expect(migrated.thread(a.owner, thread.id).messages).toHaveLength(2);
  const run = migrated.beginRun(
    a.owner,
    thread.id,
    "new",
    "Synthetic forecast",
  );
  const evidence = {
    sources: [
      { title: "Synthetic IMD", url: "https://mausam.imd.gov.in/chennai/" },
    ],
    searchedAt: "2026-10-29T01:00:00Z",
    searchCalls: 1,
  };
  migrated.completeRun(a.owner, run.id, "Synthetic cited reply", evidence);
  expect(() => migrated.evidence(b.owner, run.id)).toThrow("not found");
  migrated.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.thread(a.owner, thread.id).messages.at(-1)?.evidence).toEqual(
    evidence,
  );
  expect(reopened.evidence(a.owner, run.id)).toEqual(evidence);
  expect(
    reopened.beginRun(a.owner, thread.id, "new", "Synthetic forecast").id,
  ).toBe(run.id);
  const verify = new Database(path);
  expect(
    verify
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(2);
  verify.close();
  reopened.deleteThread(a.owner, thread.id);
  const deleted = new Database(path);
  expect(
    deleted
      .query<{ n: number }, []>("SELECT count(*) n FROM run_evidence")
      .get()?.n,
  ).toBe(0);
  deleted.close();
});
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-storage-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  const store = new SelfHostedStore(path);
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession();
  return { store, a, b, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-")
    )
      throw new Error(
        "Refuse cleanup outside the named test temporary directories.",
      );
    rmSync(folder, { recursive: true, force: true });
  }
});

test("owned threads and reviewed memories survive a real database reopen", () => {
  const { store, a, b, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "message-1",
    "Synthetic hello",
  );
  store.completeRun(a.owner, run.id, "Synthetic answer");
  store.saveMemory(a.owner, "Use Tamil replies", true);
  expect(store.listThreads(b.owner)).toEqual([]);
  expect(() => store.thread(b.owner, thread.id)).toThrow("not found");
  expect(() => store.deleteThread(b.owner, thread.id)).toThrow("not found");
  expect(store.memories(b.owner)).toEqual([]);
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(
    reopened.thread(a.owner, thread.id).messages.map((m) => m.content),
  ).toEqual(["Synthetic hello", "Synthetic answer"]);
  expect(reopened.memories(a.owner)[0].content).toBe("Use Tamil replies");
  expect(reopened.session(a.token)?.owner).toBe(a.owner);
});

test("duplicate IDs do not create another run and pending work is not replayed", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(a.owner, thread.id, "message-1", "Hello");
  const duplicate = store.beginRun(a.owner, thread.id, "message-1", "Hello");
  expect(duplicate.id).toBe(run.id);
  expect(duplicate.fresh).toBe(false);
  expect(() =>
    store.beginRun(a.owner, thread.id, "message-1", "Changed"),
  ).toThrow("conflicts");
  expect(() =>
    store.beginRun(a.owner, thread.id, "message-2", "Second"),
  ).toThrow("running");
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(
    reopened.beginRun(a.owner, thread.id, "message-1", "Hello").state,
  ).toBe("interrupted");
  expect(reopened.thread(a.owner, thread.id).messages).toHaveLength(1);
  expect(reopened.thread(a.owner, thread.id).lastRun?.state).toBe(
    "interrupted",
  );
});

test("a send reserves room for its reply after a failed run near the message limit", () => {
  const { store, a } = world();
  const thread = store.createThread(a.owner, "saathi");
  for (let i = 0; i < 49; i++) {
    const run = store.beginRun(
      a.owner,
      thread.id,
      `complete-${i}`,
      "Synthetic question",
    );
    store.completeRun(a.owner, run.id, "Synthetic answer");
  }
  const failed = store.beginRun(
    a.owner,
    thread.id,
    "failed-at-limit",
    "Synthetic failure",
  );
  store.failRun(a.owner, failed.id);
  expect(store.thread(a.owner, thread.id).messages).toHaveLength(99);
  expect(() =>
    store.beginRun(a.owner, thread.id, "over-limit", "One more"),
  ).toThrow("budget");
  expect(store.thread(a.owner, thread.id).messages).toHaveLength(99);
});

test("daily inference budgets survive restart/deletion and do not charge duplicates", () => {
  const { store, a, b, path } = world();
  store.close();
  let now = Date.UTC(2026, 9, 29);
  const options = { limits: { global: 2, owner: 1 }, now: () => now };
  const bounded = new SelfHostedStore(path, options);
  stores.push(bounded);
  const first = bounded.createThread(a.owner, "saathi");
  const run = bounded.beginRun(
    a.owner,
    first.id,
    "quota-one",
    "Synthetic question",
  );
  bounded.failRun(a.owner, run.id);
  expect(
    bounded.beginRun(a.owner, first.id, "quota-one", "Synthetic question")
      .fresh,
  ).toBe(false);
  expect(() =>
    bounded.beginRun(a.owner, first.id, "quota-two", "Another"),
  ).toThrow("allowance");
  bounded.deleteThread(a.owner, first.id);
  bounded.close();
  const resumed = new SelfHostedStore(path, options);
  stores.push(resumed);
  const second = resumed.createThread(a.owner, "saathi");
  expect(() =>
    resumed.beginRun(a.owner, second.id, "quota-three", "Another"),
  ).toThrow("allowance");
  const other = resumed.createThread(b.owner, "saathi");
  const otherRun = resumed.beginRun(
    b.owner,
    other.id,
    "quota-other",
    "Synthetic",
  );
  resumed.failRun(b.owner, otherRun.id);
  const c = resumed.createSession(),
    third = resumed.createThread(c.owner, "saathi");
  expect(() =>
    resumed.beginRun(c.owner, third.id, "quota-global", "Synthetic"),
  ).toThrow("allowance");
  now += 86400000;
  expect(
    resumed.beginRun(c.owner, third.id, "quota-next-day", "Synthetic").fresh,
  ).toBe(true);
});

test("memory needs explicit review, is scoped, and supports deletion", () => {
  const { store, a, b } = world();
  expect(() => store.saveMemory(a.owner, "Preference", false)).toThrow(
    "review",
  );
  const memory = store.saveMemory(a.owner, "Preference", true);
  expect(() => store.deleteMemory(b.owner, memory.id)).toThrow("not found");
  store.deleteMemory(a.owner, memory.id);
  expect(store.memories(a.owner)).toEqual([]);
});

test("selected model survives reopen and cannot change under the same request ID", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "model-choice",
    "Hello",
    "openrouter:synthetic:free",
  );
  store.completeRun(a.owner, run.id, "Synthetic reply");
  expect(() =>
    store.beginRun(
      a.owner,
      thread.id,
      "model-choice",
      "Hello",
      "meta:muse-spark-1.3",
    ),
  ).toThrow("conflicts");
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.run(a.owner, run.id).model).toBe("openrouter:synthetic:free");
  expect(reopened.thread(a.owner, thread.id).lastRun?.model).toBe(
    "openrouter:synthetic:free",
  );
});

test("v1 migration preserves historical messages and leaves their model unknown", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "old-client",
    "Historic synthetic message",
  );
  store.completeRun(a.owner, run.id, "Historic synthetic answer");
  store.close();
  const old = new Database(path);
  try {
    old.exec(
      "ALTER TABLE runs DROP COLUMN model; DROP TABLE stt_budget_holds; UPDATE version SET value=1 WHERE id=1",
    );
  } finally {
    old.close();
  }
  const upgraded = new SelfHostedStore(path);
  stores.push(upgraded);
  expect(upgraded.thread(a.owner, thread.id).messages).toHaveLength(2);
  expect(upgraded.run(a.owner, run.id).model).toBeNull();
  expect(
    upgraded.beginRun(
      a.owner,
      thread.id,
      "old-client",
      "Historic synthetic message",
    ).fresh,
  ).toBe(false);
});

test("a second server cannot interrupt or steal the first server's pending run", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(a.owner, thread.id, "pending", "Hello");
  expect(() => new SelfHostedStore(path)).toThrow("cannot be locked");
  expect(store.run(a.owner, run.id).state).toBe("running");
});

test("kernel lock releases after a killed process; pending work is recovered without replay", async () => {
  const folder = mkdtempSync(join(tmpdir(), "saathi-crash-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fixtures/self-hosted-crash.ts"),
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const line = await reader.read();
    reader.releaseLock();
    const ids = JSON.parse(new TextDecoder().decode(line.value));
    expect(() => new SelfHostedStore(path)).toThrow("cannot be locked");
    child.kill();
    await child.exited;
    const recovered = new SelfHostedStore(path);
    stores.push(recovered);
    expect(recovered.run(ids.owner, ids.run).state).toBe("interrupted");
    expect(
      recovered.beginRun(
        ids.owner,
        ids.thread,
        "pending",
        "Synthetic crash test",
      ).fresh,
    ).toBe(false);
    expect(recovered.thread(ids.owner, ids.thread).messages).toHaveLength(1);
  } finally {
    child.kill();
    await child.exited;
  }
}, 15000);
