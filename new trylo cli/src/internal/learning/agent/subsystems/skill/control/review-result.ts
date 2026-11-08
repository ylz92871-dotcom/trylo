import type { CentralLearningWorkResult } from "../../../../control/coordination-contract.js";
import type { SkillReviewReply } from "../review-process.js";

/** Only the native finish adapter may supply confirmed pending locators.
 * Failure remains failure even when an individual proposal already staged. */
export function skillReviewWorkResult(result: SkillReviewReply): CentralLearningWorkResult {
  const pendingRefs = "pendingIds" in result ? result.pendingIds?.map(id => `hermes-pending:skills:${id}`) : undefined;
  if (result.status === "failed" || result.status === "cancelled") return { kind: result.status, reason: result.error,
    ...(pendingRefs === undefined ? {} : { resultRefs: pendingRefs }) };
  const reviewRef = result.status === "skipped" ? `hermes-review:skipped:${result.reasonCode}`
    : `hermes-review:${result.candidateId}:${result.status}`;
  return { kind: "completed", resultRefs: [reviewRef, ...(pendingRefs ?? [])] };
}
