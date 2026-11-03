import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { MediaLimits } from "../src/self-hosted/media-store";
import { migrateMedia } from "../src/self-hosted/media-store";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  databases: Database[] = [];
const inspect = (path: string) => {
  const db = new Database(path);
  databases.push(db);
  return db;
};
const input = (request_id = "clip") => ({
  request_id,
  audio: syntheticSpeechFixture("en-IN").audio,
  mimeType: "audio/wav",
  consentToStore: true,
  consentToProcess: true,
  languageHint: "en-IN",
});
function world(mediaLimits?: Partial<MediaLimits>) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-media-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  let now = Date.now();
  const open = () => {
    const store = new SelfHostedStore(path, { now: () => now, mediaLimits });
    stores.push(store);
    return store;
  };
  const store = open();
  return {
    path,
    store,
    open,
    a: store.createSession(),
    b: store.createSession(),
    now: () => now,
    clock: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-media-")
    )
      throw new Error("Unsafe cleanup target");
    rmSync(folder, { recursive: true, force: true });
  }
});

test("media listing is owned metadata only, deterministic and retains effective expiry/tombstones", () => {
  const w = world();
  expect(w.store.media.list(w.a.owner)).toEqual([]);
  const a = w.store.media.admit(w.a.owner, input("first")),
    b = w.store.media.admit(w.a.owner, input("second"));
  expect(w.store.media.list(w.b.owner)).toEqual([]);
  const rows = w.store.media.list(w.a.owner);
  expect(rows.map((row) => row.id)).toEqual([a.id, b.id].sort().reverse());
  expect(rows.find((row) => row.id === a.id)).toEqual(a);
  expect(JSON.stringify(rows)).not.toMatch(
    /"audio"|"owner"|content_hash|"digest"/,
  );
  w.store.media.remove(w.a.owner, a.id);
  w.clock(b.expiresAt);
  const later = w.store.media.list(w.a.owner);
  expect(later.find((row) => row.id === a.id)?.state).toBe("deleted");
  expect(later.find((row) => row.id === b.id)?.state).toBe("expired");
  w.clock(w.now() + 86400001);
  expect(() => w.store.media.list(w.a.owner)).toThrow("active owner session");
});

test("media listing stays bounded even if retained legacy/operator rows exceed the configured record cap", () => {
  const w = world({ ownerRecords: 1 }),
    saved = w.store.media.admit(w.a.owner, input());
  const db = inspect(w.path);
  // Simulate an extra historical row rather than relaxing admission quotas.
  db.query(
    `INSERT INTO owned_media SELECT '00000000-0000-4000-8000-000000000000',owner,'old-extra',digest,content_hash,audio,byte_length,duration_ms,sample_rate,channels,language,storage_consent,processing_consent,state,created-1,expires,removed,consent_revision,consent_changed_at FROM owned_media WHERE id=?`,
  ).run(saved.id);
  expect(w.store.media.list(w.a.owner)).toEqual([saved]);
  expect(() => w.store.media.admit(w.a.owner, input("third"))).toThrow(
    "budget",
  );
});

test("owned media survives reopen; exact duplicates preserve identity/expiry and changed input conflicts", () => {
  const w = world(),
    request = input();
  const saved = w.store.media.admit(w.a.owner, request);
  expect(saved.state).toBe("active");
  expect(saved.byteLength).toBe(8044);
  expect(saved.consentToProcess).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('"audio"');
  expect(() => w.store.media.read(w.b.owner, saved.id)).toThrow("not found");
  expect(() => w.store.media.metadata(w.b.owner, saved.id)).toThrow(
    "not found",
  );
  expect(() => w.store.media.remove(w.b.owner, saved.id)).toThrow("not found");
  const first = w.store.media.read(w.a.owner, saved.id);
  first[0] = 0;
  expect(w.store.media.read(w.a.owner, saved.id)[0]).toBe(82);
  request.audio[0] = 0;
  expect(w.store.media.read(w.a.owner, saved.id)[0]).toBe(82);
  w.clock(w.now() + 1000);
  expect(w.store.media.admit(w.a.owner, input())).toEqual(saved);
  expect(() =>
    w.store.media.admit(w.a.owner, { ...input(), consentToProcess: false }),
  ).toThrow("conflicts");
  expect(() =>
    w.store.media.admit(w.a.owner, { ...input(), languageHint: "ta-IN" }),
  ).toThrow("conflicts");
  w.store.close();
  const reopened = w.open();
  expect(reopened.media.metadata(w.a.owner, saved.id)).toEqual(saved);
  expect(reopened.media.read(w.a.owner, saved.id)).toEqual(input().audio);
});

test("expiry denies new reads without silently reclaiming quota; explicit cleanup clears blobs and never revives duplicates", () => {
  const w = world({ ownerClips: 1 }),
    saved = w.store.media.admit(w.a.owner, input());
  w.clock(saved.expiresAt);
  expect(w.store.media.metadata(w.a.owner, saved.id).state).toBe("expired");
  expect(() => w.store.media.read(w.a.owner, saved.id)).toThrow("unavailable");
  expect(() => w.store.media.admit(w.a.owner, input("second"))).toThrow(
    "budget",
  );
  expect(w.store.media.purgeExpired()).toBe(1);
  expect(w.store.media.purgeExpired()).toBe(0);
  const old = w.store.media.admit(w.a.owner, input());
  expect(old.id).toBe(saved.id);
  expect(old.state).toBe("expired");
  expect(old.expiresAt).toBe(saved.expiresAt);
  expect(w.store.media.admit(w.a.owner, input("second")).state).toBe("active");
});

test("processing revocation is durable; deletion/storage revocation atomically clear active blobs and cannot be replayed into consent", () => {
  const w = world(),
    first = w.store.media.admit(w.a.owner, input());
  expect(
    w.store.media.revokeProcessing(w.a.owner, first.id).consentToProcess,
  ).toBe(false);
  expect(w.store.media.admit(w.a.owner, input()).consentToProcess).toBe(false);
  expect(w.store.media.read(w.a.owner, first.id)).toEqual(input().audio);
  const revoked = w.store.media.revoke(w.a.owner, first.id);
  expect(revoked.state).toBe("revoked");
  expect(w.store.media.consentHistory(w.a.owner, first.id).at(-1)?.kind).toBe(
    "storage_revoked",
  );
  expect(revoked.consentToStore).toBe(false);
  expect(w.store.media.remove(w.a.owner, first.id)).toEqual(revoked);
  expect(w.store.media.admit(w.a.owner, input()).state).toBe("revoked");
  expect(() => w.store.media.read(w.a.owner, first.id)).toThrow("unavailable");
  const second = w.store.media.admit(w.a.owner, input("second"));
  const deleted = w.store.media.remove(w.a.owner, second.id);
  expect(deleted.state).toBe("deleted");
  expect(w.store.media.remove(w.a.owner, second.id)).toEqual(deleted);
  const check = inspect(w.path);
  expect(
    check
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM owned_media WHERE audio IS NOT NULL",
      )
      .get()?.n,
  ).toBe(0);
  w.store.close();
  expect(w.open().media.admit(w.a.owner, input()).state).toBe("revoked");
});

test("owner/global bytes and lifetime tombstones remain bounded; invalid input creates no row", () => {
  const w = world({ ownerBytes: 8044, globalBytes: 16088, ownerRecords: 2 });
  const first = w.store.media.admit(w.a.owner, input());
  expect(() => w.store.media.admit(w.a.owner, input("second"))).toThrow(
    "budget",
  );
  w.store.media.admit(w.b.owner, input());
  const third = w.store.createSession();
  expect(() => w.store.media.admit(third.owner, input())).toThrow("budget");
  w.store.media.remove(w.a.owner, first.id);
  const second = w.store.media.admit(w.a.owner, input("second"));
  w.store.media.remove(w.a.owner, second.id);
  expect(() => w.store.media.admit(w.a.owner, input("third"))).toThrow(
    "budget",
  );
  expect(() =>
    w.store.media.admit(third.owner, { ...input(), consentToStore: false }),
  ).toThrow();
  const check = inspect(w.path);
  expect(
    check.query<{ n: number }, []>("SELECT count(*) n FROM owned_media").get()
      ?.n,
  ).toBe(3);
});

test("session expiry clamps retention and corrupt media is never returned", () => {
  const w = world(),
    check = inspect(w.path);
  check
    .query("UPDATE sessions SET expires=? WHERE owner=?")
    .run(w.now() + 1000, w.a.owner);
  const saved = w.store.media.admit(w.a.owner, input());
  expect(saved.expiresAt).toBe(w.now() + 1000);
  check
    .query("UPDATE owned_media SET audio=? WHERE id=?")
    .run(new Uint8Array(8044), saved.id);
  expect(() => w.store.media.read(w.a.owner, saved.id)).toThrow("unavailable");
  w.clock(saved.expiresAt);
  expect(() => w.store.media.admit(w.a.owner, input("later"))).toThrow(
    "session",
  );
});

test("v7 upgrade preserves owned chat/preferences/usage and an approved MOCK receipt", () => {
  const w = world(),
    thread = w.store.createThread(w.a.owner, "saathi");
  const run = w.store.beginRun(
    w.a.owner,
    thread.id,
    "synthetic-chat",
    "Synthetic hello",
  );
  w.store.completeRun(w.a.owner, run.id, "Synthetic reply");
  w.store.saveMemory(w.a.owner, "Synthetic reviewed preference", true);
  const date = new Date(w.now() + 86400000).toISOString().slice(0, 10);
  const task = w.store.appointments.create(w.a.owner, {
    request_id: "demo",
    date,
    locale: "en-IN",
  });
  const quote = w.store.appointments.preview(w.a.owner, task.id, {
    slot_id: "10:00",
    version: task.version,
  });
  const booking = w.store.appointments.decide(w.a.owner, task.id, {
    request_id: "approve",
    decision: "approve",
    version: quote.task.version,
    nonce: quote.nonce,
  });
  w.store.close();
  const fixture = inspect(w.path);
  fixture.exec("DROP TABLE owned_media; UPDATE version SET value=7 WHERE id=1");
  const migrated = w.open();
  expect(migrated.thread(w.a.owner, thread.id).messages).toHaveLength(2);
  expect(migrated.appointments.get(w.a.owner, task.id).receipt).toEqual(
    booking.receipt,
  );
  const check = inspect(w.path);
  expect(
    check.query<{ value: number }, []>("SELECT value FROM version").get()
      ?.value,
  ).toBe(13);
  expect(
    check.query<{ n: number }, []>("SELECT count(*) n FROM memories").get()?.n,
  ).toBe(1);
  expect(
    check
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  expect(migrated.media.admit(w.a.owner, input()).state).toBe("active");
});

test("lifetime global row limits survive deletion and invalid budgets cannot open the store", () => {
  const w = world({ globalRecords: 1 }),
    saved = w.store.media.admit(w.a.owner, input());
  w.store.media.remove(w.a.owner, saved.id);
  expect(() => w.store.media.admit(w.b.owner, input())).toThrow("budget");
  expect(w.store.media.admit(w.a.owner, input()).state).toBe("deleted");
  expect(() => world({ globalBytes: 100_000_001 })).toThrow("budget");
});

test("consent revisions/history are owned, idempotent and stale checks cannot authorize processing", () => {
  const w = world(),
    saved = w.store.media.admit(w.a.owner, input());
  expect(saved.consentRevision).toBe(1);
  expect(saved.consentChangedAt).toBe(w.now());
  const snapshot = w.store.media.checkProcessingConsent(w.a.owner, saved.id, 1);
  expect(snapshot.consentRevision).toBe(1);
  expect(JSON.stringify(snapshot)).not.toContain('"audio"');
  expect(() => w.store.media.consentHistory(w.b.owner, saved.id)).toThrow(
    "not found",
  );
  expect(() =>
    w.store.media.checkProcessingConsent(w.b.owner, saved.id, 1),
  ).toThrow("not found");
  const revoked = w.store.media.revokeProcessing(w.a.owner, saved.id);
  expect(revoked.consentRevision).toBe(2);
  expect(w.store.media.revokeProcessing(w.a.owner, saved.id)).toEqual(revoked);
  expect(() =>
    w.store.media.checkProcessingConsent(w.a.owner, saved.id, 1),
  ).toThrow("changed");
  expect(() =>
    w.store.media.checkProcessingConsent(w.a.owner, saved.id, 2),
  ).toThrow("consent");
  expect(w.store.media.admit(w.a.owner, input()).consentRevision).toBe(2);
  const removed = w.store.media.remove(w.a.owner, saved.id);
  expect(removed.consentRevision).toBe(3);
  expect(w.store.media.revoke(w.a.owner, saved.id)).toEqual(removed);
  expect(
    w.store.media
      .consentHistory(w.a.owner, saved.id)
      .map((event) => event.kind),
  ).toEqual(["stored", "processing_revoked", "deleted"]);
  w.store.close();
  expect(w.open().media.consentHistory(w.a.owner, saved.id)).toHaveLength(3);
});

test("current consent checks reject expiry and missing consent; cleanup records one terminal revision", () => {
  const w = world(),
    saved = w.store.media.admit(w.a.owner, input());
  const without = w.store.media.admit(w.a.owner, {
    ...input("without"),
    consentToProcess: false,
  });
  expect(() =>
    w.store.media.checkProcessingConsent(w.a.owner, without.id, 1),
  ).toThrow("consent");
  expect(() =>
    w.store.media.checkProcessingConsent(w.a.owner, saved.id, 0),
  ).toThrow("revision");
  w.clock(saved.expiresAt);
  expect(() =>
    w.store.media.checkProcessingConsent(w.a.owner, saved.id, 1),
  ).toThrow("unavailable");
  expect(w.store.media.purgeExpired()).toBe(2);
  expect(w.store.media.purgeExpired()).toBe(0);
  expect(w.store.media.metadata(w.a.owner, saved.id).consentRevision).toBe(2);
  expect(
    w.store.media
      .consentHistory(w.a.owner, saved.id)
      .map((event) => event.kind),
  ).toEqual(["stored", "expired"]);
});

test("v8 migration snapshots current consent honestly without inventing older grant/change history", () => {
  const w = world(),
    active = w.store.media.admit(w.a.owner, input());
  const removed = w.store.media.admit(w.a.owner, input("removed"));
  w.store.media.revoke(w.a.owner, removed.id);
  w.store.close();
  const fixture = inspect(w.path);
  const columns =
    "id,owner,request,digest,content_hash,audio,byte_length,duration_ms,sample_rate,channels,language,storage_consent,processing_consent,state,created,expires,removed";
  fixture.exec(
    `CREATE TEMP TABLE media_copy AS SELECT ${columns} FROM owned_media; DROP TABLE media_consent_events; DROP TABLE owned_media`,
  );
  migrateMedia(fixture);
  fixture.exec(
    `INSERT INTO owned_media SELECT ${columns} FROM media_copy; DROP TABLE media_copy; UPDATE version SET value=8`,
  );
  w.clock(w.now() + 1000);
  const migrated = w.open();
  const current = migrated.media.metadata(w.a.owner, active.id);
  expect(current.consentRevision).toBe(1);
  expect(current.consentChangedAt).toBeNull();
  expect(current.expiresAt).toBe(active.expiresAt);
  expect(migrated.media.read(w.a.owner, active.id)).toEqual(input().audio);
  const history = migrated.media.consentHistory(w.a.owner, active.id);
  expect(history).toHaveLength(1);
  expect(history[0]?.kind).toBe("migrated_snapshot");
  expect(history[0]?.at).toBe(w.now());
  expect(migrated.media.metadata(w.a.owner, removed.id).state).toBe("revoked");
  expect(
    migrated.media.revokeProcessing(w.a.owner, active.id).consentRevision,
  ).toBe(2);
});

test("consent/history failures roll back flag changes and explicit cleanup atomically", () => {
  const w = world(),
    saved = w.store.media.admit(w.a.owner, input()),
    blocked = w.store.media.admit(w.a.owner, input("blocked"));
  const check = inspect(w.path);
  check.exec(
    "CREATE TRIGGER synthetic_consent_failure BEFORE INSERT ON media_consent_events WHEN NEW.media=(SELECT id FROM owned_media WHERE request='blocked') BEGIN SELECT RAISE(ABORT,'Synthetic event failure'); END",
  );
  expect(() => w.store.media.revokeProcessing(w.a.owner, blocked.id)).toThrow();
  expect(w.store.media.metadata(w.a.owner, blocked.id).consentToProcess).toBe(
    true,
  );
  expect(w.store.media.metadata(w.a.owner, blocked.id).consentRevision).toBe(1);
  check.exec(
    "CREATE TRIGGER synthetic_initial_failure BEFORE INSERT ON media_consent_events WHEN NEW.kind='stored' BEGIN SELECT RAISE(ABORT,'Synthetic initial event failure'); END",
  );
  expect(() => w.store.media.admit(w.a.owner, input("refuse"))).toThrow();
  w.clock(saved.expiresAt);
  expect(() => w.store.media.purgeExpired()).toThrow();
  expect(
    check
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM owned_media WHERE audio IS NOT NULL",
      )
      .get()?.n,
  ).toBe(2);
  expect(w.store.media.consentHistory(w.a.owner, saved.id)).toHaveLength(1);
  expect(w.store.media.consentHistory(w.a.owner, blocked.id)).toHaveLength(1);
});

test("consented media snapshot binds exact revision/hash and returns detached bytes without an execution grant", () => {
  const w = world(),
    saved = w.store.media.admit(w.a.owner, input());
  const hash = createHash("sha256").update(input().audio).digest("hex");
  const snapshot = w.store.media.readConsentedSnapshot(
    w.a.owner,
    saved.id,
    saved.consentRevision,
    hash,
  );
  expect(snapshot.contentSha256).toBe(hash);
  expect(snapshot.consentRevision).toBe(1);
  expect(snapshot.audio).toEqual(input().audio);
  snapshot.audio[0] = 0;
  expect(
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 1, hash).audio[0],
  ).toBe(82);
  expect(() =>
    w.store.media.readConsentedSnapshot(w.b.owner, saved.id, 1, hash),
  ).toThrow("not found");
  expect(() =>
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 1, "0".repeat(64)),
  ).toThrow("changed");
  expect(() =>
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 1, "invalid"),
  ).toThrow("digest");
  w.store.media.revokeProcessing(w.a.owner, saved.id);
  expect(() =>
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 1, hash),
  ).toThrow("changed");
  expect(() =>
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 2, hash),
  ).toThrow("consent");
});

test("consented snapshots reject corrupt/expired bytes and create no STT reservation or provider work", () => {
  const w = world(),
    saved = w.store.media.admit(w.a.owner, input()),
    db = inspect(w.path);
  const hash = createHash("sha256").update(input().audio).digest("hex");
  db.query("UPDATE owned_media SET audio=? WHERE id=?").run(
    new Uint8Array(8044),
    saved.id,
  );
  expect(() =>
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 1, hash),
  ).toThrow("unavailable");
  w.clock(saved.expiresAt);
  expect(() =>
    w.store.media.readConsentedSnapshot(w.a.owner, saved.id, 1, hash),
  ).toThrow("unavailable");
  expect(
    db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(0);
});

test("separate processes serialize competing quota admissions and exact duplicates without duplicate blobs", async () => {
  for (const sameRequest of [false, true]) {
    const w = world(),
      children = ["a", "b"].map((suffix) =>
        Bun.spawn(
          [
            process.execPath,
            resolve(import.meta.dir, "fixtures/self-hosted-media-contender.ts"),
            w.path,
            w.a.owner,
            sameRequest ? "same" : `race-${suffix}`,
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
              const next = await reader.read();
              if (next.done) break;
              output += decoder.decode(next.value, { stream: true });
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
        sameRequest ? ["ok", "ok"] : ["ok", "quota"],
      );
      if (sameRequest) expect(results[0]?.id).toBe(results[1]?.id);
      const check = inspect(w.path);
      expect(
        check
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM owned_media WHERE audio IS NOT NULL",
          )
          .get()?.n,
      ).toBe(1);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }
}, 15000);
