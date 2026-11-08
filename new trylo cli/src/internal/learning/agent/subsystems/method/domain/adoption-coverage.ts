import { canonicalCardJson } from "./contracts.js";
import type { ExperienceSource } from "./experience-state.js";
import { canonicalObservations, type MethodExecutionBasis } from "./inference-observations.js";
import { posteriorOf } from "./inference.js";
import { representativeAdoptionsOf } from "./opportunity-representative.js";
import { matchesScope, scopeEvidenceOf, type ScopeHypothesis } from "./scope-learning.js";

export type AdoptionCoverage = {
  readonly trackedAdoptedOrigins: number;
  readonly trackedKnownReports: number;
  readonly missingKnownOutcome: number;
  /** Historical known reports whose adoption denominator cannot be recovered. */
  readonly untrackedKnownReports: number;
  /** Old unbound reports may have used a former compact expression. */
  readonly legacyExpressionReports: number;
  readonly status: "tracked" | "partial_history";
  /** Completion sensitivity under the same binary model, not imputed data,
   * an MNAR-corrected posterior, or an objective-success guarantee. */
  readonly completionSensitivity: { readonly allMissingUnhelpful: number; readonly allMissingHelped: number };
};

export function adoptionCoverageOf(source: ExperienceSource, scope: ScopeHypothesis, options: {
  readonly sinceSequence?: number; readonly executionBasis?: MethodExecutionBasis;
} = {}): AdoptionCoverage {
  const basis = options.executionBasis ?? { kind: "source" };
  const compilationId = basis.kind === "source" ? undefined : basis.compilationId;
  const since = Math.max(scope.proposedSequence, options.sinceSequence ?? -1);
  const evidence = scopeEvidenceOf(scope, source.observations, options);
  const originSequences = new Map<string, number>();
  const boundContexts = new Set<string>();

  for (const fielding of source.fieldings ?? []) {
    if (fielding.versionId !== scope.versionId) continue;
    originSequences.set(fielding.turnId, Math.min(originSequences.get(fielding.turnId) ?? Number.POSITIVE_INFINITY, fielding.useSequence ?? -1));
    if (fielding.useSequence === undefined) continue;
    if (fielding.binding?.compilationId === compilationId && fielding.binding !== undefined) {
      boundContexts.add(canonicalCardJson(fielding.binding.context));
    }
  }

  const tracked = representativeAdoptionsOf(source.facts, source.sequence + 1).filter(fact =>
    fact.versionId === scope.versionId && fact.decision.compilationId === compilationId &&
    (originSequences.get(fact.context.taskId) ?? -1) > since &&
    boundContexts.has(canonicalCardJson(fact.context)) && matchesScope(scope.predicate, fact.context.features));
  const known = new Set(evidence.observations.map(item => JSON.stringify([item.taskId, item.opportunityId])));
  const trackedKnownReports = tracked.filter(fact => known.has(JSON.stringify([fact.context.taskId, fact.context.opportunityId]))).length;
  const missingKnownOutcome = tracked.length - trackedKnownReports;
  const untrackedKnownReports = evidence.observations.length - trackedKnownReports;
  // Unknown historical outcomes also make coverage incomplete. Looking only at
  // known Bernoulli rows would misleadingly report a complete denominator when
  // the omitted legacy rows were precisely the ones without a known outcome.
  const legacyExpressionReports = basis.kind === "compilation" ? 0 : canonicalObservations(source.observations).filter(item =>
    item.versionId === scope.versionId && item.source === "self_report" && item.adoption === "adopted" &&
    item.sequence > since && item.compilationId === undefined && item.opportunitySequence === undefined &&
    matchesScope(scope.predicate, item.features)).length;

  return { trackedAdoptedOrigins: tracked.length, trackedKnownReports, missingKnownOutcome, untrackedKnownReports,
    legacyExpressionReports, status: untrackedKnownReports === 0 && legacyExpressionReports === 0 ? "tracked" : "partial_history",
    completionSensitivity: {
      allMissingUnhelpful: posteriorOf({ successes: evidence.successes, failures: evidence.failures + missingKnownOutcome }).confidence,
      allMissingHelped: posteriorOf({ successes: evidence.successes + missingKnownOutcome, failures: evidence.failures }).confidence,
    } };
}
