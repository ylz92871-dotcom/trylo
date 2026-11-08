import { COORDINATION_DECISION_LIMITS, isCentralLearningAllowance, isCoordinationAction } from "../../../../control/coordination-parse.js";
import type { SkillFocus } from "./contracts.js";

export function isSkillIssueReference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= COORDINATION_DECISION_LIMITS.issueIdMaxChars
    && !/[\u0000-\u001f]/u.test(value);
}

/** Explicit central allocation DTO, distinct from the legacy output-token grant. */
export function isSkillFocus(value: unknown): value is SkillFocus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const input = value as Record<string, unknown>;

  return Object.keys(input).length === 5 && Object.keys(input).every(key => ["issueId", "expectedRevision", "reason", "sourceRefs", "allowance"].includes(key))
    && isSkillIssueReference(input.issueId)
    && isCoordinationAction({ kind: "decide", issueId: input.issueId, expectedRevision: input.expectedRevision,
      decision: "focused_learning", reason: input.reason, sourceRefs: input.sourceRefs })
    && isCentralLearningAllowance(input.allowance);
}
