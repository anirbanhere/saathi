import type { Database } from "bun:sqlite";
import { LocalError } from "./errors";

const unavailable = () =>
  new LocalError("Speech budget hold storage is unavailable.", 503);
const legacyTable = `CREATE TABLE IF NOT EXISTS stt_budget_holds(
 id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, request TEXT NOT NULL, media TEXT NOT NULL,
 consent_revision INTEGER NOT NULL CHECK(consent_revision>=1), content_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL REFERENCES stt_policy_catalogue(digest), effective_json TEXT NOT NULL CHECK(length(effective_json)<=8192), effective_hash TEXT NOT NULL,
 duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 100 AND 29000), byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 2097152),
 language TEXT NOT NULL CHECK(language IN('en-IN','hi-IN','ta-IN')), created INTEGER NOT NULL CHECK(created BETWEEN 0 AND 8640000000000000),
 cost_micros INTEGER NOT NULL CHECK(cost_micros BETWEEN 0 AND 9007199254740991), billable_ms INTEGER NOT NULL CHECK(billable_ms BETWEEN 0 AND 9007199254740991),
 balance_at INTEGER NOT NULL CHECK(balance_at BETWEEN 0 AND 8640000000000000), balance_available INTEGER NOT NULL CHECK(balance_available BETWEEN 0 AND 9007199254740991),
 UNIQUE(owner,request)
) STRICT;`;
const legacyDefinitions = [
  { name: "stt_budget_holds", type: "table", sql: legacyTable },
  ...["update", "delete"].map((op) => ({
    name: `stt_holds_no_${op}`,
    type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS stt_holds_no_${op} BEFORE ${op.toUpperCase()} ON stt_budget_holds BEGIN SELECT RAISE(ABORT,'Budget holds are immutable.'); END;`,
  })),
];
const normalize = (sql: string) =>
  sql
    .replace(/\bIF NOT EXISTS\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
function assertLegacySchema(db: Database) {
  try {
    for (const expected of legacyDefinitions) {
      const row = db
        .query<{ type: string; sql: string }, [string]>(
          "SELECT type,sql FROM sqlite_schema WHERE name=?",
        )
        .get(expected.name);
      if (
        !row ||
        row.type !== expected.type ||
        normalize(row.sql) !== normalize(expected.sql)
      )
        throw Error("Unsupported schema");
    }
    if (
      db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='stt_budget_holds'",
        )
        .get()?.n !== 2
    )
      throw Error("Unsupported guards");
  } catch {
    throw unavailable();
  }
}
/** Additive schema13 migration, called only within the store migration transaction. */
export function migrateSttBudgetHolds(db: Database) {
  try {
    for (const d of legacyDefinitions) db.exec(d.sql);
    assertLegacySchema(db);
  } catch {
    throw unavailable();
  }
}

export const sttHoldColumns = [
  "id",
  "owner",
  "request",
  "media",
  "consent_revision",
  "content_hash",
  "policy_hash",
  "effective_json",
  "effective_hash",
  "duration_ms",
  "byte_length",
  "language",
  "created",
  "cost_micros",
  "billable_ms",
  "balance_at",
  "balance_available",
] as const;
const table = legacyTable
  .replace(
    "CREATE TABLE IF NOT EXISTS stt_budget_holds(",
    'CREATE TABLE IF NOT EXISTS "stt_budget_holds"(',
  )
  .replace("owner TEXT NOT NULL UNIQUE", "owner TEXT NOT NULL")
  .replace(
    "UNIQUE(owner,request)",
    `state TEXT NOT NULL DEFAULT 'held' CHECK(state IN('held','cancelled_unissued')),
 cancelled_at INTEGER CHECK(cancelled_at BETWEEN 0 AND 8640000000000000),
 CHECK((state='held' AND cancelled_at IS NULL) OR (state='cancelled_unissued' AND cancelled_at IS NOT NULL AND cancelled_at>=created)),
 UNIQUE(owner,request)`,
  );
const definitions = [
  { name: "stt_budget_holds", type: "table", sql: table },
  {
    name: "stt_holds_pending_owner",
    type: "index",
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS stt_holds_pending_owner ON "stt_budget_holds"(owner) WHERE state='held'`,
  },
  {
    name: "stt_holds_no_delete",
    type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS stt_holds_no_delete BEFORE DELETE ON stt_budget_holds BEGIN SELECT RAISE(ABORT,'Budget holds are immutable.'); END;`,
  },
  {
    name: "stt_holds_no_update",
    type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS stt_holds_no_update BEFORE UPDATE ON stt_budget_holds
 WHEN NOT(OLD.state='held' AND NEW.state='cancelled_unissued' AND OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL AND NEW.cancelled_at>=OLD.created AND ${sttHoldColumns.map((k) => `NEW.${k} IS OLD.${k}`).join(" AND ")})
 BEGIN SELECT RAISE(ABORT,'Budget holds are immutable except for unissued cancellation.'); END;`,
  },
  {
    name: "stt_holds_initial",
    type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS stt_holds_initial BEFORE INSERT ON stt_budget_holds WHEN NEW.state!='held' OR NEW.cancelled_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'A budget hold must start held.'); END;`,
  },
];
function explicitIndices(db: Database) {
  return db
    .query<{ n: number }, []>(
      "SELECT count(*) n FROM sqlite_schema WHERE type='index' AND tbl_name='stt_budget_holds' AND sql IS NOT NULL",
    )
    .get()?.n;
}
export function assertSttHoldSchema(db: Database) {
  try {
    for (const expected of definitions) {
      const row = db
        .query<{ type: string; sql: string }, [string]>(
          "SELECT type,sql FROM sqlite_schema WHERE name=?",
        )
        .get(expected.name);
      if (
        !row ||
        row.type !== expected.type ||
        normalize(row.sql) !== normalize(expected.sql)
      )
        throw unavailable();
    }
    if (
      explicitIndices(db) !== 1 ||
      db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='stt_budget_holds'",
        )
        .get()?.n !== 3
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
}
/** Only the known unexecuted schema13 format is upgraded, inside the caller's immediate transaction. */
export function migrateSttHoldCancellation(db: Database) {
  try {
    assertLegacySchema(db);
    if (
      explicitIndices(db) !== 0 ||
      db
        .query(
          "SELECT name FROM sqlite_schema WHERE name='stt_budget_holds_next'",
        )
        .get()
    )
      throw unavailable();
    for (const entry of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table'",
      )
      .all()) {
      if (
        db
          .query(
            'SELECT 1 FROM pragma_foreign_key_list(?) WHERE "table"=? COLLATE NOCASE LIMIT 1',
          )
          .get(entry.name, "stt_budget_holds")
      )
        throw unavailable();
    }
    const count = db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_budget_holds")
      .get()?.n;
    if (count === undefined || count > 5000) throw unavailable();
    db.exec(table.replace('"stt_budget_holds"', '"stt_budget_holds_next"'));
    const columns = sttHoldColumns.join(",");
    db.exec(
      `INSERT INTO stt_budget_holds_next(${columns}) SELECT ${columns} FROM stt_budget_holds`,
    );
    if (
      db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM stt_budget_holds_next",
        )
        .get()?.n !== count
    )
      throw unavailable();
    db.exec(
      "DROP TABLE stt_budget_holds; ALTER TABLE stt_budget_holds_next RENAME TO stt_budget_holds",
    );
    for (const d of definitions) db.exec(d.sql);
    if (db.query("PRAGMA foreign_key_check(stt_budget_holds)").all().length)
      throw unavailable();
    assertSttHoldSchema(db);
  } catch {
    throw unavailable();
  }
}
