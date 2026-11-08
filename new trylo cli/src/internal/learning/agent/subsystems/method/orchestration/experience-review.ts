import { shortId } from "../../../../domains/shared/hash.js";
import { isExperienceReview, MAX_METHOD_EVIDENCE_REVISIONS, MAX_METHOD_EXPERIENCE_FACTS } from "../domain/experience-facts.js";
import { compatibleExperienceScope, effectivePredicate, epochOf, matureReview, projectMaturity, scopesOf, shouldExitScope, snapshotOf, scopeEnabled, type ScopeFact, type ReviewFact } from "../domain/experience-state.js";
import { METHOD_INFERENCE_POLICY } from "../domain/inference.js";
import type { ScopeHypothesis } from "../domain/scope-learning.js";
import type { ExperienceRelatedSource, ExperienceReviewRequest } from "../experience-port.js";
import { ExperienceModelError } from "../experience-port.js";
import type { ExperienceRuntimeOptions, ExperienceView } from "./experience-runtime.js";
import { applyReviewEffects, resumeReviewEffects } from "./experience-effects.js";
import { canonicalObservations, type MethodObservation } from "../domain/inference-observations.js";
import { compilationEvidenceOf, observationRevisionKey, reviewTriggerOf, type CompilationEvidence, type CompilationReviewTrigger } from "../domain/compilation-evidence.js";
import { isCompilationApplied } from "../domain/compilation-review.js";
import { knownCounterexamplesOf, sourceReviewProgress } from "../domain/review-progress.js";
import { adoptionCoverageOf } from "../domain/adoption-coverage.js";
import { procedureEvidenceError } from "../domain/procedure.js";
import { newReviewError } from "../domain/review-admission.js";
import { compilationRepairRequired } from "../domain/recompile-policy.js";
import { MAX_SCOPE_CAPTION_CHARS, scopeCaption } from "../domain/scope-description.js";

/** Feedback stays cheap; at most one newly eligible snapshot receives a funded review. */
export async function reviewExperiences(options: ExperienceRuntimeOptions, initial: ExperienceView, signal: AbortSignal,
  target?: { readonly versionId: string; readonly scopeId: string }): Promise<void> {
  if (signal.aborted || initial.facts.length >= MAX_METHOD_EXPERIENCE_FACTS) return;

  let view = await resumeReviewEffects(options, initial, signal);

  view = await withdrawUnreliablePractices(options, view);

  if (options.model === undefined || signal.aborted) return;

  for (const scope of scopesOf(view)) {
    if (target !== undefined && (scope.versionId !== target.versionId || scope.hypothesis.scopeId !== target.scopeId)) continue;

    const material = reviewMaterialFor(options, view, scope);
    if (material === undefined) continue;

    const { snapshot, monitor, priorCompilation, progress } = material;
    const request = requestFor(view, material, options.centralSourceContext);
    const relatedSources = request.relatedSources ?? [];
    const review = await reviewIfAvailable(options, request, signal);
    if (review === undefined) continue;

    if (signal.aborted) return;

    if (!isExperienceReview(review)) throw new Error("invalid_method_review");

    const admissionError = newReviewError(review, request.method);
    if (admissionError !== undefined) throw new Error(admissionError);

    if (review.procedure !== undefined) {
      const evidenceError = procedureEvidenceError(review.procedure, request.observations);
      if (evidenceError !== undefined) throw new Error(evidenceError);
    }

    const usedRelated = review.sources.filter(versionId => versionId !== scope.versionId).map(versionId => {
      const material = relatedSources.find(item => item.versionId === versionId);
      if (material === undefined) throw new Error("method_review_source_not_supplied");
      return { versionId, scopeId: material.scope.scopeId, compilationId: material.compilationId,
        snapshotId: material.qualificationSnapshotId, evidenceRevisions: material.qualificationEvidenceRevisions };
    });

    view = await options.store.append(current => ({ kind: "review", factId: shortId("method-review", [snapshot.snapshotId]),
      versionId: scope.versionId, sequence: current.sequence + 1, scopeId: scope.hypothesis.scopeId,
      snapshotId: snapshot.snapshotId, evidenceRevisions: snapshot.revisions, review,
      contextKey: snapshot.contextKey,
      knownCounterexampleRevisions: progress.knownCounterexampleRevisions,
      ...(monitor === undefined || priorCompilation === undefined ? {} : {
        reconsideration: { compilationId: priorCompilation.factId,
          evidenceRevisions: monitor.evidence.observations.map(observationRevisionKey),
          semanticRevisions: (monitor.semanticObservations ?? monitor.evidence.observations).map(observationRevisionKey) } }),
      ...(usedRelated.length === 0 ? {} : { relatedBindings: usedRelated }) }));
    options.emit("observation", { component: "method_review", versionId: scope.versionId, decision: review.decision,
      algorithmConfidence: snapshot.posterior.confidence, modelScore: review.score });
    const recorded = view.facts.find(item => item.kind === "review" && item.snapshotId === snapshot.snapshotId);
    if (recorded?.kind === "review") await applyReviewEffects(options, view, recorded, signal);

    return;
  }
}

/** Central dispatch must establish current eligibility before claiming a funded source. */
export function pendingExperienceReview(options: ExperienceRuntimeOptions, view: ExperienceView,
  target: { readonly versionId: string; readonly scopeId: string }): ExperienceReviewRequest | undefined {
  const scope = scopesOf(view).find(item => item.versionId === target.versionId && item.hypothesis.scopeId === target.scopeId);
  const material = scope === undefined ? undefined : reviewMaterialFor(options, view, scope);
  return material === undefined ? undefined : requestFor(view, material, options.centralSourceContext);
}

function reviewMaterialFor(options: ExperienceRuntimeOptions, view: ExperienceView, scope: ScopeFact): ReviewMaterial | undefined {
  const variant = view.variants.find(item => item.versionId === scope.versionId);
  if (variant === undefined || variant.retention === "evicted" || variant.ledger.state === "archived" || !scopeEnabled(view, scope.hypothesis)) return undefined;

  const snapshot = snapshotOf(view, scope.hypothesis), mature = matureReview(view, scope.hypothesis);
  if (view.facts.some(item => item.kind === "review" && item.snapshotId === snapshot.snapshotId)) return undefined;

  const priorCompilation = mature ?? lastKnownCompilation(view, scope.versionId, scope.hypothesis.scopeId);
  const monitor = priorCompilation === undefined ? undefined : compilationEvidenceOf(view.observations, {
    scope: scope.hypothesis, compilationId: priorCompilation.factId, compiledSequence: priorCompilation.sequence });
  const progress = sourceReviewProgress(view, scope.hypothesis, snapshot.evidence,
    epochOf(view, scope.versionId, scope.hypothesis.scopeId), priorCompilation, snapshot);
  if (snapshot.revisions.length > MAX_METHOD_EVIDENCE_REVISIONS || (monitor?.evidence.observations.length ?? 0) > MAX_METHOD_EVIDENCE_REVISIONS ||
    (monitor?.semanticObservations?.length ?? 0) > MAX_METHOD_EVIDENCE_REVISIONS ||
    progress.knownCounterexampleRevisions.length > MAX_METHOD_EVIDENCE_REVISIONS) {
    options.emit("observation", { component: "method_review_deferred", versionId: scope.versionId, reason: "method_evidence_capacity" });
    return undefined;
  }

  const history = compiledReviewHistory(view, priorCompilation);
  const trigger = monitor === undefined ? undefined : reviewTriggerOf(monitor, history.considered, history.checkpoint);
  const block = [...view.facts].reverse().find(item => item.kind === "decision" && item.versionId === scope.versionId &&
    item.decision.scopeId === scope.hypothesis.scopeId && item.decision.action === "block");
  const repaired = block !== undefined && view.facts.some(item => item.kind === "review" && item.versionId === scope.versionId &&
    item.scopeId === scope.hypothesis.scopeId && item.sequence > block.sequence && item.review.decision !== "defer");
  const repair = repaired ? undefined : block;
  // A source epoch restarts qualification, not whether M already saw a block.
  const newBlock = repair !== undefined && !view.facts.some(fact => fact.kind === "review" &&
    fact.versionId === scope.versionId && fact.scopeId === scope.hypothesis.scopeId && fact.sequence > repair.sequence);
  const reconsider = newBlock || trigger !== undefined && trigger.reason !== "none" ||
    (progress.newCounterexample && (priorCompilation !== undefined || progress.previouslyReviewed));
  if (!reconsider && (mature !== undefined || snapshot.posterior.confidence < METHOD_INFERENCE_POLICY.algorithmThreshold ||
    !progress.ordinaryReviewReady)) return undefined;

  return { scope, snapshot, mature, priorCompilation, monitor, trigger, repair, variant, progress };
}

/** Older reviews may lack a compiled checkpoint. Do not manufacture its counts
 * from source evidence; one fresh review establishes the richer checkpoint. */
function compiledReviewHistory(view: ExperienceView, compilation: ReviewFact | undefined) {
  const reviews = view.facts.filter((fact): fact is ReviewFact => fact.kind === "review" && compilation !== undefined &&
    fact.reconsideration?.compilationId === compilation.factId);
  const considered = reviews.flatMap(fact => [...fact.reconsideration!.evidenceRevisions,
    ...(fact.reconsideration!.semanticRevisions ?? []), ...(fact.knownCounterexampleRevisions ?? [])]);
  const latest = reviews.at(-1);

  return { considered, checkpoint: latest === undefined ? undefined : {
    decision: latest.review.decision, evidenceRevisions: latest.reconsideration!.evidenceRevisions } };
}

async function reviewIfAvailable(options: ExperienceRuntimeOptions, request: ExperienceReviewRequest, signal: AbortSignal) {
  try { return await options.model!.review(request, signal); }
  catch (error) {
    if (error instanceof ExperienceModelError && error.disposition === "unavailable") {
      options.emit("observation", { component: "method_review_deferred", versionId: request.versionId, scopeId: request.scope.scopeId,
        reason: error.reason });
      return undefined;
    }
    throw error;
  }
}

async function withdrawUnreliablePractices(options: ExperienceRuntimeOptions, initial: ExperienceView): Promise<ExperienceView> {
  let view = initial;

  for (const scope of scopesOf(view)) {
    const variant = view.variants.find(item => item.versionId === scope.versionId);
    if (!scopeEnabled(view, scope.hypothesis) || variant === undefined || variant.retention === "evicted" || variant.ledger.state === "archived") continue;

    const mature = matureReview(view, scope.hypothesis);
    const obsolete = changedCompilationProof(view, scope, mature);
    const sourceExit = shouldExitScope(view, scope.hypothesis);
    const compilationExit = mature === undefined ? false : compilationEvidenceOf(view.observations, {
      scope: scope.hypothesis, compilationId: mature.factId, compiledSequence: mature.sequence }).recent.shouldExit;
    const withdrawn = compilationExit ? mature : obsolete;
    const reason = sourceExit ? "recent_feedback_change" : obsolete === undefined ? "compiled_feedback_decline" : "compilation_proof_changed";

    // Failed source practice can require deliberate trials even before its
    // first compilation. Exit resets this scope's prospective source epoch.
    if (sourceExit) {
      view = await options.store.append(current => ({ kind: "exit", factId: shortId("method-exit", [scope.versionId,
        scope.hypothesis.scopeId, String(current.sequence)]), versionId: scope.versionId, sequence: current.sequence + 1,
        scopeId: scope.hypothesis.scopeId, mode: "stable", reason: "recent_feedback_change" }));
    } else if (withdrawn !== undefined) {
      view = await options.store.append(current => ({
        kind: "compilation_exit", factId: shortId("method-compilation-exit", [withdrawn.factId]), versionId: scope.versionId,
        sequence: current.sequence + 1, scopeId: scope.hypothesis.scopeId, compilationId: withdrawn.factId, reason }));
    } else continue;

    options.emit("observation", { component: "method_exit", versionId: scope.versionId, reason });
  }

  return view;
}

/** Make a changed qualification proof an explicit, reversible withdrawal.
 * Pending replacement effects and deliberate exits have their own causes;
 * mere absence of maturity is insufficient to diagnose changed evidence. */
function changedCompilationProof(view: ExperienceView, scope: ScopeFact, mature: ReviewFact | undefined): ReviewFact | undefined {
  if (mature !== undefined) return undefined;

  const prior = lastKnownCompilation(view, scope.versionId, scope.hypothesis.scopeId);
  if (prior === undefined || epochOf(view, scope.versionId, scope.hypothesis.scopeId) > prior.sequence ||
    view.facts.some(fact => fact.kind === "compilation_exit" && fact.compilationId === prior.factId ||
      fact.kind === "review" && fact.versionId === scope.versionId && fact.scopeId === scope.hypothesis.scopeId &&
      fact.sequence > prior.sequence && fact.review.decision !== "defer")) return undefined;

  const revisions = new Set(canonicalObservations(view.observations).map(observationRevisionKey));
  if (prior.evidenceRevisions.some(key => !revisions.has(key))) return prior;

  const maturity = projectMaturity(view);
  const changedDependency = (prior.relatedBindings ?? []).some(binding => {
    const related = scopesOf(view, binding.versionId).find(item => item.hypothesis.scopeId === binding.scopeId)?.hypothesis;
    const current = related === undefined ? undefined : maturity(related);
    return current?.factId !== binding.compilationId || current.snapshotId !== binding.snapshotId;
  });

  return changedDependency ? prior : undefined;
}

type ReviewMaterial = {
  readonly progress: ReturnType<typeof sourceReviewProgress>;
  readonly scope: ScopeFact; readonly snapshot: ReturnType<typeof snapshotOf>;
  readonly mature: ReviewFact | undefined; readonly priorCompilation: ReviewFact | undefined;
  readonly monitor: CompilationEvidence | undefined; readonly trigger: CompilationReviewTrigger | undefined;
  readonly repair: import("../domain/experience-facts.js").MethodExperienceFact | undefined;
  readonly variant: ExperienceView["variants"][number];
};

function requestFor(view: ExperienceView, input: ReviewMaterial, centralSourceContext?: ExperienceReviewRequest["centralSourceContext"]): ExperienceReviewRequest {
  const { scope, snapshot, mature, priorCompilation, monitor, trigger, repair, variant, progress } = input;
  const relatedSources = relatedSourcesFor(view, scope.hypothesis);
  const negatives = knownCounterexamplesOf(view, scope.versionId);
  const shownNegatives = negatives.slice(-12);
  const observations = representativeObservations(snapshot.evidence.observations);
  const previous = progress.latestReview;

  return { snapshotId: snapshot.snapshotId, versionId: scope.versionId,
      ...(centralSourceContext === undefined ? {} : { centralSourceContext: { ref: centralSourceContext.ref,
        text: "Public source analysis only: unverified hypotheses, not independent observations, verification or authorization.\n" + centralSourceContext.text } }),
      scope: scope.hypothesis, effectivePredicate: effectivePredicate(view, scope.hypothesis),
      method: variant.card.hint, confidence: snapshot.posterior.confidence,
      adoptionCoverage: adoptionCoverageOf(view, scope.hypothesis, { sinceSequence: epochOf(view, scope.versionId, scope.hypothesis.scopeId) }),
      observations,
      executionTraces: relevantExecutionTraces(view, scope.versionId),
      counterexamples: shownNegatives.map(item => JSON.stringify(item)), experiences: experiencedContexts(view,
        snapshot.evidence.observations, monitor?.evidence.observations.filter(item => item.outcome === "unhelpful") ?? []),
      evidenceSummary: { successes: snapshot.evidence.successes, failures: snapshot.evidence.failures,
        omittedKnownObservations: snapshot.evidence.observations.length - observations.length, knownCounterexamples: negatives.length,
        omittedCounterexamples: negatives.length - shownNegatives.length },
      ...(relatedSources.length === 0 ? {} : { relatedSources }),
      ...(previous === undefined ? {} : { previousAssessment: { reviewId: previous.factId, snapshotId: previous.snapshotId,
        decision: previous.review.decision, score: previous.review.score,
        reason: scopeCaption(previous.review.reason, MAX_SCOPE_CAPTION_CHARS), excerpted: previous.review.reason.length > MAX_SCOPE_CAPTION_CHARS } }),
      ...(priorCompilation?.review.compact === undefined ? {} : { currentCompilation: {
        compilationId: priorCompilation.factId, compact: priorCompilation.review.compact,
        repairRequired: compilationRepairRequired(view, scope.hypothesis, priorCompilation),
        sources: priorCompilation.review.sources,
        ...(monitor === undefined ? {} : { empirical: { successes: monitor.evidence.successes,
          failures: monitor.evidence.failures, confidence: monitor.posterior.confidence,
          adoptionCoverage: adoptionCoverageOf(view, scope.hypothesis, { sinceSequence: priorCompilation.sequence,
            executionBasis: { kind: "compilation", compilationId: priorCompilation.factId } }) } }),
        ...(progress.reentry === undefined ? {} : { reentry: { afterSequence: progress.reentry.afterSequence,
          successes: progress.reentry.evidence.successes, failures: progress.reentry.evidence.failures, confidence: progress.reentry.confidence } }),
        ...(priorCompilation.review.procedure === undefined ? {} : { procedure: priorCompilation.review.procedure }), withdrawn: mature === undefined } }),
      ...(monitor === undefined || trigger === undefined || trigger.reason === "none" || priorCompilation === undefined ? {} : {
        reconsideration: { compilationId: priorCompilation.factId, reason: trigger.reason,
          evidenceRevisions: monitor.evidence.observations.map(observationRevisionKey),
          observations: compiledReviewObservations(monitor, trigger), confidence: monitor.posterior.confidence,
          changeProbability: monitor.change.status === "insufficient" ? 0 : monitor.change.changePosterior } }),
      ...(repair?.kind === "decision" ? { repair: repair.decision } : {}) };
}

function compiledReviewObservations(monitor: CompilationEvidence, trigger: CompilationReviewTrigger): readonly MethodObservation[] {
  const semantic = monitor.semanticObservations ?? monitor.evidence.observations;
  const ids = new Set(trigger.observationIds);
  return [...new Map([...semantic.filter(item => ids.has(item.observationId)), ...semantic.slice(-12)]
    .map(item => [item.observationId, item])).values()].slice(0, 12);
}

function representativeObservations(observations: readonly MethodObservation[]): readonly MethodObservation[] {
  if (observations.length <= 12) return observations;
  const positions = new Set([0, Math.floor(observations.length / 2),
    ...Array.from({ length: 10 }, (_value, index) => observations.length - 10 + index)]);
  return [...positions].sort((a, b) => a - b).map(index => observations[index]!);
}

function relevantExecutionTraces(view: ExperienceView, versionId: string) {
  return view.facts.flatMap(fact => fact.kind === "execution" && fact.versionId === versionId ? [fact.trace] : []).slice(-8);
}

function lastKnownCompilation(view: ExperienceView, versionId: string, scopeId: string): ReviewFact | undefined {
  return [...view.facts].reverse().find((item): item is ReviewFact => item.kind === "review" &&
    item.versionId === versionId && item.scopeId === scopeId && item.review.score >= METHOD_INFERENCE_POLICY.modelThreshold &&
    isCompilationApplied(view.facts, item));
}

function experiencedContexts(view: ExperienceView, observations: readonly MethodObservation[], negatives: readonly MethodObservation[]) {
  const indices = new Set([0, Math.floor(observations.length / 2), observations.length - 1]);
  const representatives = [...indices].flatMap(index => observations[index] === undefined ? [] : [observations[index]!]);
  const selected = new Map([...representatives, ...negatives.slice(-3)].map(item => [item.observationId, item]));

  return [...selected.values()].flatMap(observation => {
    const adopted = view.facts.find(item => item.kind === "decision" && item.versionId === observation.versionId &&
      item.context.taskId === observation.taskId && item.context.opportunityId === observation.opportunityId && item.decision.action === "adopt" &&
      item.decision.compilationId === observation.compilationId);
    const blocked = [...view.facts].reverse().find(item => item.kind === "decision" && item.versionId === observation.versionId &&
      item.context.taskId === observation.taskId && item.context.opportunityId === observation.opportunityId && item.decision.action === "block" &&
      item.decision.compilationId === observation.compilationId);

    return adopted?.kind !== "decision" ? [] : [{ observationId: observation.observationId,
      situation: adopted.context.situation.slice(0, 160), adoptionReason: adopted.decision.reason.slice(0, 80),
      excerpted: adopted.context.situation.length > 160 || adopted.decision.reason.length > 80 ||
        (blocked?.kind === "decision" && (blocked.decision.reason.length > 160 || (blocked.decision.facts?.length ?? 0) > 240)),
      ...(blocked?.kind !== "decision" ? {} : { blocking: { reason: blocked.decision.reason.slice(0, 160),
        ...(blocked.decision.step === undefined ? {} : { step: blocked.decision.step.slice(0, 80) }),
        ...(blocked.decision.facts === undefined ? {} : { facts: blocked.decision.facts.slice(0, 240) }) } }) }];
  });
}

/** No full-library bodies or pooled evidence: omit a large source rather than truncate its conditions or qualification identity. */
function relatedSourcesFor(view: ExperienceView, target: ScopeHypothesis): readonly ExperienceRelatedSource[] {
  const selected: ExperienceRelatedSource[] = [], seen = new Set<string>();
  const maturity = projectMaturity(view);
  let chars = 2;

  for (const source of scopesOf(view)) {
    if (source.versionId === target.versionId || seen.has(source.versionId) ||
      !compatibleExperienceScope(view, target, source.hypothesis)) continue;

    const mature = maturity(source.hypothesis), variant = view.variants.find(item => item.versionId === source.versionId);
    if (mature?.review.compact === undefined || mature.review.sources.includes(target.versionId) || variant === undefined) continue;

    const snapshot = snapshotOf(view, source.hypothesis), evidence = snapshot.evidence;
    const compiled = compilationEvidenceOf(view.observations.filter(item => item.versionId === source.versionId),
      { scope: source.hypothesis, compilationId: mature.factId, compiledSequence: mature.sequence });
    const observationIds = evidence.observationIds.slice(-6);
    const material: ExperienceRelatedSource = { versionId: source.versionId, scope: source.hypothesis,
      effectivePredicate: effectivePredicate(view, source.hypothesis), compilationId: mature.factId,
      qualificationSnapshotId: mature.snapshotId, qualificationEvidenceRevisions: mature.evidenceRevisions,
      compiledEvidence: { successes: compiled.evidence.successes, failures: compiled.evidence.failures,
        confidence: compiled.posterior.confidence, adoptionCoverage: adoptionCoverageOf(view, source.hypothesis,
          { sinceSequence: mature.sequence, executionBasis: { kind: "compilation", compilationId: mature.factId } }) },
      currentSnapshotId: snapshot.snapshotId, confidence: snapshot.posterior.confidence, compact: mature.review.compact,
      ...(mature.review.procedure === undefined ? {} : { procedure: mature.review.procedure }),
      summary: { method: variant.card.hint, judgment: mature.review.reason.slice(0, 240) },
      evidence: { successes: evidence.successes, failures: evidence.failures, unknown: evidence.unknown,
        externalFailures: evidence.externalFailures, notAdopted: evidence.notAdopted, observationIds,
        omittedObservationIds: evidence.observationIds.length - observationIds.length } };
    const size = JSON.stringify(material).length + 1;
    if (chars + size > 4000) continue;

    selected.push(material);
    seen.add(source.versionId);
    chars += size;

    if (selected.length === 3) break;
  }

  return selected;
}
