import type { ExperienceReview } from "../experience-port.js";

/** Strict admission for newly generated reviews. Historical compact records
 * keep their read grammar; new model ports cannot opt into that compatibility. */
export function newReviewError(review: ExperienceReview, sourceHint: string): string | undefined {
  if (new Set(review.sources).size !== review.sources.length) return "method_review_sources_repeated";

  const scopeIds = review.scopes?.map(scope => scope.scopeId) ?? [];
  if (new Set(scopeIds).size !== scopeIds.length) return "method_review_scopes_repeated";

  const compiling = review.decision === "promote" || review.decision === "expression" ||
    review.decision === "narrow" && (review.compact !== undefined || review.procedure !== undefined);
  if (compiling && (review.compact === undefined || review.procedure === undefined)) return "method_review_procedure_required";

  if (review.decision === "behavior" && (review.revisedMethod === undefined ||
    review.revisedMethod.trim().length === 0 || review.revisedMethod.trim() === sourceHint.trim())) return "behavior_revision_unchanged";

  return undefined;
}
