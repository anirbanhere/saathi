import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import type { OwnedMedia } from "./media-store";
import { createSttBudgetPreview } from "./stt-budget";
import { estimateSttCost } from "./stt-cost";
import type { SttPolicyCatalogue } from "./stt-policy-catalog";
import { createSttPolicyPin } from "./stt-policy-pin";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const clock = integer.max(8640000000000000);
const ref = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z
  .object({
    provider: z.enum(["sarvam", "elevenlabs"]),
    accountRef: ref,
    currency: z.enum(["INR", "USD"]),
  })
  .strict();
export type SttBalanceReader = (
  scope: Readonly<z.infer<typeof scopeSchema>>,
) => unknown;
const balanceSchema = scopeSchema
  .extend({ observedAt: clock, availableMicros: integer })
  .strict();
const inputSchema = z
  .object({
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    media_id: z.uuid(),
    consent_revision: integer.min(1),
    policy: scopeSchema
      .omit({ currency: true })
      .extend({ revision: ref })
      .strict(),
    tightenedLimits: z.unknown().optional(),
  })
  .strict();
const rowSchema = z
  .object({
    id: z.uuid(),
    owner: ref,
    request: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    media: z.uuid(),
    consent_revision: integer.min(1),
    content_hash: digest,
    policy_hash: digest,
    effective_json: z.string().max(8192),
    effective_hash: digest,
    duration_ms: integer.min(100).max(29000),
    byte_length: integer.min(1).max(2097152),
    language: z.enum(["en-IN", "hi-IN", "ta-IN"]),
    created: clock,
    cost_micros: integer,
    billable_ms: integer,
    balance_at: clock,
    balance_available: integer,
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
const unavailable = () =>
  new LocalError("Speech budget hold storage is unavailable.", 503);
const table = `CREATE TABLE IF NOT EXISTS stt_budget_holds(
 id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, request TEXT NOT NULL, media TEXT NOT NULL,
 consent_revision INTEGER NOT NULL CHECK(consent_revision>=1), content_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL REFERENCES stt_policy_catalogue(digest), effective_json TEXT NOT NULL CHECK(length(effective_json)<=8192), effective_hash TEXT NOT NULL,
 duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 100 AND 29000), byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 2097152),
 language TEXT NOT NULL CHECK(language IN('en-IN','hi-IN','ta-IN')), created INTEGER NOT NULL CHECK(created BETWEEN 0 AND 8640000000000000),
 cost_micros INTEGER NOT NULL CHECK(cost_micros BETWEEN 0 AND 9007199254740991), billable_ms INTEGER NOT NULL CHECK(billable_ms BETWEEN 0 AND 9007199254740991),
 balance_at INTEGER NOT NULL CHECK(balance_at BETWEEN 0 AND 8640000000000000), balance_available INTEGER NOT NULL CHECK(balance_available BETWEEN 0 AND 9007199254740991),
 UNIQUE(owner,request)
) STRICT;`;
const definitions = [
  { name: "stt_budget_holds", type: "table", sql: table },
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
    for (const d of definitions) db.exec(d.sql);
    schema(db);
  } catch {
    throw unavailable();
  }
}

/** Internal unexecuted holds only. There is deliberately no claim, release, provider or HTTP interface. */
export class SttBudgetHolds {
  private working = false;
  constructor(
    private db: Database,
    private media: OwnedMedia,
    private policies: SttPolicyCatalogue,
    private now: () => number = Date.now,
    private reader?: SttBalanceReader,
  ) {
    schema(db);
  }
  private time() {
    try {
      return clock.parse(this.now());
    } catch {
      throw unavailable();
    }
  }
  private storage<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw unavailable();
    }
  }
  private session(owner: string, at: number) {
    if (
      !this.db
        .query("SELECT token FROM sessions WHERE owner=? AND expires>? LIMIT 1")
        .get(owner, at)
    )
      throw new LocalError(
        "Speech budget holds require an active owner session.",
        403,
      );
  }
  private validated(value: unknown) {
    try {
      const r = rowSchema.parse(value);
      const content: unknown = JSON.parse(r.effective_json);
      if (
        !content ||
        typeof content !== "object" ||
        !("profile" in content) ||
        !("effectiveLimits" in content)
      )
        throw unavailable();
      const pin = createSttPolicyPin(content.profile, content.effectiveLimits);
      if (
        pin.kind !== "policy_pin" ||
        pin.canonicalJson !== r.effective_json ||
        pin.contentSha256 !== r.effective_hash
      )
        throw unavailable();
      const p = pin.profile;
      const base = this.policies.get(
        { provider: p.price.provider, accountRef: p.accountRef },
        p.revision,
      ).pin;
      if (base.contentSha256 !== r.policy_hash) throw unavailable();
      const reconstructed = createSttPolicyPin(p);
      if (
        reconstructed.kind !== "policy_pin" ||
        reconstructed.canonicalJson !== base.canonicalJson
      )
        throw unavailable();
      const cost = estimateSttCost(
        p.price,
        { durationMs: r.duration_ms },
        {
          currency: p.price.currency,
          maxEstimateMicros: pin.effectiveLimits.requestCostMicros,
        },
        r.created,
      );
      if (
        cost.kind !== "estimate" ||
        cost.estimateMicros !== r.cost_micros ||
        cost.billableMs !== r.billable_ms ||
        r.duration_ms > p.maxDurationMs ||
        r.byte_length > p.maxBytes ||
        !p.languages.includes(r.language) ||
        r.balance_at > r.created ||
        r.created - r.balance_at >= p.maxSnapshotAgeMs ||
        r.balance_available < r.cost_micros
      )
        throw unavailable();
      return { r, pin };
    } catch {
      throw unavailable();
    }
  }
  private rows() {
    const raw = this.db
      .query("SELECT * FROM stt_budget_holds ORDER BY created,id LIMIT 5001")
      .all();
    if (raw.length > 5000) throw unavailable();
    return raw.map((row) => this.validated(row));
  }
  private view(row: Row) {
    const { pin } = this.validated(row);
    return Object.freeze({
      kind: "budget_hold" as const,
      id: row.id,
      request_id: row.request,
      state: "held" as const,
      created_at: row.created,
      currency: pin.profile.price.currency,
      estimateMicros: row.cost_micros,
      policyRevision: pin.profile.revision,
      executionAllowed: false as const,
    });
  }
  private duplicate(
    row: Row,
    request: z.infer<typeof inputSchema>,
    effectiveHash: string,
  ) {
    if (
      row.media !== request.media_id ||
      row.consent_revision !== request.consent_revision ||
      row.effective_hash !== effectiveHash
    )
      throw new LocalError(
        "Speech budget hold request already has different content.",
        409,
      );
    return this.view(row);
  }
  get(ownerInput: unknown, idInput: unknown) {
    let owner: string, id: string;
    try {
      owner = ref.parse(ownerInput);
      id = z.uuid().parse(idInput);
    } catch {
      throw new LocalError("Invalid speech budget hold reference.");
    }
    return this.storage(() => {
      schema(this.db);
      this.session(owner, this.time());
      const row = this.db
        .query("SELECT * FROM stt_budget_holds WHERE owner=? AND id=?")
        .get(owner, id);
      if (!row) throw new LocalError("Speech budget hold not found.", 404);
      return this.view(this.validated(row).r);
    });
  }
  reserve(ownerInput: unknown, input: unknown) {
    if (!this.reader)
      throw new LocalError(
        "Speech budget holds are disabled; no balance reader is connected.",
        503,
      );
    if (this.working)
      throw new LocalError(
        "Speech budget hold operation is already pending.",
        409,
      );
    let owner: string, request: z.infer<typeof inputSchema>;
    try {
      owner = ref.parse(ownerInput);
      request = inputSchema.parse(input);
    } catch {
      throw new LocalError("Invalid speech budget hold request.");
    }
    this.working = true;
    try {
      return this.storage(() => {
        schema(this.db);
        this.session(owner, this.time());
        const base = this.policies.get(
          {
            provider: request.policy.provider,
            accountRef: request.policy.accountRef,
          },
          request.policy.revision,
        ).pin;
        const pin = createSttPolicyPin(base.profile, request.tightenedLimits);
        if (pin.kind !== "policy_pin")
          throw new LocalError("Invalid speech budget hold limits.");
        const prior = this.db
          .query("SELECT * FROM stt_budget_holds WHERE owner=? AND request=?")
          .get(owner, request.request_id);
        const existing = prior ? this.validated(prior) : undefined;
        if (existing)
          return this.duplicate(existing.r, request, pin.contentSha256);
        this.media.checkProcessingConsent(
          owner,
          request.media_id,
          request.consent_revision,
        );
        const p = pin.profile,
          scope = Object.freeze({
            provider: p.price.provider,
            accountRef: p.accountRef,
            currency: p.price.currency,
          });
        let balance: z.infer<typeof balanceSchema>;
        try {
          const observation = this.reader?.(scope);
          if (observation instanceof Promise) {
            // Unsupported async cache readers must not leak a later raw rejection. No result is used.
            void observation.catch(() => {});
            throw Error("Synchronous balance observation required");
          }
          balance = balanceSchema.parse(observation);
        } catch {
          throw new LocalError(
            "Speech balance observation is unavailable.",
            503,
          );
        }
        return this.db
          .transaction(() => {
            schema(this.db);
            const rows = this.rows();
            this.session(owner, this.time());
            const committed = rows.find(
              ({ r }) => r.owner === owner && r.request === request.request_id,
            );
            if (committed)
              return this.duplicate(committed.r, request, pin.contentSha256);
            if (rows.some(({ r }) => r.owner === owner))
              throw new LocalError(
                "An owner speech budget hold is already pending.",
                409,
              );
            if (rows.length >= 5000)
              throw new LocalError("Speech budget hold capacity reached.", 429);
            const consent = this.media.checkProcessingConsent(
              owner,
              request.media_id,
              request.consent_revision,
            );
            this.media.readConsentedSnapshot(
              owner,
              request.media_id,
              request.consent_revision,
              consent.contentSha256,
            );
            const media = this.media.metadata(owner, request.media_id);
            // Bounded historical/WAV validation can take time: use a fresh decision clock.
            const at = this.time(),
              day = new Date(at).toISOString().slice(0, 10);
            this.session(owner, at);
            if (at >= consent.expiresAt)
              throw new LocalError("Stored media is unavailable.", 410);
            const account = rows.filter(
              ({ pin: saved }) =>
                saved.profile.price.provider === scope.provider &&
                saved.profile.accountRef === scope.accountRef,
            );
            const sameCurrency = account.filter(
              ({ pin: saved }) =>
                saved.profile.price.currency === scope.currency,
            );
            const sameDay = (r: Row) =>
              new Date(r.created).toISOString().slice(0, 10) === day;
            const sum = (values: number[]) => {
              const total = values.reduce((a, b) => a + BigInt(b), 0n);
              if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
              return Number(total);
            };
            const counters = (owned: boolean) => {
              const all = account.filter(
                  ({ r }) => !owned || r.owner === owner,
                ),
                today = all.filter(({ r }) => sameDay(r));
              return {
                attempts: today.length,
                audioMs: sum(today.map(({ r }) => r.duration_ms)),
                records: all.length,
                costMicros: sum(
                  sameCurrency
                    .filter(
                      ({ r }) => (!owned || r.owner === owner) && sameDay(r),
                    )
                    .map(({ r }) => r.cost_micros),
                ),
              };
            };
            const preview = createSttBudgetPreview(p, pin.effectiveLimits)(
              owner,
              {
                durationMs: media.durationMs,
                byteLength: media.byteLength,
                channels: media.channels,
                language: media.languageHint,
              },
              {
                ...scope,
                ownerRef: owner,
                policyRevision: p.revision,
                day,
                observedAt: at,
                ownerPending: false,
                owner: counters(true),
                global: counters(false),
              },
              {
                ...balance,
                outstandingMicros: sum(
                  sameCurrency.map(({ r }) => r.cost_micros),
                ),
              },
              at,
            );
            if (preview.kind !== "budget_preview")
              throw new LocalError(
                "Speech budget or balance does not permit a hold.",
                429,
              );
            const row: Row = {
              id: randomUUID(),
              owner,
              request: request.request_id,
              media: request.media_id,
              consent_revision: request.consent_revision,
              content_hash: consent.contentSha256,
              policy_hash: base.contentSha256,
              effective_json: pin.canonicalJson,
              effective_hash: pin.contentSha256,
              duration_ms: media.durationMs,
              byte_length: media.byteLength,
              language: rowSchema.shape.language.parse(media.languageHint),
              created: at,
              cost_micros: preview.estimateMicros,
              billable_ms: preview.billableMs,
              balance_at: balance.observedAt,
              balance_available: balance.availableMicros,
            };
            this.db
              .query(
                "INSERT INTO stt_budget_holds VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                row.id,
                row.owner,
                row.request,
                row.media,
                row.consent_revision,
                row.content_hash,
                row.policy_hash,
                row.effective_json,
                row.effective_hash,
                row.duration_ms,
                row.byte_length,
                row.language,
                row.created,
                row.cost_micros,
                row.billable_ms,
                row.balance_at,
                row.balance_available,
              );
            return this.view(row);
          })
          .immediate();
      });
    } finally {
      this.working = false;
    }
  }
}
