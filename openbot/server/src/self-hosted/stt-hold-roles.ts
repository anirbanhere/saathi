import type { Database } from "bun:sqlite";
import { LocalError } from "./errors";
import type { SttPolicyPin } from "./stt-policy-pin";
import { createSttRoleBinding } from "./stt-role-binding";

export type SttRoleReader = (
  scope: Readonly<{
    ownerRef: string;
    provider: "sarvam" | "elevenlabs";
    accountRef: string;
    policyRevision: string;
  }>,
) => unknown;
const unavailable = () =>
  new LocalError("Stored speech role snapshot is unavailable.", 503);
const definitions = [
  {
    name: "stt_hold_roles",
    type: "table",
    sql: `CREATE TABLE IF NOT EXISTS stt_hold_roles(
 hold_id TEXT PRIMARY KEY REFERENCES stt_budget_holds(id), owner TEXT NOT NULL,
 canonical_json TEXT NOT NULL CHECK(length(canonical_json) BETWEEN 1 AND 16384),
 digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
 created INTEGER NOT NULL CHECK(created BETWEEN 0 AND 8640000000000000)
 ) STRICT;`,
  },
  ...["update", "delete"].map((op) => ({
    name: `stt_hold_roles_no_${op}`,
    type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS stt_hold_roles_no_${op} BEFORE ${op.toUpperCase()} ON stt_hold_roles BEGIN SELECT RAISE(ABORT,'Recorded speech roles are immutable.'); END;`,
  })),
];
const normalize = (sql: string) =>
  sql
    .replace(/\bIF NOT EXISTS\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
function schema(db: Database) {
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
      db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='stt_hold_roles'",
        )
        .get()?.n !== 2 ||
      db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM sqlite_schema WHERE type='index' AND tbl_name='stt_hold_roles' AND sql IS NOT NULL",
        )
        .get()?.n !== 0
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
}
/** Additive schema15 only, in the store transaction. Existing holds receive no role or authority. */
export function migrateSttHoldRoles(db: Database) {
  try {
    for (const d of definitions) db.exec(d.sql);
    schema(db);
  } catch {
    throw unavailable();
  }
}
/** Internal metadata storage, not role/account verification, a worker lease or a public binding API. */
export class SttHoldRoles {
  constructor(private db: Database) {
    schema(db);
  }
  status(
    owner: string,
    id: string,
    created: number,
    policy: SttPolicyPin,
  ): "recorded" | "unbound" {
    try {
      schema(this.db);
      const row = this.db
        .query<
          {
            owner: string;
            created: number;
            canonical_json: string;
            digest: string;
          },
          [string]
        >(
          "SELECT owner,created,canonical_json,digest FROM stt_hold_roles WHERE hold_id=?",
        )
        .get(id);
      if (!row) return "unbound";
      if (row.owner !== owner || row.created !== created) throw unavailable();
      const content: unknown = JSON.parse(row.canonical_json);
      const role =
        content && typeof content === "object" && "role" in content
          ? content.role
          : undefined;
      const binding = createSttRoleBinding(
        policy.profile,
        role,
        policy.effectiveLimits,
      );
      if (
        binding.kind !== "role_binding" ||
        binding.canonicalJson !== row.canonical_json ||
        binding.contentSha256 !== row.digest
      )
        throw unavailable();
      return "recorded";
    } catch {
      throw unavailable();
    }
  }
  assert() {
    schema(this.db);
  }
}
