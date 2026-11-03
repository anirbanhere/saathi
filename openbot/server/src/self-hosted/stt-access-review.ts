import { z } from "zod";
import type { SpeechLanguage } from "./roles";

export type SttAccessContext = Readonly<{
  ownerRef: string;
  holdId: string;
  provider: "sarvam" | "elevenlabs";
  accountRef: string;
  currency: "INR" | "USD";
  model: string;
  roleContentSha256: string;
  policyContentSha256: string;
  maxCostMicros: number;
  language: SpeechLanguage;
  checkedAt: number;
  requestOptionsBound: false;
}>;
/** Server-injected synchronous cached blocker review only; not a credential verifier or grant issuer. */
export type SttAccessReviewer = (context: SttAccessContext) => unknown;
const resultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("requires_auth"),
      code: z.enum([
        "account_not_connected",
        "grant_expired",
        "grant_revoked",
        "grant_scope_mismatch",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("requires_user_action"),
      code: z.enum([
        "provider_terms_review_required",
        "retention_eligibility_unverified",
        "spend_policy_review_required",
        "request_options_review_required",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      code: z.literal("account_check_unavailable"),
    })
    .strict(),
]);
type Blocker =
  | z.infer<typeof resultSchema>
  | {
      status: "requires_user_action";
      code: "hold_closed" | "role_snapshot_required" | "media_review_required";
    }
  | { status: "unavailable"; code: "reviewer_result_unsupported" };
export const sttAccessBlocked = (blocker: Blocker) =>
  Object.freeze({
    kind: "access_review" as const,
    status: blocker.status,
    code: blocker.code,
    executionAllowed: false as const,
  });
/** Intentionally accepts no positive/verified result. A diagnostic report can never be a permit. */
export function reviewSttAccountAccess(
  context: SttAccessContext,
  reviewer?: SttAccessReviewer,
) {
  if (!reviewer)
    return sttAccessBlocked({
      status: "requires_auth",
      code: "account_not_connected",
    });
  try {
    const raw = reviewer(Object.freeze({ ...context }));
    if (raw instanceof Promise) {
      void raw.catch(() => {});
      throw Error("Synchronous cached review required");
    }
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success)
      return sttAccessBlocked({
        status: "unavailable",
        code: "reviewer_result_unsupported",
      });
    return sttAccessBlocked(parsed.data);
  } catch {
    return sttAccessBlocked({
      status: "unavailable",
      code: "account_check_unavailable",
    });
  }
}
