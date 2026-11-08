import { shortId } from "../../../../domains/shared/hash.js";
import { canonicalObservations, type MethodObservation } from "./inference-observations.js";
import { METHOD_INFERENCE_POLICY, posteriorOf, recentPosteriorOf } from "./inference.js";
import { matchesScope, scopeEvidenceOf, scopePosteriorOf, scopePredicateKey, type ScopeHypothesis, type ScopePredicate } from "./scope-learning.js";
import { MAX_METHOD_EXPERIENCE_FACTS, type MethodExperienceFact } from "./experience-facts.js";
import { canonicalCardJson } from "./contracts.js";
import { MAX_HINT_CHARS } from "./contracts.js";
import { scanForbiddenText } from "../../../../domains/shared/forbidden-scan.js";
import type { ExperienceExposureBinding } from "./exposure-binding.js";
import { procedureEvidenceError, procedureTextFields } from "./procedure.js";
import { compilationRepairRequired, compilationRevisionError } from "./recompile-policy.js";
import { compilationEvidenceOf, observationRevisionKey } from "./compilation-evidence.js";
import { isCompilationApplied, isCompilationReview } from "./compilation-review.js";
import { compilationDeliveryError } from "./experience-render.js";
import { knownCounterexamplesOf, reentryQualificationOf } from "./review-progress.js";
import { executionAdoptionFor } from "./execution-trace.js";
import { newReviewError } from "./review-admission.js";
import { adoptionWindowClosed, adoptionWindowFactError } from "./adoption-window.js";
import { archived, effectivePredicate, epochOf, scopeEnabled, scopePermanentlyClosed, scopesOf } from "./scope-state.js";

export { archived, effectivePredicate, epochOf, hasScopeHistory, scopeEnabled, scopesOf } from "./scope-state.js";

export type ExperienceSource = {
  readonly fieldings?: readonly { readonly exposureId?: string; readonly versionId: string; readonly turnId: string;
    readonly scope: string; readonly beat?: number; readonly useSequence?: number; readonly binding?: ExperienceExposureBinding }[];
  readonly sequence: number;
  readonly facts: readonly MethodExperienceFact[];
  readonly observations: readonly MethodObservation[];
  readonly versions: readonly { readonly versionId: string; readonly hint: string; readonly researchDerived?: true }[];
};

export type ScopeFact = Extract<MethodExperienceFact, { kind: "scope" }>;

export type ReviewFact = Extract<MethodExperienceFact, { kind: "review" }>;

type MaturityPolicy = "current" | "legacy_compact";

export function expendableScope(source: ExperienceSource, versionId: string): ScopeFact | undefined {
  return scopesOf(source, versionId).find(scope => scopePermanentlyClosed(source, scope.hypothesis)) ??
    statisticallyExpendableScope(source, versionId);
}

function statisticallyExpendableScope(source: ExperienceSource, versionId: string): ScopeFact | undefined {
  const scopes = scopesOf(source, versionId);
  const updated = scopePosteriorOf(scopes.map(item => item.hypothesis), source.observations);
  if (updated.observationCount < 12) return undefined;

  const losing = [...updated.hypotheses].filter(item => item.posteriorWeight < .05)
    .sort((left, right) => left.posteriorWeight - right.posteriorWeight);

  return losing.flatMap(item => scopes.filter(scope => scope.hypothesis.id === item.hypothesisId &&
    matureReview(source, scope.hypothesis) === undefined))[0];
}

export function compatibleExperienceScope(source: ExperienceSource, left: ScopeHypothesis, right: ScopeHypothesis): boolean {
  return scopePredicateKey(left.predicate) === scopePredicateKey(right.predicate) &&
    scopePredicateKey(effectivePredicate(source, left)) === scopePredicateKey(effectivePredicate(source, right));
}

export function snapshotOf(source: ExperienceSource, scope: ScopeHypothesis) {
  const evidence = scopeEvidenceOf(scope, source.observations, { sinceSequence: epochOf(source, scope.versionId, scope.scopeId) });
  const revisions = evidence.observations.map(item => `${item.observationId}:${item.revision}`);
  const block = [...source.facts].reverse().find(item => item.kind === "decision" && item.versionId === scope.versionId &&
    item.decision.scopeId === scope.scopeId && item.decision.action === "block");
  const predicateKey = scopePredicateKey(scope.predicate), effectiveKey = scopePredicateKey(effectivePredicate(source, scope));
  const originalIdentity = [scope.versionId, scope.id, predicateKey,
    String(epochOf(source, scope.versionId, scope.scopeId)), block?.factId ?? "", ...evidence.observations.map(item => canonicalCardJson(item))];
  const legacySnapshotId = shortId("method-snapshot", originalIdentity);
  const generation = [...(effectiveKey === predicateKey ? [] : [effectiveKey]),
    ...source.facts.filter(item => item.kind === "compilation_exit" && item.versionId === scope.versionId && item.scopeId === scope.scopeId)
      .map(item => item.factId), ...dependencyGeneration(source, scope)];
  const contextKey = shortId("method-review-context", [scope.versionId, scope.id, predicateKey,
    String(epochOf(source, scope.versionId, scope.scopeId)), block?.factId ?? "", ...generation]);
  const snapshotId = shortId("method-snapshot", [...originalIdentity, ...generation,
    ...knownCounterexamplesOf(source, scope.versionId).map(item => canonicalCardJson(item)),
    // Compilation reports influence what is reviewed, never the source A.
    ...canonicalObservations(source.observations.filter(item => item.versionId === scope.versionId)).filter(item =>
      item.compilationId !== undefined && matchesScope(scope.predicate, item.features)).map(item => canonicalCardJson(item))]);

  return { evidence, revisions, snapshotId, legacySnapshotId, contextKey, posterior: posteriorOf(evidence) };
}

export function matureReview(source: ExperienceSource, scope: ScopeHypothesis): ReviewFact | undefined {
  return maturityUnder(source, scope, "current");
}

export type MaturityProjection = (scope: ScopeHypothesis) => ReviewFact | undefined;

type MaturityContext = {
  readonly policy: MaturityPolicy; readonly visiting: Set<string>;
  readonly memo: Map<string, ReviewFact | undefined>; readonly revisions: ReadonlySet<string>;
};

/** A request-local read projection over one immutable Board generation. Shared
 * dependencies and observation revisions are resolved once, never persisted. */
export function projectMaturity(source: ExperienceSource): MaturityProjection {
  return maturityProjectionUnder(source, "current");
}

function maturityProjectionUnder(source: ExperienceSource, policy: MaturityPolicy): MaturityProjection {
  const context: MaturityContext = { policy, visiting: new Set(), memo: new Map(),
    revisions: new Set(canonicalObservations(source.observations).map(item => `${item.observationId}:${item.revision}`)) };
  return scope => resolveMaturity(source, scope, context);
}

/** Compatibility is confined to admission of historical compact-only facts.
 * Runtime defaults and new procedural reviews always use the current policy. */
function maturityUnder(source: ExperienceSource, scope: ScopeHypothesis, policy: MaturityPolicy): ReviewFact | undefined {
  return maturityProjectionUnder(source, policy)(scope);
}

function resolveMaturity(source: ExperienceSource, scope: ScopeHypothesis, context: MaturityContext): ReviewFact | undefined {
  const { visiting, memo } = context;
  const key = `${scope.versionId}\u0000${scope.scopeId}`;
  if (visiting.has(key)) return undefined;

  if (memo.has(key)) return memo.get(key);

  visiting.add(key);
  let review = directMaturity(source, scope, context);
  if (review !== undefined) for (const id of review.review.sources.filter(id => id !== scope.versionId)) {
    const binding = review.relatedBindings?.find(item => item.versionId === id);
    const related = scopesOf(source, id).find(item => item.hypothesis.scopeId === binding?.scopeId)?.hypothesis;
    const current = related === undefined ? undefined : resolveMaturity(source, related, context);
    if (binding === undefined || current?.factId !== binding.compilationId || current.snapshotId !== binding.snapshotId) {
      review = undefined;
      break;
    }
  }

  visiting.delete(key);
  memo.set(key, review);
  return review;
}

function directMaturity(source: ExperienceSource, scope: ScopeHypothesis, context: MaturityContext): ReviewFact | undefined {
  const { policy, revisions: current } = context;

  if (archived(source, scope.versionId)) return undefined;

  const epoch = epochOf(source, scope.versionId, scope.scopeId);
  let mature: ReviewFact | undefined;

  for (const fact of source.facts) {
    if (fact.kind === "compilation_exit" && mature?.factId === fact.compilationId) mature = undefined;

    if (fact.kind === "restriction" && fact.versionId === scope.versionId && fact.scopeId === scope.scopeId &&
      mature !== undefined && (policy === "current" || mature.review.procedure !== undefined) &&
      !(mature.review.decision === "narrow" && isCompilationApplied([fact], mature))) mature = undefined;

    if (fact.kind !== "review" || fact.versionId !== scope.versionId || fact.scopeId !== scope.scopeId || fact.sequence <= epoch) continue;

    // A narrowing changes the selection policy. It always supersedes the old
    // default, even when it supplies no replacement compiled practice.
    const legacyNarrowApplied = fact.review.decision === "narrow" && policy === "legacy_compact" && fact.review.procedure === undefined &&
      source.facts.some(item => item.kind === "restriction" && item.versionId === fact.versionId &&
        item.scopeId === fact.scopeId && item.sequence > fact.sequence);
    if (fact.review.decision === "core_invalid" || fact.review.decision === "behavior" ||
      (fact.review.decision === "narrow" && !legacyNarrowApplied)) mature = undefined;

    if (isCompilationReview(fact.review) && isCompilationApplied(source.facts, fact) &&
      fact.review.score >= METHOD_INFERENCE_POLICY.modelThreshold) {
      // Current defaults never resurrect a predecessor after correction. The
      // historical branch exists only to validate the original legacy contract.
      if (fact.evidenceRevisions.every(item => current.has(item))) mature = fact;
      else if (policy === "current" || fact.review.procedure !== undefined) mature = undefined;
    }
  }

  return mature;
}

/** Only actual synthesis dependencies influence eligibility. Unrelated library
 * edits cannot buy a new model review of an unchanged method. */
function dependencyGeneration(source: ExperienceSource, scope: ScopeHypothesis): readonly string[] {
  const latest = [...source.facts].reverse().find((item): item is ReviewFact => item.kind === "review" &&
    item.versionId === scope.versionId && item.scopeId === scope.scopeId && isCompilationReview(item.review));
  return (latest?.relatedBindings ?? []).map(binding => {
    const related = scopesOf(source, binding.versionId).find(item => item.hypothesis.scopeId === binding.scopeId);
    const current = related === undefined ? undefined : matureReview(source, related.hypothesis);
    return canonicalCardJson([binding.versionId, binding.scopeId, binding.compilationId, current?.factId ?? "unavailable"]);
  });
}

export function shouldExitScope(source: ExperienceSource, scope: ScopeHypothesis): boolean {
  const observations = canonicalObservations(source.observations.filter(item => item.versionId === scope.versionId))
    .filter(item => matchesScope(scope.predicate, item.features));
  return recentPosteriorOf(observations, { versionId: scope.versionId,
    sinceSequence: Math.max(scope.proposedSequence, epochOf(source, scope.versionId, scope.scopeId)) }).shouldExit;
}

/** One transition policy for commands, replay and snapshot validation. */
export function experienceFactError(source: ExperienceSource, fact: MethodExperienceFact): string | undefined {
  if (source.facts.length >= MAX_METHOD_EXPERIENCE_FACTS) return "method_experience_capacity";

  if (!source.versions.some(version => version.versionId === fact.versionId)) return "asset_not_found";

  if (fact.sequence !== source.sequence + 1 || source.facts.some(old => old.factId === fact.factId)) return "fact_identity_conflict";

  if (fact.kind === "scope") {
    const scopes = scopesOf(source, fact.versionId);
    if (archived(source, fact.versionId) || scopes.length >= 4 || scopes.some(old => old.hypothesis.scopeId === fact.hypothesis.scopeId ||
      old.hypothesis.id === fact.hypothesis.id || scopePredicateKey(old.hypothesis.predicate) === scopePredicateKey(fact.hypothesis.predicate)) ||
      fact.hypothesis.proposedSequence !== source.sequence || source.facts.some(old => old.kind === "scope" &&
        (old.hypothesis.id === fact.hypothesis.id || (old.versionId === fact.versionId && old.hypothesis.scopeId === fact.hypothesis.scopeId)))) return "invalid_scope_registration";
    return undefined;
  }

  if (fact.kind === "scope_retired") {
    const scope = scopesOf(source, fact.versionId).find(item => item.hypothesis.scopeId === fact.scopeId);
    // Explicitly exited ranges free capacity without claiming a low posterior.
    // Historical statistical retirements retain their original comparison.
    if (scope !== undefined && scopePermanentlyClosed(source, scope.hypothesis)) return undefined;
    return statisticallyExpendableScope(source, fact.versionId)?.hypothesis.scopeId === fact.scopeId ? undefined : "scope_not_expendable";
  }

  if (fact.kind === "exit") return undefined;

  if (fact.kind === "execution") return executionFactError(source, fact);

  if (fact.kind === "adoption_window_closed") return adoptionWindowFactError(source, fact);

  if (fact.kind === "compilation_exit") return source.facts.some(item => item.kind === "review" && item.factId === fact.compilationId &&
    item.versionId === fact.versionId && item.scopeId === fact.scopeId && isCompilationReview(item.review)) ? undefined : "compilation_not_found";

  const scopeId = fact.kind === "review" || fact.kind === "restriction" ? fact.scopeId : fact.decision.scopeId;
  const scope = scopesOf(source, fact.versionId).find(item => item.hypothesis.scopeId === scopeId)?.hypothesis;
  if (scope === undefined || archived(source, fact.versionId)) return "scope_unavailable";

  if (fact.kind === "restriction") {
    return restricts(effectivePredicate(source, scope), fact.predicate) ? undefined : "restriction_cannot_expand_scope";
  }

  if (fact.kind === "decision") {
    if (fact.decision.action === "adopt" && adoptionWindowClosed(source.facts, { versionId: fact.versionId,
      taskId: fact.context.taskId, ...(fact.decision.compilationId === undefined ? {} : { compilationId: fact.decision.compilationId }) }, fact.sequence)) {
      return "method_adoption_window_closed";
    }

    const compilation = fact.decision.compilationId === undefined ? undefined : source.facts.find((item): item is ReviewFact =>
      item.kind === "review" && item.factId === fact.decision.compilationId && item.versionId === fact.versionId && item.scopeId === scope.scopeId);
    if (fact.decision.step !== undefined && compilation?.review.procedure !== undefined &&
      !compilation.review.procedure.steps.some(step => step.id === fact.decision.step)) return "method_decision_unknown_step";

    if (!matchesScope(effectivePredicate(source, scope), fact.context.features)) return "context_outside_scope";

    if (fact.decision.action === "adopt" && !source.fieldings?.some(item => item.versionId === fact.versionId &&
      item.turnId === fact.context.taskId && item.scope === scope.scopeId && item.useSequence !== undefined &&
      item.useSequence < fact.sequence && (item.binding === undefined ? fact.decision.compilationId === undefined :
        item.binding.compilationId === fact.decision.compilationId &&
        canonicalCardJson(item.binding.context) === canonicalCardJson(fact.context)))) return "adoption_before_delivery";

    return undefined;
  }

  return reviewFactError(source, fact, scope);
}

function reviewFactError(source: ExperienceSource, fact: ReviewFact, scope: ScopeHypothesis): string | undefined {
  const semanticError = reviewSemanticError(source, fact, scope);
  if (semanticError !== undefined) return semanticError;

  if (fact.review.procedure !== undefined && !scopeEnabled(source, scope)) return "scope_unavailable";

  const snapshot = snapshotOf(source, scope);
  const currentIdentity = snapshot.snapshotId === fact.snapshotId;
  const legacyIdentity = fact.review.procedure === undefined && snapshot.legacySnapshotId === fact.snapshotId;

  if (fact.contextKey !== undefined && fact.contextKey !== snapshot.contextKey) return "stale_review_context";

  const maturityPolicy: MaturityPolicy = legacyIdentity ? "legacy_compact" : "current";

  if ((!currentIdentity && !legacyIdentity) || JSON.stringify(snapshot.revisions) !== JSON.stringify(fact.evidenceRevisions) ||
    source.facts.some(old => old.kind === "review" && old.snapshotId === fact.snapshotId)) return "stale_or_repeated_review";

  if (fact.review.sources.some(id => !source.versions.some(version => version.versionId === id)) ||
    !fact.review.sources.includes(fact.versionId)) return "source_unavailable";

  if (fact.knownCounterexampleRevisions !== undefined && canonicalCardJson(fact.knownCounterexampleRevisions) !==
    canonicalCardJson(knownCounterexamplesOf(source, fact.versionId).map(observationRevisionKey))) return "invalid_counterexample_binding";

  const dualGate = isCompilationReview(fact.review) &&
    (fact.review.decision !== "expression" || fact.review.procedure !== undefined);
  if (dualGate && (snapshot.posterior.confidence < METHOD_INFERENCE_POLICY.algorithmThreshold ||
    fact.review.score < METHOD_INFERENCE_POLICY.modelThreshold)) return "dual_gate_rejected";

  if (fact.review.decision === "expression") {
    // A new procedural repair may follow withdrawal or restriction; the source
    // qualification gate still applies. Preserve the old compact-only contract
    // when replaying historical reviews.
    const priorCompilation = fact.review.procedure === undefined ? maturityUnder(source, scope, maturityPolicy) !== undefined :
      source.facts.some(item => item.kind === "review" && item.versionId === fact.versionId && item.scopeId === fact.scopeId &&
        item.review.score >= METHOD_INFERENCE_POLICY.modelThreshold && isCompilationApplied(source.facts, item));
    if (!priorCompilation) return "expression_requires_mature_source";
  }

  if (fact.reconsideration !== undefined) {
    const parent = source.facts.find((item): item is ReviewFact => item.kind === "review" &&
      item.factId === fact.reconsideration!.compilationId && item.versionId === fact.versionId && item.scopeId === fact.scopeId);
    if (parent === undefined) return "invalid_reconsideration_binding";

    const observed = compilationEvidenceOf(source.observations, { scope, compilationId: parent.factId, compiledSequence: parent.sequence });
    const markers = observed.evidence.observations.map(observationRevisionKey);
    if (canonicalCardJson(markers) !== canonicalCardJson(fact.reconsideration.evidenceRevisions)) return "invalid_reconsideration_binding";

    if (fact.reconsideration.semanticRevisions !== undefined && canonicalCardJson(fact.reconsideration.semanticRevisions) !==
      canonicalCardJson((observed.semanticObservations ?? observed.evidence.observations).map(observationRevisionKey))) {
      return "invalid_reconsideration_semantic_binding";
    }
  }

  // A synthesis may link mature sources; it cannot borrow evidence or maturity from an active one.
  for (const id of fact.review.sources.filter(id => id !== fact.versionId)) {
    const binding = fact.relatedBindings?.find(item => item.versionId === id);
    const sourceScope = scopesOf(source, id).find(item => item.hypothesis.scopeId === binding?.scopeId)?.hypothesis;
    const mature = sourceScope === undefined ? undefined : maturityUnder(source, sourceScope, maturityPolicy);
    if (binding === undefined || mature === undefined || sourceScope === undefined ||
      !(legacyIdentity ? scopePredicateKey(scope.predicate) === scopePredicateKey(sourceScope.predicate) :
        compatibleExperienceScope(source, scope, sourceScope)) || mature.factId !== binding.compilationId ||
      mature.snapshotId !== binding.snapshotId || canonicalCardJson(mature.evidenceRevisions) !== canonicalCardJson(binding.evidenceRevisions) ||
      dependsOnVersion(source, mature, fact.versionId, new Set())) return "unrelated_or_stale_synthesis_source";
  }

  return undefined;
}

function dependsOnVersion(source: ExperienceSource, fact: ReviewFact, versionId: string, visited: Set<string>): boolean {
  if (visited.has(fact.factId)) return true;

  visited.add(fact.factId);

  if (fact.review.sources.includes(versionId)) return true;

  return (fact.relatedBindings ?? []).some(binding => {
    const parent = source.facts.find((item): item is ReviewFact => item.kind === "review" && item.factId === binding.compilationId);
    return parent !== undefined && dependsOnVersion(source, parent, versionId, new Set(visited));
  });
}

function reviewSemanticError(source: ExperienceSource, fact: ReviewFact, scope: ScopeHypothesis): string | undefined {
  const review = fact.review;
  const parent = source.versions.find(item => item.versionId === fact.versionId)!;
  const admissionError = review.procedure === undefined ? undefined : newReviewError(review, parent.hint);
  if (admissionError !== undefined) return admissionError;

  if (review.decision === "behavior" && (review.revisedMethod === undefined || review.revisedMethod === parent.hint ||
    review.revisedMethod.trim().length === 0 || review.revisedMethod.length > MAX_HINT_CHARS ||
    scanForbiddenText([review.revisedMethod]).length > 0 || (review.scopes?.length ?? 0) > 0)) return "invalid_behavior_revision";

  const compilationError = compilationSemanticError(source, fact, scope);
  if (compilationError !== undefined) return compilationError;

  if (review.decision === "core_invalid" && (review.scopes?.length ?? 0) > 0) return "invalid_core_revision_scope";

  const current = scopesOf(source, fact.versionId);
  const existing = source.facts.filter((item): item is ScopeFact => item.kind === "scope");
  const predicates = new Set(current.map(item => scopePredicateKey(item.hypothesis.predicate)));
  const ids = new Set<string>();
  let newScopes = 0;

  // Historical artifact-free narrow reviews also represented explicit scope
  // retirement. Only the new compiled form requires a current-scope restriction.
  if (review.decision === "narrow" && isCompilationReview(review) &&
    !review.scopes?.some(hypothesis => hypothesis.scopeId === fact.scopeId)) return "narrow_requires_restriction";

  for (const hypothesis of review.scopes ?? []) {
    if (hypothesis.versionId !== fact.versionId || ids.has(hypothesis.id)) return "invalid_review_scope";

    ids.add(hypothesis.id);

    if (hypothesis.scopeId === fact.scopeId && review.decision === "narrow") {
      const original = current.find(item => item.hypothesis.scopeId === fact.scopeId)!.hypothesis;
      if (!restricts(effectivePredicate(source, original), hypothesis.predicate)) return "restriction_cannot_expand_scope";
      continue;
    }

    const predicate = scopePredicateKey(hypothesis.predicate);
    if (predicates.has(predicate)) continue; // Exact hypotheses merge without adding evidence.

    if (existing.some(item => item.hypothesis.id === hypothesis.id ||
      (item.versionId === fact.versionId && item.hypothesis.scopeId === hypothesis.scopeId))) return "scope_identity_conflict";

    predicates.add(predicate);
    newScopes += 1;
  }

  const closed = current.filter(item => scopePermanentlyClosed(source, item.hypothesis)).length;
  // A fresh hypothesis resets the prospective comparison batch. Only known
  // closed ranges can be removed repeatedly in that same effect transaction.
  const replaceable = closed > 0 ? closed : statisticallyExpendableScope(source, fact.versionId) === undefined ? 0 : 1;
  if (newScopes > 4 - current.length + replaceable) return "method_scope_capacity";

  return undefined;
}

function compilationSemanticError(source: ExperienceSource, fact: ReviewFact, scope: ScopeHypothesis): string | undefined {
  const review = fact.review;
  if ((review.decision === "promote" || review.decision === "expression") && review.compact === undefined) return "invalid_compilation";

  if (review.decision === "narrow" && ((review.compact === undefined) !== (review.procedure === undefined))) return "invalid_narrow_compilation";

  if (isCompilationReview(review) &&
    scanForbiddenText([review.compact.when, review.compact.action, review.compact.exceptions]).length > 0) return "invalid_compilation";

  if (isCompilationReview(review)) {
    const deliveryError = compilationDeliveryError({ compact: review.compact,
      ...(review.procedure === undefined ? {} : { procedure: review.procedure }) });
    if (deliveryError !== undefined) return deliveryError;
  }

  if (review.procedure !== undefined) {
    const available = scopeEvidenceOf(scope, source.observations,
      { sinceSequence: epochOf(source, fact.versionId, fact.scopeId) }).observations;
    const procedureError = procedureEvidenceError(review.procedure, available);
    if (procedureError !== undefined || scanForbiddenText(procedureTextFields(review.procedure)).length > 0) return procedureError ?? "invalid_procedure_text";
  }

  const currentCompilation = [...source.facts].reverse().find((item): item is ReviewFact => item.kind === "review" &&
    item.versionId === fact.versionId && item.scopeId === fact.scopeId && isCompilationReview(item.review));
  if (currentCompilation?.review.compact !== undefined && review.procedure !== undefined) {
    const repair = compilationRepairRequired(source, scope, currentCompilation);
    const reentry = reentryQualificationOf(source, scope, currentCompilation);
    const mode = reentry !== undefined && reentry.confidence >= METHOD_INFERENCE_POLICY.algorithmThreshold ? "requalified" : repair ? "repair" : "ordinary";
    const revisionError = compilationRevisionError({ compact: currentCompilation.review.compact,
      ...(currentCompilation.review.procedure === undefined ? {} : { procedure: currentCompilation.review.procedure }) }, review, mode);
    if (revisionError !== undefined) return revisionError;
  }

  return undefined;
}

function executionFactError(source: ExperienceSource, fact: Extract<MethodExperienceFact, { kind: "execution" }>): string | undefined {
  const trace = fact.trace;
  const fielding = source.fieldings?.find(item => item.exposureId === trace.exposureId && item.versionId === fact.versionId &&
    item.turnId === trace.taskId && item.scope === trace.scopeId && item.beat === trace.beat &&
    item.binding?.context.opportunityId === trace.opportunityId && item.binding?.compilationId === trace.compilationId &&
    item.useSequence !== undefined && item.useSequence < fact.sequence);
  if (fielding?.binding === undefined) return "execution_without_bound_delivery";

  const boundary = fielding.binding.requestBoundarySequence;
  if (boundary !== undefined && (trace.firstSequence === undefined || trace.lastSequence === undefined ||
    trace.firstSequence <= boundary) || boundary === undefined && trace.firstSequence !== undefined) return "execution_without_fresh_request_span";

  return executionAdoptionFor(source.facts, fielding, fact.sequence) === undefined ? "execution_without_prior_adoption" : undefined;
}

function restricts(before: ScopePredicate, after: ScopePredicate): boolean {
  const allKey = (all: ScopePredicate["all"]) => scopePredicateKey({ all, exclude: [] });
  const beforeExclude = before.exclude.map(item => canonicalCardJson(item));
  const afterExclude = new Set(after.exclude.map(item => canonicalCardJson(item)));
  return allKey(before.all) === allKey(after.all) && beforeExclude.every(item => afterExclude.has(item)) &&
    after.exclude.length > before.exclude.length;
}
