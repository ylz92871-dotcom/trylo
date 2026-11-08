import type { UserPeerProgress } from "../../learning/domains/user/learning-cycle-contract.js";

export type UserModelFailure = { readonly ok: false; readonly reason: string } & Pick<UserPeerProgress, "outcome" | "waitFor" | "waitRefs">;

/** Stable owner error codes are converted once at the model/funding boundary.
 * A broken transport is not evidence of scarce provider capacity. */
export function userModelFailure(reason: string, refs: readonly string[] = []): UserModelFailure {
  switch (reason) {
    case "learning_budget_exhausted":
    case "learning_budget_held":
    case "learning_budget_capacity":
    case "user_learning_prompt_budget_exhausted":
    case "user_learning_prompt_envelope_exceeded":
      return { ok: false, reason, waitFor: "budget", waitRefs: refs };
    case "content_model_provider_rate_limit":
    case "content_model_provider_quota":
      return { ok: false, reason, waitFor: "resources", waitRefs: refs };
    case "user_learning_request_already_reserved":
    case "user_learning_settlement_unconfirmed":
    case "content_model_transport_failed":
    case "content_model_timeout":
    case "content_model_incomplete":
      return { ok: false, reason, outcome: "unknown", waitFor: "recovery", waitRefs: refs };
    case "learning_budget_stale":
      return { ok: false, reason, waitFor: "source_change", waitRefs: refs };
    default: return { ok: false, reason };
  }
}
