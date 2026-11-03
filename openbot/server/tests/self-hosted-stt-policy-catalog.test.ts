import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import { ownDatabase } from "../src/self-hosted/database-ownership";
import { LocalFixtureSpeechRuntime } from "../src/self-hosted/fixture-speech-runtime";
import { maintainMedia } from "../src/self-hosted/media-maintenance";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { sttPolicyCatalogueLimits } from "../src/self-hosted/stt-policy-catalog";
import fixture from "./fixtures/stt-policy-pin.json";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  readers: Database[] = [];
const profile = () => structuredClone(fixture.profile);
const scope = { provider: "sarvam", accountRef: "synthetic-account" };
function world(limits?: { global: number; account: number }) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-policy-catalog-"));
  folders.push(dir);
  const path = join(dir, "state.sqlite");
  let at = Date.now();
  const store = new SelfHostedStore(path, {
    now: () => at,
    sttPolicyLimits: limits,
  });
  stores.push(store);
  const db = new Database(path);
  readers.push(db);
  return {
    store,
    path,
    db,
    advance() {
      at += 1000;
    },
    setClock(value: number) {
      at = value;
    },
  };
}
afterEach(() => {
  for (const db of readers.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of folders.splice(0)) {
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-policy-catalog-")
    )
      throw Error("Unsafe test cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default policy metadata is durable, immutable and duplicate-safe without an execution grant", () => {
  const w = world();
  const one = w.store.sttPolicies.register(profile());
  w.advance();
  expect(
    w.store.sttPolicies.register({
      ...profile(),
      languages: ["hi-IN", "ta-IN", "en-IN"],
    }),
  ).toEqual(one);
  expect(Object.isFrozen(one)).toBe(true);
  expect(one.pin.contentSha256).toBe(fixture.sha256);
  expect(one).not.toHaveProperty("approved");
  expect(() =>
    w.db.query("UPDATE stt_policy_catalogue SET created=0").run(),
  ).toThrow("immutable");
  expect(() => w.db.query("DELETE FROM stt_policy_catalogue").run()).toThrow(
    "immutable",
  );
  w.store.close();
  const reopened = new SelfHostedStore(w.path);
  stores.push(reopened);
  expect(reopened.sttPolicies.get(scope, "policy-v1")).toEqual(one);
  expect(reopened.sttPolicies.register(profile())).toEqual(one);
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(15);
});

test("revision conflicts and provider-account boundaries preserve all stored content", () => {
  const w = world();
  const one = w.store.sttPolicies.register(profile());
  expect(() =>
    w.store.sttPolicies.register({
      ...profile(),
      price: { ...profile().price, rateMicros: 8 },
    }),
  ).toThrow("different content");
  expect(w.store.sttPolicies.get(scope, "policy-v1")).toEqual(one);
  expect(() =>
    w.store.sttPolicies.get({ ...scope, accountRef: "missing" }, "policy-v1"),
  ).toThrow("not found");
  const other = { ...profile(), accountRef: "other-account" };
  expect(w.store.sttPolicies.register(other).pin.profile.accountRef).toBe(
    "other-account",
  );
  const vendor = {
    ...profile(),
    price: { ...profile().price, provider: "elevenlabs" },
  };
  expect(w.store.sttPolicies.register(vendor).pin.profile.price.provider).toBe(
    "elevenlabs",
  );
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_policy_catalogue")
      .get()?.n,
  ).toBe(3);
});

test("lifetime bounds deny new rows atomically while duplicates and reads remain available", () => {
  const w = world({ global: 2, account: 1 });
  const one = w.store.sttPolicies.register(profile());
  expect(() =>
    w.store.sttPolicies.register({ ...profile(), revision: "policy-v2" }),
  ).toThrow("capacity");
  w.store.sttPolicies.register({ ...profile(), accountRef: "other-account" });
  expect(() =>
    w.store.sttPolicies.register({ ...profile(), accountRef: "third-account" }),
  ).toThrow("capacity");
  w.advance();
  expect(w.store.sttPolicies.register(profile())).toEqual(one);
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_policy_catalogue")
      .get()?.n,
  ).toBe(2);
});

test("disabled/unknown fields and forged rows deny without reflecting raw values or healing data", () => {
  const w = world();
  for (const p of [
    { ...profile(), enabled: false },
    { ...profile(), apiKey: "synthetic-secret" },
    { ...profile(), tightenedLimits: {} },
  ])
    expect(() => w.store.sttPolicies.register(p)).toThrow(
      "invalid or disabled",
    );
  expect(() =>
    w.store.sttPolicies.get({ ...scope, owner: "other" }, "policy-v1"),
  ).toThrow("Invalid policy");
  const one = w.store.sttPolicies.register(profile());
  // A raw SQL writer can add structurally valid but corrupt data; reads must not trust it.
  const p = { ...profile(), revision: "corrupt" };
  w.db
    .query(
      "INSERT INTO stt_policy_catalogue(provider,account_ref,revision,digest,format,canonical_json,created) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "sarvam",
      "synthetic-account",
      "corrupt",
      "0".repeat(64),
      one.pin.format,
      JSON.stringify({ profile: p }),
      1,
    );
  expect(() => w.store.sttPolicies.get(scope, "corrupt")).toThrow(
    "storage is unavailable",
  );
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_policy_catalogue")
      .get()?.n,
  ).toBe(2);
  expect(w.store.sttPolicies.get(scope, "policy-v1")).toEqual(one);
});

test("unexpected catalogue triggers deny before a write and closed storage errors stay sanitized", () => {
  const w = world();
  w.db.exec(
    "CREATE TRIGGER injected_policy AFTER INSERT ON stt_policy_catalogue BEGIN INSERT INTO owners VALUES('synthetic-injected'); END",
  );
  expect(() => w.store.sttPolicies.register(profile())).toThrow(
    "storage is unavailable",
  );
  expect(
    w.db.query("SELECT id FROM owners WHERE id='synthetic-injected'").get(),
  ).toBeNull();
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_policy_catalogue")
      .get()?.n,
  ).toBe(0);
  w.db.exec("DROP TRIGGER injected_policy");
  w.store.close();
  expect(() => w.store.sttPolicies.register(profile())).toThrow(
    "storage is unavailable",
  );
});

test("synthetic v11 migration preserves existing data and compatible maintenance never migrates", async () => {
  const w = world();
  const session = w.store.createSession();
  const thread = w.store.createThread(session.owner, "saathi");
  const run = w.store.beginRun(
    session.owner,
    thread.id,
    "synthetic-run",
    "Synthetic message",
  );
  w.store.completeRun(session.owner, run.id, "Synthetic answer");
  const media = w.store.media.admit(session.owner, {
    request_id: "synthetic-clip",
    audio: syntheticSpeechFixture("ta-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "ta-IN",
  });
  const roles = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles;
  const runtime = new LocalFixtureSpeechRuntime(w.store, () => roles);
  const speech = await runtime.run(session.owner, {
    request_id: "synthetic-speech",
    media_id: media.id,
    consent_revision: media.consentRevision,
  });
  runtime.stop();
  await runtime.drain();
  expect(speech.outcome?.status).toBe("completed");
  w.store.close();
  w.db.exec(
    "DROP TABLE stt_hold_roles; DROP TABLE stt_budget_holds; DROP TABLE stt_policy_catalogue; UPDATE version SET value=11",
  );
  maintainMedia(w.path, { now: Date.now });
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(11);
  expect(
    w.db
      .query("SELECT name FROM sqlite_schema WHERE name='stt_policy_catalogue'")
      .get(),
  ).toBeNull();
  const migrated = new SelfHostedStore(w.path);
  stores.push(migrated);
  expect(
    migrated.thread(session.owner, thread.id).messages.at(-1)?.content,
  ).toBe("Synthetic answer");
  expect(migrated.sttAdmissions.get(session.owner, speech.id).outcome).toEqual(
    speech.outcome,
  );
  expect(migrated.media.metadata(session.owner, media.id)).toEqual(media);
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(1);
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  const record = migrated.sttPolicies.register(profile());
  migrated.close();
  maintainMedia(w.path, { apply: true, now: Date.now });
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(15);
  const reopened = new SelfHostedStore(w.path);
  stores.push(reopened);
  expect(reopened.sttPolicies.get(scope, "policy-v1")).toEqual(record);
});

test("failed additive catalogue migration rolls back version/data and releases the kernel guard", () => {
  const w = world();
  w.store.close();
  w.db.exec(
    "DROP TABLE stt_hold_roles; DROP TABLE stt_budget_holds; DROP TABLE stt_policy_catalogue; UPDATE version SET value=11; CREATE VIEW stt_policy_catalogue AS SELECT 1 AS unsupported",
  );
  expect(() => new SelfHostedStore(w.path)).toThrow("storage is unavailable");
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(11);
  const release = ownDatabase(w.path);
  release();
  w.db.exec("DROP VIEW stt_policy_catalogue");
  const reopened = new SelfHostedStore(w.path);
  stores.push(reopened);
  expect(reopened.sttPolicies.register(profile()).pin.contentSha256).toBe(
    fixture.sha256,
  );
});

test("optional undefined limits retain hard defaults and unsafe overrides deny before creating a profile", () => {
  expect(sttPolicyCatalogueLimits({ global: undefined, account: 1 })).toEqual({
    global: 1000,
    account: 1,
  });
  for (const limits of [
    null,
    { global: 1001 },
    { account: 101 },
    { account: 0 },
    { global: NaN },
    { unknown: 1 },
  ])
    expect(() => sttPolicyCatalogueLimits(limits)).toThrow(
      "Invalid policy catalogue limits",
    );
});

test("invalid clocks roll back new records while original duplicates remain readable", () => {
  const w = world();
  const one = w.store.sttPolicies.register(profile());
  for (const clock of [NaN, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    w.setClock(clock);
    expect(() =>
      w.store.sttPolicies.register({ ...profile(), revision: "new" }),
    ).toThrow("storage is unavailable");
    expect(w.store.sttPolicies.register(profile())).toEqual(one);
  }
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_policy_catalogue")
      .get()?.n,
  ).toBe(1);
});
