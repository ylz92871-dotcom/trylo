import { canonicalObservations, type EvidenceSummary, type MethodObservation } from "./inference-observations.js";
import { METHOD_INFERENCE_POLICY, posteriorOf, type BinaryCounts } from "./inference.js";
import { matchesScope, scopeEvidenceOf, type ScopeHypothesis } from "./scope-learning.js";
import type { ExperienceSource, ReviewFact } from "./experience-state.js";
import { observationRevisionKey } from "./compilation-evidence.js";
import { reviewInformationOf } from "./review-information.js";

export type ReentryQualification = { readonly afterSequence: number; readonly evidence: EvidenceSummary;
  readonly confidence: number };

/** Requalification costs new independent source uses after a real withdrawal;
 * a new review id alone cannot give an unchanged expression a fresh start. */
export function reentryQualificationOf(source: ExperienceSource, scope: ScopeHypothesis,
  compilation: ReviewFact | undefined): ReentryQualification | undefined {
  if (compilation === undefined) return undefined;

  const withdrawals = source.facts.filter(fact => fact.sequence > compilation.sequence &&
    (fact.kind === "compilation_exit" && fact.compilationId === compilation.factId ||
      fact.kind === "exit" && fact.versionId === scope.versionId && fact.mode === "stable" &&
      (fact.scopeId === undefined || fact.scopeId === scope.scopeId)));
  if (withdrawals.length === 0) return undefined;

  const afterSequence = Math.max(...withdrawals.map(fact => fact.sequence));
  const evidence = scopeEvidenceOf(scope, source.observations, { sinceSequence: afterSequence });

  return { afterSequence, evidence, confidence: posteriorOf(evidence).confidence };
}

export function knownCounterexamplesOf(source: ExperienceSource, versionId: string): readonly MethodObservation[] {
  return canonicalObservations(source.observations.filter(item => item.versionId === versionId))
    .filter(item => item.adoption === "adopted" && item.outcome === "unhelpful");
}

/** Statistical independence controls A; an actual dependent counterexample can
 * still matter semantically. It receives no synthetic Bernoulli trial. */
export function sourceReviewProgress(source: ExperienceSource, scope: ScopeHypothesis, evidence: EvidenceSummary,
  epoch: number, compilation: ReviewFact | undefined, identity: { readonly contextKey: string; readonly snapshotId: string }): {
    readonly newCounterexample: boolean; readonly ordinaryReviewReady: boolean; readonly previouslyReviewed: boolean;
    readonly latestReview: ReviewFact | undefined;
    readonly reentry: ReentryQualification | undefined; readonly knownCounterexampleRevisions: readonly string[];
  } {
  const latest = [...source.facts].reverse().find((fact): fact is ReviewFact => fact.kind === "review" &&
    fact.versionId === scope.versionId && fact.scopeId === scope.scopeId && fact.sequence > epoch);
  const known = new Set(latest?.knownCounterexampleRevisions ?? latest?.evidenceRevisions ?? []);
  const negatives = knownCounterexamplesOf(source, scope.versionId);
  const newCounterexample = negatives.some(item => !known.has(observationRevisionKey(item)) &&
    // A real post-boundary use may expose a semantic defect even when its
    // older parent origin cannot supply a prospective Bernoulli trial.
    (item.opportunitySequence ?? item.sequence) > Math.max(epoch, scope.proposedSequence) && matchesScope(scope.predicate, item.features) &&
    item.compilationId === undefined);
  const reentry = reentryQualificationOf(source, scope, compilation);
  const currentRevisions = new Set(evidence.observations.map(observationRevisionKey));
  const contextChanged = latest !== undefined && (latest.contextKey === undefined ?
    latest.snapshotId !== identity.snapshotId && latest.evidenceRevisions.length === currentRevisions.size &&
      latest.evidenceRevisions.every(key => currentRevisions.has(key)) : latest.contextKey !== identity.contextKey);
  const ordinaryReviewReady = latest === undefined || latest.review.decision !== "defer" || newCounterexample || contextChanged ||
    sourceChangedEnough(evidence, latest, reentry);

  return { newCounterexample, ordinaryReviewReady, previouslyReviewed: latest !== undefined, latestReview: latest, reentry,
    knownCounterexampleRevisions: negatives.map(observationRevisionKey) };
}

function sourceChangedEnough(evidence: EvidenceSummary, previous: ReviewFact,
  reentry: ReentryQualification | undefined): boolean {
  const current = new Map(evidence.observations.map(item => [observationRevisionKey(item), item]));

  // A correction is substantive information, even when the outcome totals
  // happen to match. It cannot be hidden by a scalar divergence threshold.
  if (previous.evidenceRevisions.some(key => !current.has(key))) return true;

  const old = previous.evidenceRevisions.map(key => current.get(key)!);
  if (reentry !== undefined && reentry.confidence >= METHOD_INFERENCE_POLICY.algorithmThreshold &&
    posteriorOf(countsOf(old.filter(item => item.sequence > reentry.afterSequence))).confidence < METHOD_INFERENCE_POLICY.algorithmThreshold) return true;

  return reviewInformationOf(countsOf(old), evidence).sufficient;
}

function countsOf(observations: readonly MethodObservation[]): BinaryCounts {
  const successes = observations.filter(item => item.outcome === "helped").length;
  return { successes, failures: observations.length - successes };
}
