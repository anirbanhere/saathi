import type { Database } from "bun:sqlite";
import { z } from "zod";
import { LocalError } from "./errors";
import { createSttPolicyPin, type SttPolicyPin } from "./stt-policy-pin";

const unavailable = () =>
  new LocalError("Policy catalogue storage is unavailable.", 503);
const tableSql = `CREATE TABLE IF NOT EXISTS stt_policy_catalogue(
  provider TEXT NOT NULL CHECK(provider IN('sarvam','elevenlabs')),
  account_ref TEXT NOT NULL CHECK(length(account_ref) BETWEEN 1 AND 100),
  revision TEXT NOT NULL CHECK(length(revision) BETWEEN 1 AND 100),
  digest TEXT NOT NULL UNIQUE CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  format TEXT NOT NULL CHECK(format='saathi-stt-policy-pin-v1'),
  canonical_json TEXT NOT NULL CHECK(length(canonical_json) BETWEEN 1 AND 8192),
  created INTEGER NOT NULL CHECK(created>=0 AND created<=9007199254740991),
  PRIMARY KEY(provider,account_ref,revision)
) STRICT;`;
const definitions = [
  { name: "stt_policy_catalogue", type: "table", sql: tableSql },
  ...["update", "delete"].map((operation) => ({
    name: `stt_policy_no_${operation}`,
    type: "trigger",
    sql: `CREATE TRIGGER IF NOT EXISTS stt_policy_no_${operation} BEFORE ${operation.toUpperCase()} ON stt_policy_catalogue
      BEGIN SELECT RAISE(ABORT,'Policy metadata is immutable.'); END;`,
  })),
];
const normalized = (sql: string) =>
  sql
    .replace(/\bIF NOT EXISTS\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
function assertSchema(db: Database) {
  try {
    for (const expected of definitions) {
      const found = db
        .query<{ type: string; sql: string }, [string]>(
          "SELECT type,sql FROM sqlite_schema WHERE name=?",
        )
        .get(expected.name);
      if (
        !found ||
        found.type !== expected.type ||
        normalized(found.sql) !== normalized(expected.sql)
      )
        throw Error("Unsupported catalogue schema");
    }
    const triggers = db
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND tbl_name='stt_policy_catalogue'",
      )
      .get();
    if (triggers?.n !== 2) throw Error("Unsupported catalogue guards");
  } catch {
    throw unavailable();
  }
}
/** Called only inside the store's additive migration transaction. */
export function migrateSttPolicyCatalogue(db: Database) {
  try {
    for (const definition of definitions) db.exec(definition.sql);
    assertSchema(db);
  } catch {
    throw unavailable();
  }
}
export type SttPolicyCatalogueLimits = { global: number; account: number };
const defaults: SttPolicyCatalogueLimits = { global: 1000, account: 100 };
export function sttPolicyCatalogueLimits(
  input?: unknown,
): Readonly<SttPolicyCatalogueLimits> {
  try {
    const result = z
      .object({
        global: z.number().int().min(1).max(defaults.global).optional(),
        account: z.number().int().min(1).max(defaults.account).optional(),
      })
      .strict()
      .parse(input === undefined ? {} : input);
    return Object.freeze({
      global: result.global ?? defaults.global,
      account: result.account ?? defaults.account,
    });
  } catch {
    throw new LocalError("Invalid policy catalogue limits.");
  }
}
const ref = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const referenceSchema = z
  .object({
    scope: z
      .object({ provider: z.enum(["sarvam", "elevenlabs"]), accountRef: ref })
      .strict(),
    revision: ref,
  })
  .strict();
type Scope = z.infer<typeof referenceSchema>["scope"];
type Row = {
  provider: string;
  account_ref: string;
  revision: string;
  digest: string;
  format: string;
  canonical_json: string;
  created: number;
};
type PolicyRecord = Readonly<{
  kind: "policy_record";
  pin: SttPolicyPin;
  createdAt: number;
}>;

/** Trusted internal metadata only; neither scope labels nor rows authenticate an account. */
export class SttPolicyCatalogue {
  private limits: Readonly<SttPolicyCatalogueLimits>;
  constructor(
    private db: Database,
    private now: () => number = Date.now,
    limits?: Partial<SttPolicyCatalogueLimits>,
  ) {
    this.limits = sttPolicyCatalogueLimits(limits);
    assertSchema(db);
  }
  private storage<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw unavailable();
    }
  }
  private row(scope: Scope, revision: string) {
    return this.db
      .query<Row, [string, string, string]>(
        "SELECT provider,account_ref,revision,digest,format,canonical_json,created FROM stt_policy_catalogue WHERE provider=? AND account_ref=? AND revision=?",
      )
      .get(scope.provider, scope.accountRef, revision);
  }
  private record(row: Row): PolicyRecord {
    if (!Number.isSafeInteger(row.created) || row.created < 0)
      throw unavailable();
    const content: unknown = JSON.parse(row.canonical_json);
    const pin = createSttPolicyPin(
      content && typeof content === "object" && "profile" in content
        ? content.profile
        : undefined,
    );
    if (
      pin.kind !== "policy_pin" ||
      pin.contentSha256 !== row.digest ||
      pin.canonicalJson !== row.canonical_json ||
      pin.format !== row.format ||
      pin.profile.price.provider !== row.provider ||
      pin.profile.accountRef !== row.account_ref ||
      pin.profile.revision !== row.revision
    )
      throw unavailable();
    return Object.freeze({
      kind: "policy_record",
      pin,
      createdAt: row.created,
    });
  }
  register(profile: unknown): PolicyRecord {
    const pin = createSttPolicyPin(profile);
    if (pin.kind !== "policy_pin")
      throw new LocalError("Policy metadata is invalid or disabled.");
    const scope = {
      provider: pin.profile.price.provider,
      accountRef: pin.profile.accountRef,
    };
    return this.storage(() =>
      this.db
        .transaction(() => {
          assertSchema(this.db);
          const prior = this.row(scope, pin.profile.revision);
          if (prior) {
            const saved = this.record(prior);
            if (
              saved.pin.contentSha256 !== pin.contentSha256 ||
              saved.pin.canonicalJson !== pin.canonicalJson
            )
              throw new LocalError(
                "Policy revision already has different content.",
                409,
              );
            return saved;
          }
          const count = this.db
            .query<{ total: number; account: number }, [string, string]>(
              "SELECT count(*) total,coalesce(sum(provider=? AND account_ref=?),0) account FROM stt_policy_catalogue",
            )
            .get(scope.provider, scope.accountRef);
          if (
            !count ||
            count.total >= this.limits.global ||
            count.account >= this.limits.account
          )
            throw new LocalError("Policy catalogue capacity reached.", 429);
          let at: number;
          try {
            at = this.now();
          } catch {
            throw unavailable();
          }
          if (!Number.isSafeInteger(at) || at < 0) throw unavailable();
          this.db
            .query(
              "INSERT INTO stt_policy_catalogue(provider,account_ref,revision,digest,format,canonical_json,created) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              scope.provider,
              scope.accountRef,
              pin.profile.revision,
              pin.contentSha256,
              pin.format,
              pin.canonicalJson,
              at,
            );
          const row = this.row(scope, pin.profile.revision);
          if (!row) throw unavailable();
          return this.record(row);
        })
        .immediate(),
    );
  }
  get(scopeInput: unknown, revisionInput: unknown): PolicyRecord {
    let reference: z.infer<typeof referenceSchema>;
    try {
      reference = referenceSchema.parse({
        scope: scopeInput,
        revision: revisionInput,
      });
    } catch {
      throw new LocalError("Invalid policy catalogue reference.");
    }
    return this.storage(() => {
      assertSchema(this.db);
      const row = this.row(reference.scope, reference.revision);
      if (!row) throw new LocalError("Policy metadata not found.", 404);
      return this.record(row);
    });
  }
}
