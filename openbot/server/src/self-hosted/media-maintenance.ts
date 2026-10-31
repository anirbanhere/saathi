import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ownDatabase } from "./database-ownership";
import { LocalError } from "./errors";
import { OwnedMedia } from "./media-store";
import { mediaInvalidationTriggerSql } from "./stt-execution-schema";

const usage =
  "Use --database ABSOLUTE_PATH and optional --dry-run or --apply. No default profile is selected.";
export function parseMediaMaintenanceArgs(args: string[]) {
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== "--database" ||
    !args[1] ||
    !isAbsolute(args[1]) ||
    (args[2] !== undefined && !["--apply", "--dry-run"].includes(args[2]))
  )
    throw new LocalError(usage);
  return { path: args[1], apply: args[2] === "--apply" };
}
const columns = {
  version: "id value",
  owned_media:
    "id owner request digest content_hash audio byte_length duration_ms sample_rate channels language storage_consent processing_consent state created expires removed consent_revision consent_changed_at",
  media_consent_events:
    "media revision kind at storage_consent processing_consent state",
  stt_admissions:
    "id owner request digest media consent_revision content_hash role duration_ms language_hint state created updated expires pending claim_hash claimed_at claim_deadline settlement_digest outcome settled_at failure_code",
};
const identities: Record<keyof typeof columns, string> = {
  version: "id",
  owned_media: "id",
  media_consent_events: "media revision",
  stt_admissions: "id",
};
const references: Record<keyof typeof columns, string[]> = {
  version: [],
  owned_media: ["owner:owners:id:CASCADE"],
  media_consent_events: ["media:owned_media:id:CASCADE"],
  stt_admissions: ["media:owned_media:id:CASCADE", "owner:owners:id:CASCADE"],
};
const schemaMessage =
  "Maintenance requires the current supported media schema; no migration is performed.";
const normalizedTrigger = (sql: string) =>
  sql
    .trim()
    .replace(/^CREATE TRIGGER IF NOT EXISTS /, "CREATE TRIGGER ")
    .replace(/;$/, "");
function validateSchema(db: Database) {
  try {
    const versions = db
      .query<{ id: number; value: number }, []>("SELECT id,value FROM version")
      .all();
    if (
      versions.length !== 1 ||
      versions[0]?.id !== 1 ||
      versions[0]?.value !== 11
    )
      throw new Error("Unsupported version");
    for (const table of Object.keys(columns) as (keyof typeof columns)[]) {
      const definition = db
        .query<{ type: string; sql: string }, [string]>(
          "SELECT type,sql FROM sqlite_schema WHERE name=?",
        )
        .get(table);
      if (
        definition?.type !== "table" ||
        !/^CREATE TABLE /i.test(definition.sql)
      )
        throw new Error("Unsupported table");
      const fields = db
          .query<{ name: string; pk: number }, [string]>(
            "SELECT name,pk FROM pragma_table_info(?)",
          )
          .all(table),
        actual = new Set(fields.map((row) => row.name));
      const required = columns[table];
      if (required.split(" ").some((name) => !actual.has(name)))
        throw new Error("Missing columns");
      if (
        fields
          .filter((row) => row.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((row) => row.name)
          .join(" ") !== identities[table]
      )
        throw new Error("Unsupported identity");
      const keys = db
        .query<
          { from: string; table: string; to: string; on_delete: string },
          [string]
        >(
          'SELECT "from","table","to",on_delete FROM pragma_foreign_key_list(?)',
        )
        .all(table)
        .map((row) => `${row.from}:${row.table}:${row.to}:${row.on_delete}`)
        .sort();
      if (JSON.stringify(keys) !== JSON.stringify(references[table]))
        throw new Error("Unsupported references");
    }
    const triggers = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN('owned_media','media_consent_events','stt_admissions')",
      )
      .all();
    if (
      triggers.length !== 1 ||
      triggers[0]?.name !== "media_invalidates_stt" ||
      normalizedTrigger(triggers[0].sql) !==
        normalizedTrigger(mediaInvalidationTriggerSql)
    )
      throw new Error("Unsupported invalidation guard");
  } catch {
    throw new LocalError(schemaMessage, 503);
  }
}

/** Explicit operator-only maintenance. No app construction, migrations or startup recovery. */
export function maintainMedia(
  path: string,
  options: { apply?: boolean; now?: () => number } = {},
) {
  if (
    !isAbsolute(path) ||
    (options.apply !== undefined && typeof options.apply !== "boolean")
  )
    throw new LocalError(usage);
  try {
    const info = statSync(path);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Unsupported target");
  } catch {
    throw new LocalError(
      "Choose an existing single-link database file; no target is created.",
    );
  }
  const release = ownDatabase(path);
  let db: Database | undefined;
  try {
    db = new Database(path, {
      readonly: options.apply !== true,
      create: false,
      strict: true,
    });
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL",
    );
    const connection = db;
    const action = connection.transaction(() => {
      validateSchema(connection);
      const now = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0)
        throw new LocalError("Invalid maintenance clock.");
      const count = connection
        .query<{ expiredClips: number; expiredBytes: number }, [number]>(
          "SELECT count(*) expiredClips,COALESCE(sum(length(audio)),0) expiredBytes FROM owned_media WHERE state='active' AND expires<=?",
        )
        .get(now);
      if (
        !count ||
        Object.values(count).some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        )
      )
        throw new Error("Invalid aggregate");
      const clearedClips =
        options.apply === true
          ? new OwnedMedia(connection, () => now).purgeExpired()
          : 0;
      if (options.apply && clearedClips !== count.expiredClips)
        throw new Error("Inconsistent cleanup count");
      return {
        mode:
          options.apply === true ? ("apply" as const) : ("dry_run" as const),
        ...count,
        clearedClips,
      };
    });
    return options.apply === true ? action.immediate() : action.deferred();
  } catch (error) {
    if (error instanceof LocalError) throw error;
    throw new LocalError(
      "Media maintenance failed; no cleanup was committed.",
      503,
    );
  } finally {
    try {
      db?.close();
    } finally {
      release();
    }
  }
}
