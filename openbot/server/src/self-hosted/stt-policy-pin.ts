import { createHash } from "node:crypto";
import type { z } from "zod";
import { resolveSttBudgetLimits, sttBudgetProfileSchema } from "./stt-budget";

const format = "saathi-stt-policy-pin-v1" as const;
type Profile = z.infer<typeof sttBudgetProfileSchema>;
type FrozenProfile = Readonly<
  Omit<Profile, "languages" | "price" | "ceilings"> & {
    languages: readonly Profile["languages"][number][];
    price: Readonly<Profile["price"]>;
    ceilings: Readonly<Profile["ceilings"]>;
  }
>;
export type SttPolicyPin = Readonly<{
  kind: "policy_pin";
  format: typeof format;
  contentSha256: string;
  canonicalJson: string;
  profile: FrozenProfile;
  effectiveLimits: Readonly<Profile["ceilings"]>;
}>;
type Denial = Readonly<{
  kind: "denied";
  reason: "disabled" | "invalid_policy" | "invalid_limits" | "invalid_input";
}>;
const denied = (reason: Denial["reason"]): Denial =>
  Object.freeze({ kind: "denied", reason });

// Only called on the bounded, validated policy tree; this is a versioned project recipe.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw Error("Invalid canonical policy value");
  return encoded;
}

/** Content identity only, including historical tariffs; never proof of authorization or a lease. */
export function createSttPolicyPin(
  input?: unknown,
  tightenedLimits?: unknown,
): SttPolicyPin | Denial {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      !("enabled" in input) ||
      input.enabled !== true
    )
      return denied("disabled");
    const parsed = sttBudgetProfileSchema.safeParse(input);
    if (!parsed.success) return denied("invalid_policy");
    const p = parsed.data;
    const effectiveLimits = resolveSttBudgetLimits(p.ceilings, tightenedLimits);
    if (!effectiveLimits) return denied("invalid_limits");
    const profile: FrozenProfile = Object.freeze({
      ...p,
      languages: Object.freeze([...new Set(p.languages)].sort()),
      price: Object.freeze({ ...p.price }),
      ceilings: Object.freeze({ ...p.ceilings }),
    });
    const canonicalJson = canonical({ format, profile, effectiveLimits });
    const contentSha256 = createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex");
    return Object.freeze({
      kind: "policy_pin",
      format,
      canonicalJson,
      contentSha256,
      profile,
      effectiveLimits,
    });
  } catch {
    return denied("invalid_input");
  }
}
