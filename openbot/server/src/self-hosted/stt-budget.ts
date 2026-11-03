import { z } from "zod";
import { estimateSttCost, sttTariffSchema } from "./stt-cost";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ref = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const limitsSchema = z
  .object({
    ownerAttempts: integer.min(1),
    globalAttempts: integer.min(1),
    ownerAudioMs: integer.min(1),
    globalAudioMs: integer.min(1),
    ownerRecords: integer.min(1),
    globalRecords: integer.min(1),
    requestCostMicros: integer,
    ownerCostMicros: integer,
    globalCostMicros: integer,
  })
  .strict();
type Limits = z.infer<typeof limitsSchema>;
const coherent = (l: Limits) =>
  l.ownerAttempts <= l.globalAttempts &&
  l.ownerAudioMs <= l.globalAudioMs &&
  l.ownerRecords <= l.globalRecords &&
  l.requestCostMicros <= l.ownerCostMicros &&
  l.ownerCostMicros <= l.globalCostMicros;

/** Shared normalization only; this does not reserve units or grant execution. */
export function resolveSttBudgetLimits(
  ceilings: unknown,
  tightenedLimits?: unknown,
): Readonly<Limits> | null {
  try {
    const hard = limitsSchema.safeParse(ceilings);
    const narrowed = limitsSchema
      .partial()
      .safeParse(tightenedLimits === undefined ? {} : tightenedLimits);
    if (!hard.success || !coherent(hard.data) || !narrowed.success) return null;
    const limits = { ...hard.data, ...narrowed.data };
    if (
      !coherent(limits) ||
      (Object.keys(limits) as (keyof Limits)[]).some(
        (k) => limits[k] > hard.data[k],
      )
    )
      return null;
    return Object.freeze(limits);
  } catch {
    return null;
  }
}
export const sttBudgetProfileSchema = z
  .object({
    enabled: z.literal(true),
    revision: ref,
    accountRef: ref,
    languages: z
      .array(z.enum(["en-IN", "hi-IN", "ta-IN"]))
      .min(1)
      .max(3),
    maxBytes: integer.min(1).max(2097152),
    maxDurationMs: integer.min(100).max(29000),
    maxSnapshotAgeMs: integer.min(1).max(60000),
    price: sttTariffSchema,
    ceilings: limitsSchema,
  })
  .strict()
  .refine((p) => coherent(p.ceilings));
const mediaSchema = z
  .object({
    durationMs: integer.min(100).max(29000),
    byteLength: integer.min(1).max(2097152),
    channels: z.literal(1),
    language: z.enum(["en-IN", "hi-IN", "ta-IN"]),
  })
  .strict();
const counterSchema = z
  .object({
    attempts: integer,
    audioMs: integer,
    records: integer,
    costMicros: integer,
  })
  .strict();
const usageSchema = z
  .object({
    provider: z.enum(["sarvam", "elevenlabs"]),
    currency: z.enum(["INR", "USD"]),
    ownerRef: ref,
    accountRef: ref,
    policyRevision: ref,
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    observedAt: integer,
    ownerPending: z.boolean(),
    owner: counterSchema,
    global: counterSchema,
  })
  .strict();
const balanceSchema = z
  .object({
    provider: z.enum(["sarvam", "elevenlabs"]),
    accountRef: ref,
    currency: z.enum(["INR", "USD"]),
    observedAt: integer,
    availableMicros: integer,
    outstandingMicros: integer,
  })
  .strict();
type Reason =
  | "disabled"
  | "invalid_policy"
  | "invalid_limits"
  | "invalid_clock"
  | "invalid_owner"
  | "invalid_media"
  | "invalid_usage"
  | "invalid_balance"
  | "context_mismatch"
  | "stale_snapshot"
  | "cost_unavailable"
  | "balance_exceeded"
  | "pending_owner"
  | "budget_exceeded"
  | "invalid_input";
type Estimate = Extract<
  ReturnType<typeof estimateSttCost>,
  { kind: "estimate" }
>;
type Result =
  | Readonly<{ kind: "denied"; reason: Reason }>
  | Readonly<
      Omit<Estimate, "kind"> & {
        kind: "budget_preview";
        policyRevision: string;
      }
    >;
type Preview = (
  owner: unknown,
  media: unknown,
  usage: unknown,
  balance: unknown,
  now: number,
) => Result;
const denied = (reason: Reason): Result =>
  Object.freeze({ kind: "denied", reason });
const fixed = (reason: Reason): Preview => Object.freeze(() => denied(reason));

/** Closed pure evaluator only; positive output cannot reserve money or authorize a worker. */
export function createSttBudgetPreview(
  profileInput?: unknown,
  tightenedLimits?: unknown,
): Preview {
  try {
    if (
      !profileInput ||
      typeof profileInput !== "object" ||
      !("enabled" in profileInput) ||
      profileInput.enabled !== true
    )
      return fixed("disabled");
    const parsed = sttBudgetProfileSchema.safeParse(profileInput);
    if (!parsed.success) return fixed("invalid_policy");
    const p = parsed.data;
    const limits = resolveSttBudgetLimits(p.ceilings, tightenedLimits);
    if (!limits) return fixed("invalid_limits");
    return Object.freeze((owner, mediaInput, usageInput, balanceInput, now) => {
      try {
        if (!integer.max(8640000000000000).safeParse(now).success)
          return denied("invalid_clock");
        if (!ref.safeParse(owner).success) return denied("invalid_owner");
        const media = mediaSchema.safeParse(mediaInput);
        if (
          !media.success ||
          media.data.durationMs > p.maxDurationMs ||
          media.data.byteLength > p.maxBytes ||
          !p.languages.includes(media.data.language)
        )
          return denied("invalid_media");
        const usage = usageSchema.safeParse(usageInput);
        if (!usage.success) return denied("invalid_usage");
        const balance = balanceSchema.safeParse(balanceInput);
        if (!balance.success) return denied("invalid_balance");
        const u = usage.data,
          b = balance.data;
        if (
          u.provider !== p.price.provider ||
          u.currency !== p.price.currency ||
          b.provider !== p.price.provider ||
          u.ownerRef !== owner ||
          u.accountRef !== p.accountRef ||
          u.policyRevision !== p.revision ||
          u.day !== new Date(now).toISOString().slice(0, 10) ||
          b.accountRef !== p.accountRef ||
          b.currency !== p.price.currency
        )
          return denied("context_mismatch");
        if (
          [u.observedAt, b.observedAt].some(
            (at) => at > now || now - at >= p.maxSnapshotAgeMs,
          )
        )
          return denied("stale_snapshot");
        if (
          (Object.keys(u.owner) as (keyof typeof u.owner)[]).some(
            (k) => u.owner[k] > u.global[k],
          )
        )
          return denied("invalid_usage");
        if (u.ownerPending) return denied("pending_owner");
        const cost = estimateSttCost(
          p.price,
          { durationMs: media.data.durationMs },
          {
            currency: p.price.currency,
            maxEstimateMicros: limits.requestCostMicros,
          },
          now,
        );
        if (cost.kind !== "estimate") return denied("cost_unavailable");
        const additions = [
          [u.owner.attempts, 1, limits.ownerAttempts],
          [u.global.attempts, 1, limits.globalAttempts],
          [u.owner.records, 1, limits.ownerRecords],
          [u.global.records, 1, limits.globalRecords],
          [u.owner.audioMs, media.data.durationMs, limits.ownerAudioMs],
          [u.global.audioMs, media.data.durationMs, limits.globalAudioMs],
          [u.owner.costMicros, cost.estimateMicros, limits.ownerCostMicros],
          [u.global.costMicros, cost.estimateMicros, limits.globalCostMicros],
        ] as const;
        if (
          additions.some(
            ([used, increment, cap]) =>
              BigInt(used) + BigInt(increment) > BigInt(cap),
          )
        )
          return denied("budget_exceeded");
        if (
          BigInt(b.availableMicros) - BigInt(b.outstandingMicros) <
          BigInt(cost.estimateMicros)
        )
          return denied("balance_exceeded");
        return Object.freeze({
          ...cost,
          kind: "budget_preview",
          policyRevision: p.revision,
        });
      } catch {
        return denied("invalid_input");
      }
    });
  } catch {
    return fixed("invalid_policy");
  }
}
