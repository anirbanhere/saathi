import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import { PlanReads } from "../src/self-hosted/plan-reads";
import { LocalError, SelfHostedStore } from "../src/self-hosted/store";

test("corrupted cached observations fail closed without replay, usage release or rewriting", () => {
  const folder = mkdtempSync(join(tmpdir(), "saathi-read-cache-"));
  const path = join(folder, "state.sqlite");
  const now = () => Date.parse("2026-11-06T01:00:00Z");
  const store = new SelfHostedStore(path, { now });
  const db = new Database(path);
  try {
    const owner = store.createSession().owner;
    const task = store.plans.begin(
      owner,
      { request_id: "cache", goal: "Synthetic", locale: "en-IN" },
      selfHostedConfig({}).roles,
    );
    store.plans.complete(owner, task.id, {
      goal: task.input.goal,
      status: "ready",
      question: null,
      unavailable_reason: null,
      steps: [
        {
          id: "s1",
          description: "Synthetic",
          prerequisites: [],
          tool: "handoff.manual",
          risk: "DRAFT",
          approval_required: false,
          arguments: { instructions: "Synthetic guidance" },
          expected_output: "Draft",
          timeout_ms: 1000,
          compensation: "none",
        },
      ],
    });
    const original = store.planReads.run(owner, task.id);
    const snapshot = () =>
      JSON.stringify({
        usage: db.query("SELECT * FROM inference_usage").all(),
        events: db.query("SELECT * FROM plan_events").all(),
      });
    const before = snapshot();
    for (const change of [
      (r: typeof original) => {
        r.task = "foreign";
      },
      (r: typeof original) => {
        Reflect.set(r, "mode", "live");
      },
      (r: typeof original) => {
        Reflect.set(r.results[0].output, "verified", true);
      },
      (r: typeof original) => {
        Reflect.set(r.results[0], "tool", "mcp.pay");
      },
      (r: typeof original) => {
        r.results[0].status = "completed";
      },
      (r: typeof original) => {
        r.status = "completed";
      },
      (r: typeof original) => {
        r.results.push(r.results[0]);
      },
      (r: typeof original) => {
        Reflect.set(r, "grant", true);
      },
      (r: typeof original) => {
        Reflect.set(
          r.results[0].output,
          "instructions",
          "Different coherent guidance",
        );
      },
      (r: typeof original) => {
        r.results[0].step = "s2";
      },
      (r: typeof original) => {
        r.results[0].skipped = true;
        r.results[0].evidence_mode = "none";
        r.results[0].output = { reason: "Forged prerequisite failure" };
      },
      (r: typeof original) => {
        r.status = "retryable";
        r.results[0].status = "retryable";
        r.results[0].evidence_mode = "none";
        r.results[0].output = { reason: "Impossible unskipped manual failure" };
      },
    ]) {
      const altered = structuredClone(original);
      change(altered);
      const payload = JSON.stringify(altered);
      db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
        payload,
        task.id,
      );
      try {
        store.planReads.run(owner, task.id);
        throw new Error("Corrupt cache accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(LocalError);
        expect((error as LocalError).status).toBe(503);
      }
      expect(snapshot()).toBe(before);
      expect(
        db
          .query("SELECT payload FROM plan_read_runs WHERE task=?")
          .get(task.id),
      ).toEqual({ payload });
    }
    for (const payload of [
      "{invalid",
      " ".repeat(64001),
      JSON.stringify({ ...original, results: [] }),
    ]) {
      db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
        payload,
        task.id,
      );
      expect(() => store.planReads.run(owner, task.id)).toThrow(
        "Saved read evidence is unavailable",
      );
      expect(snapshot()).toBe(before);
    }
    db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
      JSON.stringify(original),
      task.id,
    );
    expect(store.planReads.run(owner, task.id)).toEqual(original);
    expect(snapshot()).toBe(before);
    db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
      Buffer.from(JSON.stringify(original)),
      task.id,
    );
    expect(() => store.planReads.run(owner, task.id)).toThrow(
      "Saved read evidence is unavailable",
    );
    db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
      JSON.stringify(original),
      task.id,
    );
    const dated = store.plans.begin(
      owner,
      {
        request_id: "mock-cache",
        goal: "Synthetic mock",
        locale: "en-IN",
        date: "2026-11-07",
      },
      selfHostedConfig({}).roles,
    );
    store.plans.complete(owner, dated.id, {
      goal: dated.input.goal,
      status: "ready",
      question: null,
      unavailable_reason: null,
      steps: [
        {
          id: "s1",
          description: "Mock",
          prerequisites: [],
          tool: "demo.clinic.options",
          risk: "READ",
          approval_required: false,
          arguments: { date: "2026-11-07" },
          expected_output: "Mock",
          timeout_ms: 1000,
          compensation: "none",
        },
      ],
    });
    let lookups = 0;
    const reads = new PlanReads(
      db,
      store.plans,
      {
        options(date) {
          lookups++;
          return store.appointments.options(date);
        },
      },
      now,
    );
    const mock = reads.run(owner, dated.id);
    expect(lookups).toBe(1);
    const retained = snapshot();
    for (const change of [
      (r: typeof mock) => {
        Reflect.set(r.results[0].output, "date", "2026-11-08");
      },
      (r: typeof mock) => {
        r.results.push({ ...r.results[0], step: "s2" });
      },
      (r: typeof mock) => {
        r.status = "requires_user_action";
        r.results[0] = {
          ...r.results[0],
          tool: "handoff.manual",
          status: "requires_user_action",
          evidence_mode: "draft",
          output: { instructions: "Different tool", verified: false },
        };
      },
    ]) {
      const changed = structuredClone(mock);
      change(changed);
      const payload = JSON.stringify(changed);
      db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
        payload,
        dated.id,
      );
      expect(() => reads.run(owner, dated.id)).toThrow(
        "Saved read evidence is unavailable",
      );
      expect(lookups).toBe(1);
      expect(snapshot()).toBe(retained);
    }
    db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
      JSON.stringify(mock),
      dated.id,
    );
    const savedInput = JSON.stringify(dated.input);
    db.query("UPDATE task_plans SET input=? WHERE id=?").run(
      JSON.stringify({ ...dated.input, goal: "x".repeat(64001) }),
      dated.id,
    );
    expect(() => reads.run(owner, dated.id)).toThrow(
      "Saved read evidence is unavailable",
    );
    expect(lookups).toBe(1);
    db.query("UPDATE task_plans SET input=? WHERE id=?").run(
      savedInput,
      dated.id,
    );
    expect(reads.run(owner, dated.id)).toEqual(mock);
    db.query("UPDATE plan_read_runs SET payload=? WHERE task=?").run(
      JSON.stringify({
        ...mock,
        results: [{ ...mock.results[0], evidence_mode: "live" }],
      }),
      dated.id,
    );
    expect(() => reads.run(owner, dated.id)).toThrow(
      "Saved read evidence is unavailable",
    );
    expect(lookups).toBe(1);
    expect(snapshot()).toBe(retained);
  } finally {
    db.close();
    store.close();
    removeFixture(folder);
  }
});

function removeFixture(folder: string) {
  if (
    dirname(resolve(folder)) !== resolve(tmpdir()) ||
    !basename(folder).startsWith("saathi-read-cache-")
  )
    throw new Error("Unsafe cleanup");
  rmSync(folder, { recursive: true, force: true });
}
