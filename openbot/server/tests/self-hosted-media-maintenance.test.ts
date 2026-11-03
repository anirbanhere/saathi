import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import {
  maintainMedia,
  parseMediaMaintenanceArgs,
} from "../src/self-hosted/media-maintenance";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { FixtureSttCoordinator } from "../src/self-hosted/stt-coordinator";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  checks: Database[] = [];
afterEach(() => {
  for (const db of checks.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of folders.splice(0)) {
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-maintenance-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "saathi-maintenance-"));
  folders.push(dir);
  return dir;
}
function inspect(path: string) {
  const db = new Database(path);
  checks.push(db);
  return db;
}
async function world() {
  const dir = folder(),
    path = join(dir, "state.sqlite");
  let now = Date.now();
  const store = new SelfHostedStore(path, { now: () => now });
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession(),
    roles = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles;
  const input = (request_id: string) => ({
    request_id,
    audio: syntheticSpeechFixture("en-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
  });
  const expired = store.media.admit(a.owner, input("expired"));
  const done = store.sttAdmissions.begin(
    a.owner,
    { request_id: "done", media_id: expired.id, consent_revision: 1 },
    roles.stt,
  );
  const runner = new FixtureSttCoordinator(store.sttAdmissions, () => roles, {
    now: () => now,
  });
  await runner.run(a.owner, done.id);
  runner.stop();
  await runner.drain();
  now += 300000;
  const live = store.media.admit(a.owner, input("live"));
  const held = store.sttAdmissions.begin(
    a.owner,
    { request_id: "held", media_id: live.id, consent_revision: 1 },
    roles.stt,
  );
  const thread = store.createThread(a.owner, "saathi");
  store.beginRun(a.owner, thread.id, "chat", "Synthetic pending chat");
  const plan = store.plans.begin(
    b.owner,
    { request_id: "plan", goal: "Synthetic pending plan", locale: "en-IN" },
    roles,
  );
  const db = inspect(path);
  now = expired.expiresAt;
  return {
    dir,
    path,
    store,
    db,
    a,
    b,
    expired,
    live,
    done,
    held,
    plan,
    now: () => now,
    close: () => store.close(),
  };
}
const tables = [
  "owners",
  "sessions",
  "threads",
  "messages",
  "runs",
  "memories",
  "task_plans",
  "plan_events",
  "inference_usage",
  "stt_admission_usage",
  "demo_bookings",
];
function unrelated(db: Database) {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

test("maintenance arguments require an explicit absolute target and default to dry run", () => {
  const path = join(folder(), "state.sqlite");
  expect(parseMediaMaintenanceArgs(["--database", path])).toEqual({
    path,
    apply: false,
  });
  expect(parseMediaMaintenanceArgs(["--database", path, "--apply"])).toEqual({
    path,
    apply: true,
  });
  expect(parseMediaMaintenanceArgs(["--database", path, "--dry-run"])).toEqual({
    path,
    apply: false,
  });
  for (const args of [
    [],
    [path],
    ["--database", "relative.sqlite"],
    ["--database", path, "--apply", "--apply"],
    ["--database", path, "--owner", "fake"],
    ["--database", path, "--apply=true"],
  ])
    expect(() => parseMediaMaintenanceArgs(args)).toThrow();
});

test("maintenance refuses missing/malformed/older/newer/incomplete schema without creating or migrating targets", () => {
  const dir = folder(),
    missing = join(dir, "missing", "state.sqlite");
  expect(() => maintainMedia(missing)).toThrow();
  expect(existsSync(dirname(missing))).toBe(false);
  for (const [name, data] of [
    ["not-sqlite", "Synthetic invalid file"],
    ["empty", ""],
  ] as const) {
    const invalid = join(dir, name);
    writeFileSync(invalid, data);
    expect(() => maintainMedia(invalid, { apply: true })).toThrow();
    expect(readFileSync(invalid, "utf8")).toBe(data);
  }
  for (const version of [7, 13, 12, 11]) {
    const path = join(dir, `v${version}.sqlite`),
      db = inspect(path);
    db.exec(
      "CREATE TABLE version(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)",
    );
    db.query("INSERT INTO version VALUES(1,?)").run(version);
    const before = db.query("SELECT * FROM sqlite_schema ORDER BY name").all();
    expect(() => maintainMedia(path, { apply: true })).toThrow(
      "supported media schema",
    );
    expect(
      db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
    ).toBe(version);
    expect(db.query("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(
      before,
    );
  }
});

test("dry run reports expiry without startup recovery or lifecycle writes; apply clears only expired media and linked output", async () => {
  const w = await world();
  w.close();
  const before = unrelated(w.db),
    live = w.db.query("SELECT * FROM owned_media WHERE id=?").get(w.live.id),
    held = w.db.query("SELECT * FROM stt_admissions WHERE id=?").get(w.held.id);
  const allMedia = w.db.query("SELECT * FROM owned_media ORDER BY id").all(),
    allStt = w.db.query("SELECT * FROM stt_admissions ORDER BY id").all(),
    history = w.db
      .query("SELECT * FROM media_consent_events ORDER BY media,revision")
      .all();
  expect(maintainMedia(w.path, { now: w.now })).toEqual({
    mode: "dry_run",
    expiredClips: 1,
    expiredBytes: w.expired.byteLength,
    clearedClips: 0,
  });
  expect(unrelated(w.db)).toEqual(before);
  expect(w.db.query("SELECT * FROM owned_media ORDER BY id").all()).toEqual(
    allMedia,
  );
  expect(w.db.query("SELECT * FROM stt_admissions ORDER BY id").all()).toEqual(
    allStt,
  );
  expect(
    w.db
      .query("SELECT * FROM media_consent_events ORDER BY media,revision")
      .all(),
  ).toEqual(history);
  expect(maintainMedia(w.path, { apply: true, now: w.now })).toEqual({
    mode: "apply",
    expiredClips: 1,
    expiredBytes: w.expired.byteLength,
    clearedClips: 1,
  });
  expect(unrelated(w.db)).toEqual(before);
  expect(
    w.db.query("SELECT * FROM owned_media WHERE id=?").get(w.live.id),
  ).toEqual(live);
  expect(
    w.db.query("SELECT * FROM stt_admissions WHERE id=?").get(w.held.id),
  ).toEqual(held);
  expect(
    w.db
      .query<{ audio: Uint8Array | null; state: string }, [string]>(
        "SELECT audio,state FROM owned_media WHERE id=?",
      )
      .get(w.expired.id),
  ).toEqual({ audio: null, state: "expired" });
  expect(
    w.db
      .query<{ outcome: string | null }, [string]>(
        "SELECT outcome FROM stt_admissions WHERE id=?",
      )
      .get(w.done.id)?.outcome,
  ).toBeNull();
  expect(maintainMedia(w.path, { apply: true, now: w.now })).toEqual({
    mode: "apply",
    expiredClips: 0,
    expiredBytes: 0,
    clearedClips: 0,
  });
});

test("maintenance refuses a live application owner and aliases cannot bypass the shared kernel guard", async () => {
  const w = await world();
  expect(() => maintainMedia(w.path, { apply: true, now: w.now })).toThrow(
    "cannot be locked",
  );
  const target = join(w.dir, "real");
  mkdirSync(target);
  const targetPath = join(target, "state.sqlite"),
    holder = new SelfHostedStore(targetPath);
  stores.push(holder);
  const alias = join(w.dir, "alias");
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => maintainMedia(join(alias, "state.sqlite"))).toThrow(
    "cannot be locked",
  );
  expect(() => new SelfHostedStore(join(alias, "state.sqlite"))).toThrow(
    "cannot be locked",
  );
  holder.close();
  const throughAlias = new SelfHostedStore(join(alias, "state.sqlite"));
  stores.push(throughAlias);
  expect(() => maintainMedia(targetPath)).toThrow("cannot be locked");
});

test("hard-linked database targets are rejected rather than assigning unrelated sidecar ownership", async () => {
  const w = await world();
  w.close();
  const alias = join(w.dir, "hard.sqlite");
  linkSync(w.path, alias);
  expect(() => maintainMedia(alias, { apply: true, now: w.now })).toThrow();
  expect(() => maintainMedia(w.path, { apply: true, now: w.now })).toThrow();
  expect(() => new SelfHostedStore(alias)).toThrow();
});

test("the existing normal-path sidecar protocol blocks maintenance without requiring a new server binary", async () => {
  const w = await world();
  w.close();
  const legacyGuard = inspect(`${w.path}.lock.sqlite`);
  legacyGuard.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  expect(() => maintainMedia(w.path, { apply: true, now: w.now })).toThrow(
    "cannot be locked",
  );
  legacyGuard.exec("ROLLBACK");
  expect(maintainMedia(w.path, { now: w.now }).mode).toBe("dry_run");
});

// Windows directory junctions are covered above; file symlinks need extra OS privileges.
test.skipIf(process.platform === "win32")(
  "file symlink aliases acquire the canonical target guard in both directions",
  async () => {
    const w = await world();
    const alias = join(w.dir, "linked.sqlite");
    symlinkSync(w.path, alias, "file");
    expect(() => maintainMedia(alias)).toThrow("cannot be locked");
    w.close();
    const holder = new SelfHostedStore(alias);
    stores.push(holder);
    expect(() => maintainMedia(w.path)).toThrow("cannot be locked");
    expect(() => new SelfHostedStore(w.path)).toThrow("cannot be locked");
    holder.close();
    expect(maintainMedia(alias, { now: w.now }).mode).toBe("dry_run");
  },
);

test("expiry maintenance preserves a handed-out worker slot and budgets without startup interruption", () => {
  const path = join(folder(), "state.sqlite");
  let now = Date.now();
  const store = new SelfHostedStore(path, { now: () => now });
  stores.push(store);
  const owner = store.createSession().owner,
    role = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles.stt,
    media = store.media.admit(owner, {
      request_id: "claimed-clip",
      audio: syntheticSpeechFixture("en-IN").audio,
      mimeType: "audio/wav",
      consentToStore: true,
      consentToProcess: true,
    }),
    admission = store.sttAdmissions.begin(
      owner,
      {
        request_id: "claimed-work",
        media_id: media.id,
        consent_revision: 1,
      },
      role,
    ),
    claim = store.sttAdmissions.claim(owner, admission.id, role),
    db = inspect(path);
  expect(claim.fresh).toBe(true);
  const before = unrelated(db),
    saved = db
      .query<{ claim_hash: string }, [string]>(
        "SELECT claim_hash FROM stt_admissions WHERE id=?",
      )
      .get(admission.id);
  store.close();
  now = media.expiresAt;
  expect(
    maintainMedia(path, { apply: true, now: () => now }).clearedClips,
  ).toBe(1);
  expect(unrelated(db)).toEqual(before);
  expect(
    db
      .query(
        "SELECT state,pending,claim_hash,outcome FROM stt_admissions WHERE id=?",
      )
      .get(admission.id),
  ).toEqual({
    state: "expired",
    pending: 1,
    claim_hash: saved?.claim_hash,
    outcome: null,
  });
});

test("missing/replaced invalidation guards and unknown media triggers are rejected before cleanup", async () => {
  for (const mode of ["missing", "replaced", "extra"] as const) {
    const w = await world();
    w.close();
    if (mode !== "extra") w.db.exec("DROP TRIGGER media_invalidates_stt");
    if (mode === "replaced")
      w.db.exec(
        "CREATE TRIGGER media_invalidates_stt AFTER UPDATE ON owned_media BEGIN SELECT 1; END",
      );
    if (mode === "extra")
      w.db.exec(
        "CREATE TRIGGER extra_media AFTER UPDATE ON owned_media BEGIN SELECT 1; END",
      );
    const before = w.db.query("SELECT * FROM owned_media ORDER BY id").all();
    expect(() => maintainMedia(w.path, { apply: true, now: w.now })).toThrow(
      "supported media schema",
    );
    expect(w.db.query("SELECT * FROM owned_media ORDER BY id").all()).toEqual(
      before,
    );
    expect(
      w.db
        .query<{ outcome: string | null }, [string]>(
          "SELECT outcome FROM stt_admissions WHERE id=?",
        )
        .get(w.done.id)?.outcome,
    ).not.toBeNull();
  }
});

test("consent-history conflict rolls back purge and linked output invalidation without exposing raw SQLite errors", async () => {
  const w = await world();
  w.close();
  w.db
    .query(
      "INSERT INTO media_consent_events SELECT media,2,kind,at,storage_consent,processing_consent,state FROM media_consent_events WHERE media=? AND revision=1",
    )
    .run(w.expired.id);
  const before = w.db.query("SELECT * FROM owned_media ORDER BY id").all(),
    outcomes = w.db.query("SELECT * FROM stt_admissions ORDER BY id").all();
  expect(() => maintainMedia(w.path, { apply: true, now: w.now })).toThrow(
    "no cleanup was committed",
  );
  expect(w.db.query("SELECT * FROM owned_media ORDER BY id").all()).toEqual(
    before,
  );
  expect(w.db.query("SELECT * FROM stt_admissions ORDER BY id").all()).toEqual(
    outcomes,
  );
});

test("a version label and column names cannot authorize a history table with missing identity constraints", async () => {
  const w = await world();
  w.close();
  w.db.exec(
    "ALTER TABLE media_consent_events RENAME TO old_history; CREATE TABLE media_consent_events AS SELECT * FROM old_history; DROP TABLE old_history",
  );
  const before = w.db.query("SELECT * FROM owned_media ORDER BY id").all();
  expect(() => maintainMedia(w.path, { apply: true, now: w.now })).toThrow(
    "supported media schema",
  );
  expect(w.db.query("SELECT * FROM owned_media ORDER BY id").all()).toEqual(
    before,
  );
});

test("actual maintenance CLI is explicit, aggregate-only and never migrates a legacy file", async () => {
  const w = await world();
  w.close();
  w.db
    .query("UPDATE owned_media SET expires=created+1 WHERE id=?")
    .run(w.expired.id);
  const script = resolve(
    import.meta.dir,
    "../../../scripts/saathi-media-maintenance.ts",
  );
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", script, ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, out, error };
  };
  const dry = await run(["--database", w.path]);
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.out).mode).toBe("dry_run");
  expect(dry.out).not.toMatch(/owner|token|audio|sqlite/);
  const applied = await run(["--database", w.path, "--apply"]);
  expect(applied.code).toBe(0);
  expect(JSON.parse(applied.out).clearedClips).toBe(1);
  expect((await run([])).code).toBe(1);
  w.db.exec("UPDATE version SET value=7");
  const legacy = await run(["--database", w.path, "--apply"]);
  expect(legacy.code).toBe(1);
  expect(legacy.error).not.toContain(w.path);
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(7);
});
