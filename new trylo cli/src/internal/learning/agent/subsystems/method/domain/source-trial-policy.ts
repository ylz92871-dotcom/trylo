import { METHOD_INFERENCE_POLICY } from "./inference.js";
import { isCompilationApplied } from "./compilation-review.js";
import type { ExperienceSource } from "./experience-state.js";
import type { ScopeHypothesis } from "./scope-learning.js";

/** Research-derived, invalid or recently withdrawn sources require explicit,
 * matched trials. Research contributes no qualification; the original accepted
 * later compilation still restores ordinary eligibility. */
export function sourceNeedsDeliberateTrial(source: ExperienceSource, scope: ScopeHypothesis): boolean {
  let deliberate = source.versions.some(item => item.versionId === scope.versionId && item.researchDerived === true);

  for (const fact of source.facts) {
    if (fact.versionId !== scope.versionId) continue;
    if (fact.kind === "exit" && fact.mode === "stable" && (fact.scopeId === undefined || fact.scopeId === scope.scopeId)) deliberate = true;
    if (fact.kind !== "review" || fact.scopeId !== scope.scopeId) continue;
    if (fact.review.decision === "core_invalid" || fact.review.decision === "behavior") deliberate = true;
    else if (fact.review.score >= METHOD_INFERENCE_POLICY.modelThreshold && isCompilationApplied(source.facts, fact)) deliberate = false;
  }

  return deliberate;
}
