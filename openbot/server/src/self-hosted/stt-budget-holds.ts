import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import type { OwnedMedia } from "./media-store";
import {
  reviewSttAccountAccess,
  type SttAccessReviewer,
  sttAccessBlocked,
} from "./stt-access-review";
import { createSttBudgetPreview } from "./stt-budget";
import { estimateSttCost } from "./stt-cost";
import { SttHoldRoles, type SttRoleReader } from "./stt-hold-roles";
import {
  assertSttHoldSchema as schema,
  sttHoldColumns,
} from "./stt-hold-schema";
import type { SttPolicyCatalogue } from "./stt-policy-catalog";
import { createSttPolicyPin } from "./stt-policy-pin";
import { createSttRoleBinding, type SttRoleBinding } from "./stt-role-binding";

export {
  migrateSttBudgetHolds,
  migrateSttHoldCancellation,
} from "./stt-hold-schema";

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
    state: z.enum(["held", "cancelled_unissued"]),
    cancelled_at: clock.nullable(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
const unavailable = () =>
  new LocalError("Speech budget hold storage is unavailable.", 503);
/** Internal never-dispatched holds only. No claim, provider, remote settlement or HTTP interface. */
export class SttBudgetHolds {
  private working = false;
  private roles: SttHoldRoles;
  constructor(
    private db: Database,
    private media: OwnedMedia,
    private policies: SttPolicyCatalogue,
    private now: () => number = Date.now,
    private reader?: SttBalanceReader,
    private roleReader?: SttRoleReader,
    private accessReviewer?: SttAccessReviewer,
  ) {
    schema(db);
    this.roles = new SttHoldRoles(db);
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
      if (
        (r.state === "held" && r.cancelled_at !== null) ||
        (r.state === "cancelled_unissued" &&
          (r.cancelled_at === null || r.cancelled_at < r.created))
      )
        throw unavailable();
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
      roleBinding: this.roles.status(row.owner, row.id, row.created, pin),
      id: row.id,
      request_id: row.request,
      state: row.state,
      cancelled_at: row.cancelled_at,
      outstandingMicros: row.state === "held" ? row.cost_micros : 0,
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
  /** Explicit read-only diagnostic, never an account-verification or execution-permit API. */
  reviewAccess(ownerInput: unknown, idInput: unknown) {
    let owner: string, id: string;
    try {
      owner = ref.parse(ownerInput);
      id = z.uuid().parse(idInput);
    } catch {
      throw new LocalError("Invalid speech access-review reference.");
    }
    return this.storage(() => {
      const probe = () => {
        schema(this.db);
        this.session(owner, this.time());
        const raw = this.db
          .query("SELECT * FROM stt_budget_holds WHERE owner=? AND id=?")
          .get(owner, id);
        if (!raw) throw new LocalError("Speech budget hold not found.", 404);
        const { r, pin } = this.validated(raw);
        if (r.state !== "held")
          return {
            blocker: sttAccessBlocked({
              status: "requires_user_action",
              code: "hold_closed",
            }),
          };
        const binding = this.roles.read(owner, id, r.created, pin);
        if (!binding)
          return {
            blocker: sttAccessBlocked({
              status: "requires_user_action",
              code: "role_snapshot_required",
            }),
          };
        try {
          const consent = this.media.checkProcessingConsent(
            owner,
            r.media,
            r.consent_revision,
          );
          if (consent.contentSha256 !== r.content_hash)
            return {
              blocker: sttAccessBlocked({
                status: "requires_user_action",
                code: "media_review_required",
              }),
            };
        } catch (error) {
          if (
            !(error instanceof LocalError) ||
            ![403, 404, 409, 410].includes(error.status)
          )
            throw error;
          return {
            blocker: sttAccessBlocked({
              status: "requires_user_action",
              code: "media_review_required",
            }),
          };
        }
        return { r, binding };
      };
      const first = probe();
      if (first.blocker) {
        this.session(owner, this.time());
        return first.blocker;
      }
      const r = first.r,
        binding = first.binding;
      const review = reviewSttAccountAccess(
        {
          ownerRef: owner,
          holdId: id,
          provider: binding.role.provider,
          accountRef: binding.policy.profile.accountRef,
          currency: binding.policy.profile.price.currency,
          model: binding.role.model,
          roleContentSha256: binding.contentSha256,
          policyContentSha256: binding.policy.contentSha256,
          maxCostMicros: r.cost_micros,
          language: r.language,
          checkedAt: this.time(),
          requestOptionsBound: false,
        },
        this.accessReviewer,
      );
      // No write transaction surrounds a callback; independent privacy/cancellation must persist.
      const current = probe();
      this.session(owner, this.time());
      return current.blocker ?? review;
    });
  }
  cancelUnissued(ownerInput: unknown, idInput: unknown) {
    let owner: string, id: string;
    try {
      owner = ref.parse(ownerInput);
      id = z.uuid().parse(idInput);
    } catch {
      throw new LocalError("Invalid unissued hold cancellation reference.");
    }
    return this.storage(() =>
      this.db
        .transaction(() => {
          schema(this.db);
          this.session(owner, this.time());
          const raw = this.db
            .query("SELECT * FROM stt_budget_holds WHERE owner=? AND id=?")
            .get(owner, id);
          if (!raw) throw new LocalError("Speech budget hold not found.", 404);
          const { r } = this.validated(raw);
          const at = this.time();
          this.session(owner, at);
          if (r.state === "cancelled_unissued") return this.view(r);
          if (at < r.created) throw unavailable();
          const changed = this.db
            .query(
              "UPDATE stt_budget_holds SET state='cancelled_unissued',cancelled_at=? WHERE owner=? AND id=? AND state='held'",
            )
            .run(at, owner, id);
          if (changed.changes !== 1) throw unavailable();
          const saved = this.db
            .query("SELECT * FROM stt_budget_holds WHERE owner=? AND id=?")
            .get(owner, id);
          return this.view(this.validated(saved).r);
        })
        .immediate(),
    );
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
        let roleBinding: SttRoleBinding | undefined;
        if (this.roleReader) {
          let snapshot: unknown;
          try {
            snapshot = this.roleReader(
              Object.freeze({
                ownerRef: owner,
                provider: p.price.provider,
                accountRef: p.accountRef,
                policyRevision: p.revision,
              }),
            );
            if (snapshot instanceof Promise) {
              void snapshot.catch(() => {});
              throw Error("Synchronous role snapshot required");
            }
          } catch {
            throw new LocalError("Speech role snapshot is unavailable.", 503);
          }
          const candidate = createSttRoleBinding(
            p,
            snapshot,
            pin.effectiveLimits,
          );
          if (candidate.kind !== "role_binding")
            throw new LocalError(
              "Speech role does not match the reviewed budget policy.",
              409,
            );
          roleBinding = candidate;
        }
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
            if (rows.some(({ r }) => r.owner === owner && r.state === "held"))
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
                      ({ r }) =>
                        (!owned || r.owner === owner) &&
                        sameDay(r) &&
                        r.state === "held",
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
                  sameCurrency
                    .filter(({ r }) => r.state === "held")
                    .map(({ r }) => r.cost_micros),
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
              state: "held",
              cancelled_at: null,
            };
            this.db
              .query(
                `INSERT INTO stt_budget_holds(${sttHoldColumns.join(",")},state,cancelled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
                row.state,
                row.cancelled_at,
              );
            if (roleBinding) {
              this.roles.assert();
              this.db
                .query("INSERT INTO stt_hold_roles VALUES(?,?,?,?,?)")
                .run(
                  row.id,
                  owner,
                  roleBinding.canonicalJson,
                  roleBinding.contentSha256,
                  row.created,
                );
            }
            return this.view(row);
          })
          .immediate();
      });
    } finally {
      this.working = false;
    }
  }
}
