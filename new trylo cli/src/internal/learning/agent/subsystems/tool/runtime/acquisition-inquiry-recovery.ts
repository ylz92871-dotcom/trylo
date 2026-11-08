import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isAcquisitionInquiryReviewId } from "../domain/evolution/acquisition-inquiry.js";
import { acquisitionInquiryReviewFromBoard, type AcquisitionInquirySelection } from "./acquisition-inquiry-review.js";
import { acquisitionInquirySpecFromBoard } from "./acquisition-inquiry-reader.js";
import { committedInquiryDecision } from "./acquisition-inquiry-committed.js";
import { finishAcquisitionInquiry, proposedAcquisitionInquiryOutcome } from "./acquisition-inquiry-result.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { cleanupStoppedInquiryFunding } from "./acquisition-inquiry-funding-cleanup.js";

/** Explicit expired recovery only. A running external call is never silently sent again. */
export async function recoverExpiredAcquisitionInquiry(input: AcquisitionInquirySelection & { readonly approvalId: string; readonly reviewId: string }) {
  if (!isAcquisitionInquiryReviewId(input.reviewId)) return pipelineFailure("invalid_inquiry_review", input.jobId);

  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const selected = acquisitionInquiryReviewFromBoard(loaded.state, input);
    if (!selected.ok) return selected;

    const child = selected.child;
    if (child === undefined) return pipelineFailure("inquiry_not_running", selected.inquiryJobId);

    const fenceId = `acquisition-inquiry-fence:${contentHashOf([child.jobId, child.attempt, input.reviewId])}`;
    const versionId = `acquisition-inquiry-recovery_v1_${contentHashOf([child.jobId, child.attempt, input.reviewId])}`;
    const fenced = child.state === "waiting_evidence" && loaded.state.appliedCommands.some(row => row.commandId === fenceId);
    const prior = loaded.state.assets.find(row => row.versionId === versionId);
    if (prior !== undefined) return assetAvailable(loaded.state, prior) && prior.kind === "workflow" && prior.source === "user_explicit" && prior.scope === input.scope && recordOf(prior.content)
      && keysAre(prior.content, ["type", "schemaVersion", "originalJobId", "approvalId", "failureRef", "jobId", "attempt", "reviewId", "grantId", "externalOutcome"])
      && prior.content.type === "tool_acquisition_inquiry_recovered" && prior.content.schemaVersion === 1 && prior.content.originalJobId === input.jobId
      && prior.content.approvalId === input.approvalId && prior.content.failureRef === input.failureRef && prior.content.grantId === selected.view.budget.grantId
      && ["unknown", "committed_decision"].includes(String(prior.content.externalOutcome)) && (prior.content.externalOutcome !== "unknown" || fenced)
      && prior.content.jobId === child.jobId && prior.content.attempt === child.attempt && prior.content.reviewId === input.reviewId
      ? { ok: true as const, recovered: true as const, inquiryJobId: child.jobId, attempt: child.attempt, next: "inspect_stored_inquiry" as const }
      : pipelineFailure("invalid_inquiry_recovery", versionId);

    if (!fenced && (!selected.view.recovery?.recoverable || selected.view.recovery.reviewId !== input.reviewId)) return pipelineFailure("stale_inquiry_recovery_review", child.jobId);

    const at = new Date(input.now()).toISOString();
    let externalOutcome: "unknown" | "committed_decision" = "unknown";
    let hasReview = false;

    if (!fenced) {
      const known = committedInquiryDecision(loaded.state, { jobId: child.jobId, attempt: child.attempt, plan: selected.request.learningPlan, search: selected.request.search });
      if (!known.ok) return known;

      if (known.decision !== undefined) {
        const source = acquisitionInquirySpecFromBoard(loaded.state, child.jobId, child.attempt, input.scope);
        if (!source.ok) return source;

        if (source.spec === undefined) return pipelineFailure("invalid_inquiry_spec", child.jobId);

        const outcome = proposedAcquisitionInquiryOutcome({ spec: source.spec, plan: selected.request.learningPlan, decision: known.decision,
          decisionVersionId: known.decisionVersionId!, search: known.search!, occurredAt: known.occurredAt!, failure: selected.failure });
        if (outcome === undefined) return pipelineFailure("invalid_inquiry_proposal", child.jobId);

        const committed = await finishAcquisitionInquiry(store, outcome, at);
        if (!committed.ok) return committed;

        externalOutcome = "committed_decision";
        hasReview = outcome.review !== undefined;
      } else {
        const fence = await store.apply({ type: "complete_job", commandId: fenceId, issuedAt: at, jobId: child.jobId, next: "waiting_evidence" });
        if (!fence.ok) return pipelineFailure(fence.reason, fence.detail);
      }
    }

    const cleaned = await cleanupStoppedInquiryFunding(store, { plan: selected.rootPlan, jobId: child.jobId, attempt: child.attempt, issuedAt: at });
    if (!cleaned.ok) return cleaned;

    const saved = await savePipelineAsset(store, { versionId, kind: "workflow", scope: input.scope, source: "user_explicit", issuedAt: at,
      content: { type: "tool_acquisition_inquiry_recovered", schemaVersion: 1, originalJobId: input.jobId, approvalId: input.approvalId,
        failureRef: input.failureRef, jobId: child.jobId, attempt: child.attempt, reviewId: input.reviewId, grantId: selected.view.budget.grantId, externalOutcome } });

    return saved.ok ? { ok: true as const, recovered: true as const, inquiryJobId: child.jobId, attempt: child.attempt,
      next: externalOutcome === "committed_decision" ? hasReview ? "review_new_decision" as const : "inspect_stored_inquiry" as const : "confirm_new_inquiry" as const } : saved;
  });

  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}
