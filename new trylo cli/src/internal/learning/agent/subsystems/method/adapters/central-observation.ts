import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { isCompilationApplied } from "../domain/compilation-review.js";
import { experienceViewOf } from "./experience-store.js";
import { methodCentralPolicyRef, methodCentralSnapshotId, methodCentralSourceBinding, methodFocusedTarget,
  type ManagedMethodReview } from "./central-source.js";

/** Observe the original snapshot's delivered artifact. A successful model/worker
 * status or the amount spent is never substituted for this result.
 */
export async function observeMethodCentralStage(options: { readonly boardRoot: string; readonly scope: string; readonly model: string },
  input: ManagedMethodReview, signal: AbortSignal) {
  const sourceRefs = [input.issueId, input.grantId, input.stageRef, input.sourceBindingRef];
  const pending = (reason: string) => ({ outcome: "pending" as const, reason, sourceRefs, resultRefs: [] });

  if (signal.aborted) return pending("learning_observation_cancelled");

  const snapshotId = methodCentralSnapshotId(input.stageRef);
  if (snapshotId === undefined) return pending("method_observation_stage_binding");

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return pending(loaded.reason);

  const issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId && item.scope === options.scope);
  // The frozen binding identifies the original report even if this issue later
  // gained another scope/owner or the PA focused a different investment.
  const target = issue === undefined ? undefined : issue.reports.flatMap(report => {
    const selected = methodFocusedTarget({ ...issue, reports: [report] });
    return selected !== undefined && input.sourceBindingRef === methodCentralSourceBinding(selected.versionId,
      selected.scopeId, snapshotId, input.stageRef) ? [selected] : [];
  })[0];
  const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === input.grantId && item.issueId === input.issueId
    && item.domain === "prompt" && item.scope === options.scope && item.budgetId !== undefined);
  if (target === undefined || grant === undefined || input.sourceBindingRef !== methodCentralSourceBinding(target.versionId,
    target.scopeId, snapshotId, input.stageRef)) return pending("method_observation_source_binding");

  // A real receipt retains its own model identity after host configuration
  // changes. A missing receipt cannot borrow today's model or result.
  const reservation = grant.reservations.find(item => item.usage?.kind === "reported" && item.usage.model !== undefined
    && input.policyRef === methodCentralPolicyRef(item.usage.model)
    && item.reservationId === shortId("method-review", [snapshotId, item.usage.model]))
    ?? (input.policyRef === methodCentralPolicyRef(options.model)
      ? grant.reservations.find(item => item.reservationId === shortId("method-review", [snapshotId, options.model])) : undefined);
  if (reservation === undefined) return pending("method_original_model_receipt_required");

  const view = experienceViewOf(loaded.state);
  const review = view.facts.find(item => item.kind === "review" && item.versionId === target.versionId && item.scopeId === target.scopeId
    && item.snapshotId === snapshotId && item.factId === shortId("method-review", [snapshotId]));
  if (review?.kind !== "review") return pending("method_review_result_pending");

  const resultRefs = [review.factId];
  const qualified = (reason: string) => ({ outcome: "qualified" as const, reason, sourceRefs, resultRefs });

  if (isCompilationApplied(view.facts, review)) return qualified("method_compiled_proposal_delivered");

  if (review.review.decision === "behavior" && review.review.revisedMethod !== undefined) {
    const versionId = shortId("method-revision", [target.versionId, review.review.revisedMethod]);
    const revised = view.variants.find(item => item.versionId === versionId && item.card.hint === review.review.revisedMethod
      && item.card.lineage.parentVersionId === target.versionId);
    if (revised !== undefined) {
      resultRefs.push(versionId);
      return qualified("method_behavior_revision_delivered");
    }
    return pending("method_behavior_revision_effect_pending");
  }

  const effect = view.facts.find(item => item.sequence > review.sequence && item.versionId === target.versionId
    && (item.factId === shortId("method-restriction", [snapshotId]) || item.factId === shortId("method-repair-exit", [snapshotId])));
  if (effect !== undefined) {
    resultRefs.push(effect.factId);
    return qualified("method_scope_or_withdrawal_proposal_delivered");
  }

  const closed = review.review.decision === "defer" && reservation.state === "settled" && reservation.usage?.kind === "reported"
    && grant.claim?.claimId !== reservation.claimId
    && !grant.reservations.some(item => item.claimId === reservation.claimId && item.state === "reserved");

  return closed ? { outcome: "closed_no_result" as const, reason: "method_review_closed_without_new_proposal", sourceRefs, resultRefs }
    : pending("method_effect_or_final_receipt_pending");
}
