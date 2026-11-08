import type { CentralLearningUsage } from "./coordination-contract.js";

export type LearningUsageBoundary = { readonly kind: "pending" | "complete" | "overrun" }
  | { readonly kind: "unknown"; readonly reason: string };

type ObservedUsage = Omit<Extract<CentralLearningUsage, { kind: "reported" }>, "kind">;

/**
 * The adapter may assert complete only after a successful terminal and its usage tail.
 * An observed overrun is a lower bound that closes funding, never a final-bill claim.
 */
export function learningUsageSettlement(boundary: LearningUsageBoundary, observed?: ObservedUsage): CentralLearningUsage {
  if (observed !== undefined && (boundary.kind === "complete" || boundary.kind === "overrun")) {
    return { kind: "reported", ...observed };
  }
  return { kind: "unknown", reason: boundary.kind === "unknown" ? boundary.reason
    : boundary.kind === "complete" ? "usage_not_reported" : "provider_stream_incomplete" };
}
