import { z } from "zod";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const currency = z.enum(["INR", "USD"]);
const priceSchema = z
  .object({
    enabled: z.literal(true),
    provider: z.enum(["sarvam", "elevenlabs"]),
    model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,100}$/),
    revision: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    currency,
    rateMicros: integer,
    unitMs: integer.min(1).max(3600000),
    quantumMs: integer.min(1).max(60000),
    minimumMs: integer.max(60000),
    requestFeeMicros: integer,
    effectiveAt: integer,
    expiresAt: integer,
  })
  .strict()
  .refine((p) => p.expiresAt > p.effectiveAt);
const mediaSchema = z
  .object({ durationMs: integer.min(100).max(29000) })
  .strict();
const ceilingSchema = z
  .object({ currency, maxEstimateMicros: integer })
  .strict();
type Reason =
  | "disabled"
  | "invalid_price"
  | "invalid_media"
  | "invalid_ceiling"
  | "invalid_clock"
  | "stale_price"
  | "currency_mismatch"
  | "overflow"
  | "ceiling_exceeded"
  | "invalid_input";
type Result =
  | Readonly<{ kind: "denied"; reason: Reason }>
  | Readonly<{
      kind: "estimate";
      provider: "sarvam" | "elevenlabs";
      model: string;
      priceRevision: string;
      currency: "INR" | "USD";
      billableMs: number;
      estimateMicros: number;
    }>;
const denied = (reason: Reason): Result =>
  Object.freeze({ kind: "denied", reason });
const ceilDivide = (value: bigint, divisor: bigint) =>
  (value + divisor - 1n) / divisor;

/** Pure tariff arithmetic only: no account balance, consent, admission or execution authority. */
export function estimateSttCost(
  priceInput: unknown,
  inspectedMedia: unknown,
  requestCeiling: unknown,
  now: number,
): Result {
  try {
    if (!integer.safeParse(now).success) return denied("invalid_clock");
    if (
      !priceInput ||
      typeof priceInput !== "object" ||
      !("enabled" in priceInput) ||
      priceInput.enabled !== true
    )
      return denied("disabled");
    const parsedPrice = priceSchema.safeParse(priceInput);
    if (!parsedPrice.success) return denied("invalid_price");
    const media = mediaSchema.safeParse(inspectedMedia);
    if (!media.success) return denied("invalid_media");
    const ceiling = ceilingSchema.safeParse(requestCeiling);
    if (!ceiling.success) return denied("invalid_ceiling");
    const p = parsedPrice.data;
    if (now < p.effectiveAt || now >= p.expiresAt) return denied("stale_price");
    if (ceiling.data.currency !== p.currency)
      return denied("currency_mismatch");
    const quantum = BigInt(p.quantumMs);
    const billable =
      ceilDivide(
        BigInt(Math.max(media.data.durationMs, p.minimumMs)),
        quantum,
      ) * quantum;
    const cost =
      ceilDivide(billable * BigInt(p.rateMicros), BigInt(p.unitMs)) +
      BigInt(p.requestFeeMicros);
    if (cost > BigInt(Number.MAX_SAFE_INTEGER)) return denied("overflow");
    if (cost > BigInt(ceiling.data.maxEstimateMicros))
      return denied("ceiling_exceeded");
    return Object.freeze({
      kind: "estimate",
      provider: p.provider,
      model: p.model,
      priceRevision: p.revision,
      currency: p.currency,
      billableMs: Number(billable),
      estimateMicros: Number(cost),
    });
  } catch {
    return denied("invalid_input");
  }
}
