import { createHash } from "node:crypto";
import type { z } from "zod";
import { createSttPolicyPin, type SttPolicyPin } from "./stt-policy-pin";
import { vendorSttBounds, vendorSttRoleSchema } from "./vendor-stt-contract";

const format = "saathi-stt-role-binding-v1" as const;
type Role = z.infer<typeof vendorSttRoleSchema>;
type FrozenRole = Readonly<
  Omit<Role, "languages"> & { languages: readonly Role["languages"][number][] }
>;
export type SttRoleBinding = Readonly<{
  kind: "role_binding";
  format: typeof format;
  contentSha256: string;
  canonicalJson: string;
  policy: SttPolicyPin;
  role: FrozenRole;
  executionAllowed: false;
}>;
type Reason =
  | "disabled"
  | "invalid_policy"
  | "invalid_limits"
  | "invalid_input"
  | "invalid_role"
  | "provider_mismatch"
  | "model_mismatch"
  | "language_mismatch"
  | "media_contract_mismatch";
const denied = (reason: Reason) =>
  Object.freeze({ kind: "denied" as const, reason });

/** Compatibility/content only, including historical tariffs. No persistent binding or execution grant. */
export function createSttRoleBinding(
  profileInput?: unknown,
  roleInput?: unknown,
  tightenedLimits?: unknown,
): SttRoleBinding | ReturnType<typeof denied> {
  try {
    const policy = createSttPolicyPin(profileInput, tightenedLimits);
    if (policy.kind !== "policy_pin") return denied(policy.reason);
    const parsed = vendorSttRoleSchema.safeParse(roleInput);
    if (!parsed.success) return denied("invalid_role");
    const r = parsed.data,
      p = policy.profile;
    if (r.provider !== p.price.provider) return denied("provider_mismatch");
    if (r.model !== p.price.model) return denied("model_mismatch");
    if (p.languages.some((language) => !r.languages.includes(language)))
      return denied("language_mismatch");
    if (
      p.maxBytes > vendorSttBounds.maxBytes ||
      p.maxDurationMs > vendorSttBounds.maxDurationMs ||
      p.maxDurationMs < vendorSttBounds.minDurationMs
    )
      return denied("media_contract_mismatch");
    // Fixed alphabetic wrapper/role keys and the policy's own canonical bytes form a versioned recipe.
    const role: FrozenRole = Object.freeze({
      languages: Object.freeze([...new Set(r.languages)].sort()),
      model: r.model,
      provider: r.provider,
      timeoutMs: r.timeoutMs,
    });
    const canonicalJson = JSON.stringify({
      format,
      policy: JSON.parse(policy.canonicalJson),
      role,
    });
    const contentSha256 = createHash("sha256")
      .update(canonicalJson, "utf8")
      .digest("hex");
    return Object.freeze({
      kind: "role_binding",
      format,
      contentSha256,
      canonicalJson,
      policy,
      role,
      executionAllowed: false,
    });
  } catch {
    return denied("invalid_input");
  }
}
