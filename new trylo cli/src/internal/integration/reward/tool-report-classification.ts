import type { JsonObject } from "../../protocol/envelope.js";
import type { RewardMeasurement } from "../../learning/reward/contracts.js";

export type ToolReportMeasurement = Extract<RewardMeasurement, { kind: "measured" }>
  | { readonly kind: "unknown"; readonly reason: "denied" | "cancelled" | "unverified" };

/** Shared classification only: collection and analysis retain their own lifecycles. */
export function decodeToolMeasurement(status: string, code: unknown): ToolReportMeasurement {
  const denied = status === "denied" || ["permission_denied", "permission_expired", "approval_required", "review_denied",
    "subagent_permission_denied", "subagent_approval_channel_forbidden", "subagent_parent_approval_required"].includes(String(code));
  if (denied) return { kind: "unknown", reason: "denied" };

  if (status === "succeeded" || status === "failed") {
    return { kind: "measured", value: status === "succeeded" ? 1 : -1, confidence: 1, noiseVariance: 1 };
  }

  return { kind: "unknown", reason: status === "cancelled" ? "cancelled" : "unverified" };
}

export function isToolReportClose(kind: string, payload: JsonObject): boolean {
  return kind === "tool_result" || (kind === "observation" && payload.status === "unknown");
}

export function isToolReportRefusal(kind: string, payload: JsonObject): boolean {
  return kind === "observation" && (payload.refused === true || payload.decision === "denied");
}
