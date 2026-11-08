import { changeDetectionOf, type BayesianChangeSignal } from "./change-detection.js";
import { canonicalObservations, type EvidenceSummary, type MethodObservation } from "./inference-observations.js";
import { posteriorOf, recentPosteriorOf, type BetaPosterior, type BinaryCounts } from "./inference.js";
import { matchesScope, scopeEvidenceOf, type ScopeHypothesis } from "./scope-learning.js";
import { reviewInformationOf } from "./review-information.js";
import type { ExperienceReview } from "../experience-port.js";

export type CompilationEvidence = {
  readonly evidence: EvidenceSummary;
  /** Evidence about this compiled expression only. Source qualification is not its prior. */
  readonly posterior: BetaPosterior;
  readonly recent: ReturnType<typeof recentPosteriorOf>;
  readonly change: BayesianChangeSignal;
  /** Includes dependent testimony for semantic repair, never for Beta/KL. */
  readonly semanticObservations?: readonly MethodObservation[];
};

export type CompilationReviewTrigger = {
  readonly reason: "none" | "counterexample" | "pattern_change" | "evidence_change";
  readonly observationIds: readonly string[];
};

export type CompilationReviewCheckpoint = {
  readonly decision: ExperienceReview["decision"];
  /** Exact independent compiled cohort considered by this review. */
  readonly evidenceRevisions: readonly string[];
};

/** Source A permits semantic compilation and a guarded trial. It is never
 * transferred as synthetic successes: changed wording can change execution
 * and selection. Each compilation starts with its own Beta(1,1) evidence. */
export function compilationEvidenceOf(input: readonly MethodObservation[], selection: {
  readonly scope: ScopeHypothesis;
  readonly compilationId: string;
  readonly compiledSequence: number;
  readonly source?: MethodObservation["source"];
}): CompilationEvidence {
  if (selection.compilationId.trim().length === 0 || selection.compilationId.length > 200 ||
    !Number.isSafeInteger(selection.compiledSequence) || selection.compiledSequence < 0) throw new RangeError("invalid_compilation_selection");

  const executionBasis = { kind: "compilation" as const, compilationId: selection.compilationId };
  const evidence = scopeEvidenceOf(selection.scope, input, { sinceSequence: selection.compiledSequence,
    executionBasis, ...(selection.source === undefined ? {} : { source: selection.source }) });
  const posterior = posteriorOf(evidence);
  const recent = recentPosteriorOf(evidence.observations, { versionId: selection.scope.versionId, executionBasis,
    ...(selection.source === undefined ? {} : { source: selection.source }) });
  const semanticObservations = canonicalObservations(input.filter(item => item.versionId === selection.scope.versionId))
    .filter(item => item.compilationId === selection.compilationId && item.adoption === "adopted" &&
      item.source === (selection.source ?? "self_report") &&
      // Actual post-compilation delivery can inform semantics even when this
      // parent began earlier and is ineligible for a new Bernoulli trial.
      (item.opportunitySequence ?? item.sequence) > Math.max(selection.compiledSequence, selection.scope.proposedSequence) &&
      matchesScope(selection.scope.predicate, item.features));

  return { evidence, posterior, recent, change: changeDetectionOf(evidence.observations), semanticObservations };
}

/** First counterexamples, revised testimony and concrete practice reports can
 * matter before a statistical alarm. After this exact compilation was deferred,
 * another bare false needs information about a lower rate or a directed shift.
 * Report presence is not a semantic novelty classifier. */
export function reviewTriggerOf(monitor: CompilationEvidence, consideredRevisions: readonly string[],
  checkpoint?: CompilationReviewCheckpoint): CompilationReviewTrigger {
  const considered = new Set(consideredRevisions);
  const semantic = monitor.semanticObservations ?? monitor.evidence.observations;
  const novel = semantic.filter(item => !considered.has(observationRevisionKey(item)));
  const revised = novel.filter(item => item.revision > 0);
  if (revised.length > 0) return trigger("evidence_change", revised);

  const counterexamples = novel.filter(item => item.outcome === "unhelpful");
  const firstCounterexample = !semantic.some(item => item.outcome === "unhelpful" && considered.has(observationRevisionKey(item)));
  if (counterexamples.length > 0 && (firstCounterexample || checkpoint?.decision !== "defer" ||
    counterexamples.some(item => item.application !== undefined))) return trigger("counterexample", counterexamples);

  const independent = monitor.evidence.observations.filter(item => !considered.has(observationRevisionKey(item)));
  if (independent.length > 0 && monitor.change.status === "reconsider") return trigger("pattern_change", independent);

  if (counterexamples.length > 0 && checkpoint?.decision === "defer") {
    const previous = countsAtCheckpoint(monitor.evidence.observations, checkpoint.evidenceRevisions);
    // A missing/revised marker cannot be silently reconstructed as old data.
    if (previous === undefined) return trigger("evidence_change", counterexamples);
    if (monitor.posterior.mean < posteriorOf(previous).mean &&
      reviewInformationOf(previous, monitor.evidence).sufficient) return trigger("counterexample", counterexamples);
  }

  return { reason: "none", observationIds: [] };
}

function trigger(reason: Exclude<CompilationReviewTrigger["reason"], "none">,
  observations: readonly MethodObservation[]): CompilationReviewTrigger {
  return { reason, observationIds: observations.map(item => item.observationId) };
}

function countsAtCheckpoint(observations: readonly MethodObservation[], markers: readonly string[]): BinaryCounts | undefined {
  if (new Set(markers).size !== markers.length) return undefined;

  const current = new Map(observations.map(item => [observationRevisionKey(item), item]));
  let successes = 0;

  for (const marker of markers) {
    const observation = current.get(marker);
    if (observation === undefined) return undefined;
    if (observation.outcome === "helped") successes += 1;
  }

  return { successes, failures: markers.length - successes };
}

export function observationRevisionKey(observation: Pick<MethodObservation, "observationId" | "revision">): string {
  return `${observation.observationId}:${observation.revision}`;
}
