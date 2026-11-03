import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import type { SttAdmissionLimits } from "../src/self-hosted/stt-admission";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  checks: Database[] = [];
const role = (provider = "fixture-a") =>
  selfHostedConfig({ SAATHI_STT_PROVIDER: provider }).roles.stt;
const inspect = (path: string) => {
  const db = new Database(path);
  checks.push(db);
  return db;
};
function world(sttLimits?: Partial<SttAdmissionLimits>) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-stt-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  let now = Date.now();
  const open = () => {
    const store = new SelfHostedStore(path, { now: () => now, sttLimits });
    stores.push(store);
    return store;
  };
  const store = open(),
    a = store.createSession(),
    b = store.createSession();
  const clip = (owner = a.owner, id = "clip", consentToProcess = true) =>
    store.media.admit(owner, {
      request_id: id,
      audio: syntheticSpeechFixture("en-IN").audio,
      mimeType: "audio/wav",
      consentToStore: true,
      consentToProcess,
      languageHint: "en-IN",
    });
  const media = clip();
  const input = (request_id = "request") => ({
    request_id,
    media_id: media.id,
    consent_revision: media.consentRevision,
  });
  return {
    store,
    path,
    open,
    a,
    b,
    clip,
    media,
    input,
    now: () => now,
    clock: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => {
  for (const db of checks.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-stt-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(folder, { recursive: true, force: true });
  }
});

test("STT admission pins fixture roles and exact duplicates preserve identity without another unit charge", () => {
  const w = world(),
    saved = w.store.sttAdmissions.begin(w.a.owner, w.input(), role());
  expect(saved.state).toBe("reserved");
  expect(saved.mode).toBe("fixture");
  expect(saved.durationMs).toBe(250);
  expect(saved.role.provider).toBe("fixture-a");
  expect(Object.isFrozen(saved.role.languages)).toBe(true);
  expect(
    w.store.sttAdmissions.begin(w.a.owner, w.input(), role("fixture-b")),
  ).toEqual(saved);
  expect(() =>
    w.store.sttAdmissions.begin(
      w.a.owner,
      { ...w.input(), consent_revision: 2 },
      role(),
    ),
  ).toThrow("conflicts");
  expect(() => w.store.sttAdmissions.get(w.b.owner, saved.id)).toThrow(
    "not found",
  );
  expect(() => w.store.sttAdmissions.cancel(w.b.owner, saved.id)).toThrow(
    "not found",
  );
  const db = inspect(w.path);
  expect(
    db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(1);
  expect(JSON.stringify(saved)).not.toContain('"audio"');
});

test("one reservation per owner, cancellation and exclusive startup recovery never replay or refund", () => {
  const w = world(),
    first = w.store.sttAdmissions.begin(w.a.owner, w.input(), role());
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input("other"), role()),
  ).toThrow("pending");
  const cancelled = w.store.sttAdmissions.cancel(w.a.owner, first.id);
  expect(cancelled.state).toBe("cancelled");
  expect(w.store.sttAdmissions.cancel(w.a.owner, first.id)).toEqual(cancelled);
  const pending = w.store.sttAdmissions.begin(
    w.a.owner,
    w.input("other"),
    role(),
  );
  w.store.close();
  const reopened = w.open();
  expect(reopened.sttAdmissions.get(w.a.owner, pending.id).state).toBe(
    "interrupted",
  );
  expect(
    reopened.sttAdmissions.begin(w.a.owner, w.input("other"), role("disabled"))
      .state,
  ).toBe("interrupted");
  expect(reopened.sttAdmissions.begin(w.a.owner, w.input(), role()).state).toBe(
    "cancelled",
  );
  expect(
    inspect(w.path)
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(2);
});

test("missing/stale consent, expired/foreign media and unreviewed/live roles cannot reserve units", () => {
  const w = world(),
    denied = w.clip(w.a.owner, "denied", false);
  expect(() =>
    w.store.sttAdmissions.begin(
      w.a.owner,
      { ...w.input(), media_id: denied.id },
      role(),
    ),
  ).toThrow("consent");
  expect(() =>
    w.store.sttAdmissions.begin(w.b.owner, w.input(), role()),
  ).toThrow("not found");
  const live = selfHostedConfig({
    SAATHI_STT_PROVIDER: "sarvam",
    SAATHI_STT_MODEL: "saaras:v4",
  }).roles.stt;
  expect(() => w.store.sttAdmissions.begin(w.a.owner, w.input(), live)).toThrow(
    "fixture",
  );
  expect(() =>
    w.store.sttAdmissions.begin(
      w.a.owner,
      { ...w.input(), provider: "sarvam" },
      role(),
    ),
  ).toThrow();
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input(), {
      ...role(),
      apiKey: "synthetic-private",
    } as never),
  ).toThrow();
  w.store.media.revokeProcessing(w.a.owner, w.media.id);
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input(), role()),
  ).toThrow("changed");
  w.clock(w.media.expiresAt);
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input(), role()),
  ).toThrow("unavailable");
  expect(
    inspect(w.path)
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(0);
});

test("owner/global attempt budgets survive cancellation and exact duplicates do not consume another slot", () => {
  const w = world({ ownerAttempts: 2, globalAttempts: 3 });
  for (const id of ["one", "two"]) {
    const row = w.store.sttAdmissions.begin(w.a.owner, w.input(id), role());
    w.store.sttAdmissions.cancel(w.a.owner, row.id);
  }
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input("three"), role()),
  ).toThrow("budget");
  const b = w.clip(w.b.owner),
    admitted = w.store.sttAdmissions.begin(
      w.b.owner,
      {
        request_id: "third",
        media_id: b.id,
        consent_revision: b.consentRevision,
      },
      role(),
    );
  w.store.sttAdmissions.cancel(w.b.owner, admitted.id);
  const c = w.store.createSession(),
    clip = w.clip(c.owner);
  expect(() =>
    w.store.sttAdmissions.begin(
      c.owner,
      {
        request_id: "fourth",
        media_id: clip.id,
        consent_revision: clip.consentRevision,
      },
      role(),
    ),
  ).toThrow("budget");
  expect(
    inspect(w.path)
      .query<{ n: number; ms: number }, []>(
        "SELECT count(*) n,sum(duration_ms) ms FROM stt_admission_usage",
      )
      .get(),
  ).toEqual({ n: 3, ms: 750 });
});

test("duration and lifetime budgets remain bounded independently of daily attempt counts", () => {
  for (const limits of [
    { ownerAudioMs: 499 },
    { globalAudioMs: 499 },
    { ownerRecords: 1 },
    { globalRecords: 1 },
  ]) {
    const w = world(limits),
      first = w.store.sttAdmissions.begin(w.a.owner, w.input(), role());
    w.store.sttAdmissions.cancel(w.a.owner, first.id);
    expect(() =>
      w.store.sttAdmissions.begin(w.a.owner, w.input("second"), role()),
    ).toThrow("budget");
  }
});

test("UTC rollover resets daily ceilings but preserves the durable admission ledger", () => {
  const w = world({ ownerAttempts: 1 }),
    first = w.store.sttAdmissions.begin(w.a.owner, w.input(), role());
  w.store.sttAdmissions.cancel(w.a.owner, first.id);
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input("same-day"), role()),
  ).toThrow("budget");
  const day = new Date(w.now());
  day.setUTCDate(day.getUTCDate() + 1);
  day.setUTCHours(0, 0, 0, 0);
  w.clock(day.getTime());
  const clip = w.clip(w.a.owner, "next-day");
  expect(
    w.store.sttAdmissions.begin(
      w.a.owner,
      {
        request_id: "next-day",
        media_id: clip.id,
        consent_revision: clip.consentRevision,
      },
      role(),
    ).state,
  ).toBe("reserved");
  expect(
    inspect(w.path)
      .query<{ n: number }, []>(
        "SELECT count(DISTINCT day) n FROM stt_admission_usage",
      )
      .get()?.n,
  ).toBe(2);
});

test("v9 upgrade preserves media consent/history, chat and inference usage without reserving STT", () => {
  const w = world(),
    thread = w.store.createThread(w.a.owner, "saathi");
  const run = w.store.beginRun(w.a.owner, thread.id, "chat", "Synthetic");
  w.store.completeRun(w.a.owner, run.id, "Saved");
  w.store.close();
  const fixture = inspect(w.path);
  fixture.exec(
    "DROP TABLE stt_admissions; DROP TABLE stt_admission_usage; DROP TABLE stt_budget_holds; UPDATE version SET value=9",
  );
  const reopened = w.open();
  expect(reopened.media.metadata(w.a.owner, w.media.id)).toEqual(w.media);
  expect(reopened.media.consentHistory(w.a.owner, w.media.id)).toHaveLength(1);
  expect(reopened.thread(w.a.owner, thread.id).messages).toHaveLength(2);
  expect(
    fixture
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  expect(
    fixture
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(0);
});

test("ledger failure rolls back the pending reservation and live-budget widening is refused", () => {
  const w = world(),
    db = inspect(w.path);
  db.exec(
    "CREATE TRIGGER synthetic_stt_usage_failure BEFORE INSERT ON stt_admission_usage BEGIN SELECT RAISE(ABORT,'Synthetic usage failure'); END",
  );
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input(), role()),
  ).toThrow();
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM stt_admissions").get()
      ?.n,
  ).toBe(0);
  expect(
    db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(0);
  db.exec("DROP TRIGGER synthetic_stt_usage_failure");
  expect(w.store.sttAdmissions.begin(w.a.owner, w.input(), role()).state).toBe(
    "reserved",
  );
  expect(() => world({ globalAttempts: 21 })).toThrow("budget");
});

test("separate processes serialize pending admission and exact duplicates with one durable unit charge", async () => {
  for (const duplicate of [false, true]) {
    const w = world(),
      children = ["a", "b"].map((suffix) =>
        Bun.spawn(
          [
            process.execPath,
            resolve(import.meta.dir, "fixtures/self-hosted-stt-contender.ts"),
            w.path,
            w.a.owner,
            w.media.id,
            duplicate ? "same" : suffix,
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        ),
      );
    try {
      await Promise.all(
        children.map(async (child) => {
          const reader = child.stdout.getReader(),
            first = await reader.read();
          reader.releaseLock();
          expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
        }),
      );
      for (const child of children) {
        child.stdin.write("go\n");
        child.stdin.end();
      }
      const results = await Promise.all(
        children.map(async (child) => {
          const reader = child.stdout.getReader(),
            decoder = new TextDecoder();
          let output = "";
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              output += decoder.decode(part.value, { stream: true });
            }
            output += decoder.decode();
          } finally {
            reader.releaseLock();
          }
          expect(await child.exited).toBe(0);
          return JSON.parse(output) as { status: string; id?: string };
        }),
      );
      expect(results.map((result) => result.status).sort()).toEqual(
        duplicate ? ["ok", "ok"] : ["blocked", "ok"],
      );
      if (duplicate) expect(results[0]?.id).toBe(results[1]?.id);
      expect(
        inspect(w.path)
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM stt_admission_usage",
          )
          .get()?.n,
      ).toBe(1);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }
}, 15000);
