import type { Database } from "bun:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import type { OwnedMedia } from "./media-store";
import { fixtureLanguages, type ProviderRoles } from "./roles";
import { validateFixtureOutcome } from "./stt-outcome";

const inputSchema = z
  .object({
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    media_id: z.uuid(),
    consent_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const roleSchema = z
  .object({
    provider: z.enum(["fixture-a", "fixture-b"]),
    model: z.literal("synthetic-stt-v1"),
    languages: z.array(z.enum(fixtureLanguages)).min(1).max(3),
    timeoutMs: z.number().int().min(1000).max(60000),
  })
  .strict();
/** Shared startup guard; admission/claim still validate their own authoritative boundaries. */
export function assertFixtureSttRole(role: unknown) {
  if (!roleSchema.safeParse(role).success)
    throw new LocalError(
      "Only reviewed synthetic fixture STT roles are supported; live speech remains disabled.",
      503,
    );
}
export type SttAdmissionLimits = {
  ownerAttempts: number;
  globalAttempts: number;
  ownerAudioMs: number;
  globalAudioMs: number;
  ownerRecords: number;
  globalRecords: number;
};
const defaults: SttAdmissionLimits = {
  ownerAttempts: 4,
  globalAttempts: 20,
  ownerAudioMs: 60000,
  globalAudioMs: 300000,
  ownerRecords: 100,
  globalRecords: 5000,
};
type Row = {
  id: string;
  owner: string;
  request: string;
  digest: string;
  media: string;
  consent_revision: number;
  content_hash: string;
  role: string;
  duration_ms: number;
  language_hint: string | null;
  state:
    | "reserved"
    | "claimed"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "blocked"
    | "revoked"
    | "expired";
  created: number;
  updated: number;
  expires: number;
  pending: number;
  claim_hash: string | null;
  claimed_at: number | null;
  claim_deadline: number | null;
  settlement_digest: string | null;
  outcome: string | null;
  settled_at: number | null;
  failure_code: string | null;
};

export function migrateSttAdmissions(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS stt_admissions(
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    request TEXT NOT NULL, digest TEXT NOT NULL, media TEXT NOT NULL REFERENCES owned_media(id) ON DELETE CASCADE,
    consent_revision INTEGER NOT NULL, content_hash TEXT NOT NULL, role TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 100 AND 29000), language_hint TEXT,
    state TEXT NOT NULL CHECK(state IN('reserved','cancelled','interrupted')),
    created INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL, UNIQUE(owner,request)
  ); CREATE UNIQUE INDEX IF NOT EXISTS stt_pending_owner ON stt_admissions(owner) WHERE state='reserved';
  CREATE TABLE IF NOT EXISTS stt_admission_usage(id TEXT PRIMARY KEY,owner TEXT NOT NULL,day TEXT NOT NULL,duration_ms INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS stt_usage_day_owner ON stt_admission_usage(day,owner);`);
}

/** Internal fixture admission/claims only. No adapter or network invocation is performed here. */
export class SttAdmissions {
  private limits: SttAdmissionLimits;
  constructor(
    private db: Database,
    private media: OwnedMedia,
    private now: () => number = Date.now,
    limits: Partial<SttAdmissionLimits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    for (const key of Object.keys(this.limits) as (keyof SttAdmissionLimits)[])
      if (
        !Number.isInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > defaults[key]
      )
        throw new LocalError("Invalid STT admission budget.");
  }
  private session(owner: string, now: number) {
    const result = this.db
      .query<{ expiry: number | null }, [string, number]>(
        "SELECT max(expires) expiry FROM sessions WHERE owner=? AND expires>?",
      )
      .get(owner, now);
    if (!result?.expiry)
      throw new LocalError(
        "STT admission requires an active owner session.",
        403,
      );
    return result.expiry;
  }
  private row(owner: string, id: string) {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM stt_admissions WHERE owner=? AND id=?",
      )
      .get(owner, id);
    if (!row) throw new LocalError("STT admission not found.", 404);
    return row;
  }
  private savedRole(row: Row) {
    try {
      return roleSchema.parse(JSON.parse(row.role));
    } catch {
      throw new LocalError("Stored STT admission is unavailable.", 503);
    }
  }
  private view(row: Row) {
    const role = this.savedRole(row);
    let outcome: ReturnType<typeof validateFixtureOutcome>["outcome"] | null =
      null;
    if (row.outcome) {
      let visible = false;
      try {
        visible =
          this.media.checkProcessingConsent(
            row.owner,
            row.media,
            row.consent_revision,
          ).contentSha256 === row.content_hash;
      } catch {
        /* Revoked/expired output is not returned. */
      }
      if (visible) {
        try {
          outcome = validateFixtureOutcome(
            JSON.parse(row.outcome),
            role,
          ).outcome;
        } catch {
          throw new LocalError("Stored fixture outcome is unavailable.", 503);
        }
      }
    }
    return {
      id: row.id,
      request_id: row.request,
      mediaId: row.media,
      consentRevision: row.consent_revision,
      mode: "fixture" as const,
      role: Object.freeze({
        ...role,
        languages: Object.freeze(role.languages),
      }),
      durationMs: row.duration_ms,
      languageHint: row.language_hint,
      state: row.state,
      createdAt: row.created,
      updatedAt: row.updated,
      expiresAt: row.expires,
      pending: row.pending === 1,
      claimedAt: row.claimed_at,
      claimDeadline: row.claim_deadline,
      failureCode: row.failure_code,
      outcome,
    };
  }
  begin(owner: string, input: unknown, currentRole: ProviderRoles["stt"]) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success)
      throw new LocalError(
        "Use a request ID, owned media ID and exact consent revision only.",
      );
    const digest = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    return this.db
      .transaction(() => {
        const now = this.now();
        this.session(owner, now);
        const duplicate = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM stt_admissions WHERE owner=? AND request=?",
          )
          .get(owner, parsed.data.request_id);
        if (duplicate) {
          if (duplicate.digest !== digest)
            throw new LocalError(
              "STT request conflicts with its original input.",
              409,
            );
          return this.view(duplicate);
        }
        const selected = roleSchema.safeParse(currentRole);
        if (!selected.success)
          throw new LocalError(
            "Only reviewed synthetic fixture STT roles can be admitted; live speech remains disabled.",
            503,
          );
        const consent = this.media.checkProcessingConsent(
            owner,
            parsed.data.media_id,
            parsed.data.consent_revision,
          ),
          metadata = this.media.metadata(owner, parsed.data.media_id);
        if (
          metadata.durationMs < 100 ||
          metadata.durationMs > 29000 ||
          (metadata.languageHint &&
            !(selected.data.languages as readonly string[]).includes(
              metadata.languageHint,
            ))
        )
          throw new LocalError(
            "Media duration/language is unavailable for this STT role.",
          );
        if (
          this.db
            .query("SELECT 1 FROM stt_admissions WHERE owner=? AND pending=1")
            .get(owner)
        )
          throw new LocalError(
            "An STT reservation is already pending for this owner.",
            409,
          );
        const lifetime = this.db
          .query<{ total: number; owned: number }, [string]>(
            "SELECT count(*) total,COALESCE(sum(CASE WHEN owner=? THEN 1 ELSE 0 END),0) owned FROM stt_admission_usage",
          )
          .get(owner);
        const day = new Date(now).toISOString().slice(0, 10),
          usage = this.db
            .query<
              { attempts: number; owned: number; ms: number; ownedMs: number },
              [string, string, string]
            >(`SELECT count(*) attempts,COALESCE(sum(CASE WHEN owner=? THEN 1 ELSE 0 END),0) owned,
        COALESCE(sum(duration_ms),0) ms,COALESCE(sum(CASE WHEN owner=? THEN duration_ms ELSE 0 END),0) ownedMs FROM stt_admission_usage WHERE day=?`)
            .get(owner, owner, day);
        if (
          !lifetime ||
          !usage ||
          lifetime.total >= this.limits.globalRecords ||
          lifetime.owned >= this.limits.ownerRecords ||
          usage.attempts >= this.limits.globalAttempts ||
          usage.owned >= this.limits.ownerAttempts ||
          usage.ms + metadata.durationMs > this.limits.globalAudioMs ||
          usage.ownedMs + metadata.durationMs > this.limits.ownerAudioMs
        )
          throw new LocalError("STT admission budget is exhausted.", 429);
        const id = randomUUID();
        this.db
          .query(`INSERT INTO stt_admissions(id,owner,request,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires)
        VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?)`)
          .run(
            id,
            owner,
            parsed.data.request_id,
            digest,
            metadata.id,
            consent.consentRevision,
            consent.contentSha256,
            JSON.stringify(selected.data),
            metadata.durationMs,
            metadata.languageHint,
            now,
            now,
            metadata.expiresAt,
          );
        this.db
          .query("INSERT INTO stt_admission_usage VALUES(?,?,?,?)")
          .run(id, owner, day, metadata.durationMs);
        return this.view(this.row(owner, id));
      })
      .immediate();
  }
  get(owner: string, id: string) {
    const row = this.row(owner, id);
    this.session(owner, this.now());
    return this.view(row);
  }
  claim(owner: string, id: string, currentRole: ProviderRoles["stt"]) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          now = this.now(),
          sessionExpires = this.session(owner, now);
        if (row.state !== "reserved" || !row.pending)
          return { fresh: false as const, admission: this.view(row) };
        const blocked = (code: string) => {
          this.db
            .query(
              "UPDATE stt_admissions SET state='blocked',pending=0,failure_code=?,updated=? WHERE id=?",
            )
            .run(code, now, id);
          return {
            fresh: false as const,
            admission: this.view(this.row(owner, id)),
          };
        };
        const selected = roleSchema.safeParse(currentRole);
        if (!selected.success || JSON.stringify(selected.data) !== row.role)
          return blocked("policy_unavailable");
        let snapshot: ReturnType<OwnedMedia["readConsentedSnapshot"]>;
        try {
          snapshot = this.media.readConsentedSnapshot(
            owner,
            row.media,
            row.consent_revision,
            row.content_hash,
          );
        } catch {
          return blocked("media_unavailable");
        }
        const deadline = Math.min(
          now + selected.data.timeoutMs,
          snapshot.expiresAt,
          sessionExpires,
        );
        if (deadline <= now) return blocked("media_unavailable");
        const token = randomBytes(32).toString("base64url"),
          digest = createHash("sha256").update(token).digest("hex");
        this.db
          .query(
            "UPDATE stt_admissions SET state='claimed',claim_hash=?,claimed_at=?,claim_deadline=?,updated=? WHERE id=?",
          )
          .run(digest, now, deadline, now, id);
        const claim = {
          fresh: true as const,
          admission: this.view(this.row(owner, id)),
          audio: snapshot.audio,
          executorToken: token,
        };
        // Only a trusted in-process worker reads these fields; ordinary JSON/status projection omits them.
        Object.defineProperty(claim, "audio", { enumerable: false });
        Object.defineProperty(claim, "executorToken", { enumerable: false });
        return Object.freeze(claim);
      })
      .immediate();
  }
  /** Private worker capability, not a user/channel grant. Can acknowledge after session expiry. */
  settle(owner: string, id: string, executorToken: string, input: unknown) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (
          typeof executorToken !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(executorToken) ||
          !row.claim_hash ||
          !/^[a-f0-9]{64}$/.test(row.claim_hash) ||
          !timingSafeEqual(
            createHash("sha256").update(executorToken).digest(),
            Buffer.from(row.claim_hash, "hex"),
          )
        )
          throw new LocalError("Private executor authentication failed.", 403);
        const validated = validateFixtureOutcome(input, this.savedRole(row)),
          encoded = JSON.stringify(validated.outcome);
        if (encoded.length > 20000)
          throw new LocalError(
            "Fixture outcome exceeds its retention budget.",
            502,
          );
        if (row.settlement_digest) {
          if (row.settlement_digest !== validated.digest)
            throw new LocalError(
              "STT settlement conflicts with its original outcome.",
              409,
            );
          return this.view(row);
        }
        if (!row.pending || row.claimed_at === null)
          throw new LocalError("STT request cannot accept settlement.", 409);
        const now = this.now();
        let state = row.state,
          finalOutcome:
            | ReturnType<typeof validateFixtureOutcome>["outcome"]
            | null = null,
          failureCode: string | null = row.failure_code ?? "output_suppressed";
        if (state === "claimed") {
          let current = false;
          try {
            current =
              this.media.checkProcessingConsent(
                owner,
                row.media,
                row.consent_revision,
              ).contentSha256 === row.content_hash;
          } catch {
            /* Release the worker slot without retaining late private output. */
          }
          if (!current) {
            state =
              now >= (row.claim_deadline ?? row.expires)
                ? "expired"
                : "revoked";
            failureCode = "consent_unavailable";
          } else if (row.claim_deadline === null || now >= row.claim_deadline) {
            state = "failed";
            failureCode = "timeout";
            finalOutcome = { status: "failed", code: "timeout" };
          } else {
            finalOutcome = validated.outcome;
            state =
              finalOutcome.status === "completed" ? "completed" : "failed";
            failureCode =
              finalOutcome.status === "failed" ? finalOutcome.code : null;
          }
        }
        this.db
          .query(
            "UPDATE stt_admissions SET state=?,pending=0,outcome=?,settlement_digest=?,settled_at=?,updated=?,failure_code=? WHERE id=?",
          )
          .run(
            state,
            finalOutcome ? JSON.stringify(finalOutcome) : null,
            validated.digest,
            now,
            now,
            failureCode,
            id,
          );
        return this.view(this.row(owner, id));
      })
      .immediate();
  }
  cancel(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          now = this.now();
        this.session(owner, now);
        if (row.state === "reserved" || row.state === "claimed")
          this.db
            .query(
              "UPDATE stt_admissions SET state='cancelled',pending=CASE WHEN claimed_at IS NULL THEN 0 ELSE pending END,updated=? WHERE owner=? AND id=?",
            )
            .run(now, owner, id);
        return this.view(this.row(owner, id));
      })
      .immediate();
  }
  /** Call only after the full store's exclusive kernel lock proves the previous server is gone. */
  recoverOnExclusiveStartup() {
    this.db
      .query(
        "UPDATE stt_admissions SET state=CASE WHEN state IN('reserved','claimed') THEN 'interrupted' ELSE state END,pending=0,claim_hash=NULL,outcome=NULL,updated=? WHERE pending=1",
      )
      .run(this.now());
  }
}
