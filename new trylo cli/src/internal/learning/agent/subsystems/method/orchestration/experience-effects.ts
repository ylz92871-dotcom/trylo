import { shortId } from "../../../../domains/shared/hash.js";
import { expendableScope, scopeEnabled, scopesOf, type ReviewFact } from "../domain/experience-state.js";
import { scopePredicateKey, type ScopeHypothesis } from "../domain/scope-learning.js";
import { MAX_SCOPE_DESCRIPTION_CHARS, scopeCaption } from "../domain/scope-description.js";
import type { ExperienceRuntimeOptions, ExperienceView } from "./experience-runtime.js";

/** A stored model result is replayable work, not evidence that every following
 * write completed. Reconcile only its missing idempotent effects after restart. */
export async function resumeReviewEffects(options: ExperienceRuntimeOptions, initial: ExperienceView, signal: AbortSignal): Promise<ExperienceView> {
  let view = initial;

  for (const fact of initial.facts) {
    if (signal.aborted) return view;
    if (fact.kind === "review") {
      try { view = await applyReviewEffects(options, view, fact, signal); }
      catch (error) {
        // A failed effect remains pending and visible, but cannot starve other
        // method versions. The next bounded maintenance contact may retry it.
        options.emit("observation", { component: "method_review_effect", degraded: true, versionId: fact.versionId,
          reason: error instanceof Error ? error.message : String(error) });
        view = await options.store.load();
      }
    }
  }

  return view;
}

export async function applyReviewEffects(options: ExperienceRuntimeOptions, initial: ExperienceView, fact: ReviewFact,
  signal: AbortSignal): Promise<ExperienceView> {
  if (signal.aborted) return initial;

  let view = initial;
  const review = fact.review;
  const exitId = shortId(review.decision === "behavior" ? "method-replaced" : "method-repair-exit", [fact.snapshotId]);
  if (review.decision === "behavior" && !view.facts.some(item => item.factId === exitId)) {
    if (review.revisedMethod === undefined) throw new Error("behavior_revision_missing");
    await options.revise(fact.versionId, review.revisedMethod);
    if (signal.aborted) return await options.store.load();
    view = await appendExit(options, fact, exitId, "archive");
  } else if ((review.decision === "core_invalid" || (review.decision === "narrow" &&
    !review.scopes?.some(item => item.scopeId === fact.scopeId))) && !view.facts.some(item => item.factId === exitId)) {
    view = await appendExit(options, fact, exitId, review.decision === "narrow" ? "scope" : "stable");
  }

  for (const hypothesis of review.scopes ?? []) {
    if (signal.aborted) break;
    if (hypothesis.versionId !== fact.versionId) throw new Error("scope_version_mismatch");
    view = await applyRange(options, view, fact, hypothesis);
  }

  return view;
}

function appendExit(options: ExperienceRuntimeOptions, fact: ReviewFact, factId: string, mode: "archive" | "scope" | "stable") {
  return options.store.append(current => ({ kind: "exit", factId, versionId: fact.versionId,
    sequence: current.sequence + 1, mode, ...(mode === "scope" ? { scopeId: fact.scopeId } : {}), reason: fact.review.reason }));
}

async function applyRange(options: ExperienceRuntimeOptions, view: ExperienceView, review: ReviewFact,
  hypothesis: ScopeHypothesis): Promise<ExperienceView> {
  const restriction = hypothesis.scopeId === review.scopeId && review.review.decision === "narrow";
  if (!restriction && scopesOf(view, hypothesis.versionId).some(item =>
    scopePredicateKey(item.hypothesis.predicate) === scopePredicateKey(hypothesis.predicate))) return view;

  const factId = restriction ? shortId("method-restriction", [review.snapshotId]) : shortId("method-range", [hypothesis.id]);
  const existing = view.facts.find(item => item.factId === factId);
  if (existing !== undefined) {
    const predicate = existing.kind === "scope" ? existing.hypothesis.predicate : existing.kind === "restriction" ? existing.predicate : undefined;
    if (existing.versionId !== hypothesis.versionId || predicate === undefined || scopePredicateKey(predicate) !== scopePredicateKey(hypothesis.predicate)) {
      throw new Error("scope_effect_identity_conflict");
    }
    return view;
  }

  if (!restriction && scopesOf(view, review.versionId).length >= 4) {
    const retired = expendableScope(view, review.versionId);
    if (retired === undefined) throw new Error("method_scope_capacity");
    view = await options.store.append(current => ({ kind: "scope_retired", factId: shortId("method-scope-retired", [retired.hypothesis.id]),
      versionId: review.versionId, sequence: current.sequence + 1, scopeId: retired.hypothesis.scopeId,
      reason: scopeEnabled(view, retired.hypothesis) ? "prospective_partition_posterior_below_0.05_after_12_known_uses" : "scope_previously_exited" }));
  }

  return options.store.append(current => restriction ? { kind: "restriction", factId, versionId: review.versionId,
    sequence: current.sequence + 1, scopeId: review.scopeId, predicate: hypothesis.predicate, reason: review.review.reason } :
    { kind: "scope", factId, versionId: review.versionId, sequence: current.sequence + 1,
      description: scopeCaption(review.review.reason, MAX_SCOPE_DESCRIPTION_CHARS),
      hypothesis: { ...hypothesis, proposedSequence: current.sequence } });
}
