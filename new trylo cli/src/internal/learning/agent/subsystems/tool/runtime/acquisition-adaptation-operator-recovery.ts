import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isAcquisitionRecoveryReviewId } from "../domain/evolution/acquisition-lease.js";
import { acquisitionRecoveryFenceId, acquisitionRecoveryFromBoard, type AcquisitionRecoverySelection } from "./acquisition-adaptation-recovery-review.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { toolLearningFundingClaimBelongsTo } from "../domain/evolution/funding-identity.js";

/** Only an explicit operator action may fence a genuinely expired unknown
 * worker. It cannot refuel the original task or authorize any tool execution. */
export async function recoverExpiredAcquisitionAdaptation(input: AcquisitionRecoverySelection & { readonly approvalId: string; readonly reviewId: string }) {
  if (!isAcquisitionRecoveryReviewId(input.reviewId)) return pipelineFailure("invalid_acquisition_recovery_review", input.childJobId);

  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const selected = acquisitionRecoveryFromBoard(loaded.state, input);
    if (!selected.ok) return selected;

    const versionId = `tool-adaptation-recovery_v1_${contentHashOf([input.childJobId, input.attempt, input.reviewId])}`;
    const fenceId = acquisitionRecoveryFenceId(input.childJobId, input.attempt, input.reviewId);
    const fenced = selected.child.state === "waiting_evidence" && loaded.state.appliedCommands.some(row => row.commandId === fenceId);
    const previous = loaded.state.assets.find(row => row.versionId === versionId);
    if (previous !== undefined) {
      const belongs = (raw: unknown): raw is string => typeof raw === "string"
        && toolLearningFundingClaimBelongsTo(selected.request.learningPlan, input.childJobId, input.attempt, raw);
      if (!fenced || !assetAvailable(loaded.state, previous) || previous.source !== "user_explicit" || previous.scope !== input.scope
        || previous.kind !== "workflow" || !recordOf(previous.content) || !keysAre(previous.content,
          ["type", "schemaVersion", "originalJobId", "approvalId", "childJobId", "attempt", "reviewId", "claimId", "grantId", "externalOutcome"], ["claimIds"])
        || previous.content.type !== "tool_acquisition_adaptation_recovered" || previous.content.schemaVersion !== 1
        || previous.content.originalJobId !== input.jobId || previous.content.approvalId !== input.approvalId
        || previous.content.childJobId !== input.childJobId || previous.content.attempt !== input.attempt || previous.content.reviewId !== input.reviewId
        || (previous.content.claimId !== null && !belongs(previous.content.claimId))
        || (previous.content.claimIds !== undefined && (!Array.isArray(previous.content.claimIds) || previous.content.claimIds.length > 65
          || !previous.content.claimIds.every(belongs) || new Set(previous.content.claimIds).size !== previous.content.claimIds.length))
        || previous.content.grantId !== selected.view.budget.grantId || previous.content.externalOutcome !== "unknown") {
        return pipelineFailure("invalid_acquisition_recovery_record", versionId);
      }

      return { ok: true as const, recovered: true as const, childJobId: input.childJobId, attempt: input.attempt,
        canResume: selected.view.canResume, next: selected.view.canResume ? "resume_existing_adaptation" as const : "attempt_limit_reached" as const };
    }

    if (!fenced && (!selected.view.recoverable || !("reviewId" in selected.view) || selected.view.reviewId !== input.reviewId)) {
      return pipelineFailure(selected.view.code ?? "stale_acquisition_recovery_review", input.childJobId);
    }

    const at = new Date(input.now()).toISOString();

    if (!fenced) {
      // Fence first. Every model/contract/production write already requires this
      // exact child attempt to remain running; late output loses that authority.
      const fence = await store.apply({ type: "complete_job", commandId: fenceId, issuedAt: at, jobId: input.childJobId, next: "waiting_evidence" });
      if (!fence.ok) return pipelineFailure(fence.reason, fence.detail);
    }

    const released = await releaseExpiredFunding(store, selected, at);
    if (!released.ok) return released;

    const saved = await savePipelineAsset(store, { versionId, kind: "workflow", scope: input.scope, source: "user_explicit", issuedAt: at,
      content: { type: "tool_acquisition_adaptation_recovered", schemaVersion: 1, originalJobId: input.jobId, approvalId: input.approvalId,
        childJobId: input.childJobId, attempt: input.attempt, reviewId: input.reviewId, claimId: selected.claimId ?? null, claimIds: selected.claimIds,
        grantId: selected.view.budget.grantId, externalOutcome: "unknown" } });

    return saved.ok ? { ok: true as const, recovered: true as const, childJobId: input.childJobId, attempt: input.attempt,
      canResume: selected.view.canResume, next: selected.view.canResume ? "resume_existing_adaptation" as const : "attempt_limit_reached" as const } : saved;
  });

  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

async function releaseExpiredFunding(store: BoardStore, selected: Extract<ReturnType<typeof acquisitionRecoveryFromBoard>, { readonly ok: true }>, at: string) {
  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === selected.view.budget.grantId);
  if (grant === undefined) return { ok: true as const };

  const apply = async (action: CoordinationAction, claimStep?: number) => {
    const identity = claimStep === undefined ? action : { action, claimStep };
    const result = await store.apply({ type: "coordinate_learning", commandId: `tool-budget:${contentHashOf(identity)}`, issuedAt: at, action });
    return result.ok ? { ok: true as const } : pipelineFailure(result.reason, result.detail);
  };

  if (grant.status === "open" && selected.claimId !== undefined && grant.claim?.claimId === selected.claimId
    && grant.claim.step === selected.grant?.claim?.step) return apply({ kind: "finish", jobId: grant.jobId,
    claimId: selected.claimId, result: { kind: "yielded", reason: "operator_recovered_expired_acquisition_claim" } }, grant.claim.step);

  // A crash after the fence may leave cleanup incomplete. A later normal
  // central claim already conservatively settles old reservations; touch only
  // remaining slots from this exact stopped attempt, never another worker's lease.
  for (const reservation of grant.reservations.filter(row => row.state === "reserved"
    && toolLearningFundingClaimBelongsTo(selected.request.learningPlan, selected.child.jobId, selected.child.attempt, row.claimId))) {
    const settled = await apply({ kind: "settle", grantId: grant.grantId, reservationId: reservation.reservationId,
      usage: { kind: "unknown", reason: "operator_recovered_expired_acquisition_claim" } });
    if (!settled.ok) return settled;
  }

  return { ok: true as const };
}
