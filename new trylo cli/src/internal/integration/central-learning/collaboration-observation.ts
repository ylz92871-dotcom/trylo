import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningGrant } from "../../learning/control/coordination-contract.js";
import type { LearningAssetVersion } from "../../learning/control/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import { isCollaborationPlan } from "../../learning/agent/subsystems/collaboration/orchestration/parse.js";
import { isCollaborationExperienceContent } from "../../learning/agent/subsystems/collaboration/experience/schema.js";
import { readCollaborationNoChange } from "../../learning/agent/subsystems/collaboration/orchestration/no-change-receipt.js";
import { isCentralFundedStage } from "./funded-stage.js";
import type { CentralFundedStage, CentralStageObservation } from "./contracts.js";

function deliveredAsset(board: BoardState, asset: LearningAssetVersion, grant: CentralLearningGrant): boolean {
  const content = asset.content;
  if ((!isCollaborationPlan(content) && !isCollaborationExperienceContent(content)) || content.issueId !== grant.issueId
    || content.focusRevision !== grant.focusRevision || asset.scope !== grant.scope || contentHashOf(content) !== asset.contentHash
    || board.tombstones.some(item => item.entityType === "asset" && item.entityId === asset.versionId)) return false;
  return board.proposals.some(item => item.proposalId === asset.createdFromProposalId && item.scope === grant.scope
    && item.domain === "collaboration" && item.candidateRef === asset.versionId);
}

/** A current invocation's immutable version or explicit no_change receipt is required. Completed alone yields no label. */
export async function observeCentralCollaborationStage(options: { readonly boardRoot: string; readonly scope: string },
  input: CentralFundedStage, dispatch: FocusedLearningDispatch | undefined, signal: AbortSignal): Promise<CentralStageObservation> {
  const pending = (reason: string): CentralStageObservation => ({ outcome: "pending", resultRefs: [], sourceRefs: [], reason });

  if (signal.aborted || !isCentralFundedStage(input)) return pending("central_stage_observation_unavailable");

  if (dispatch?.workAttempted !== true || !dispatch.ok || dispatch.status !== "completed" || dispatch.result?.kind !== "completed") {
    return pending("central_stage_completed_dispatch_receipt_required");
  }

  const resultRefs = dispatch.result.resultRefs;
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return pending(loaded.reason);

  const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === input.grantId && item.issueId === input.issueId
    && item.scope === options.scope && (item.domain ?? "collaboration") === "collaboration" && item.budgetId !== undefined);
  if (grant === undefined || dispatch.grantId !== grant.grantId || dispatch.jobId !== grant.jobId) return pending("collaboration_observation_grant_mismatch");

  const job = loaded.state.jobs.find(item => item.jobId === grant.jobId && item.coordination?.grantId === grant.grantId);
  if (job?.state !== "succeeded") return pending("collaboration_proposal_not_confirmed");

  const recordedRefs = resultRefs.filter(ref => job.coordination?.resultRefs?.includes(ref));
  const delivered = loaded.state.assets.filter(asset => recordedRefs.includes(asset.versionId) && deliveredAsset(loaded.state, asset, grant));

  if (signal.aborted) return pending("central_stage_observation_unavailable");

  if (delivered.length > 0) return { outcome: "qualified", resultRefs: delivered.map(asset => asset.versionId),
    sourceRefs: [grant.grantId, job.jobId, ...delivered.map(asset => asset.versionId)], reason: "collaboration_proposal_delivered" };

  const noChanges = recordedRefs.flatMap(ref => {
    const receipt = readCollaborationNoChange(loaded.state, options.scope, ref);
    return receipt?.issueId === input.issueId && receipt.grantId === grant.grantId && receipt.jobId === job.jobId ? [{ ref, receipt }] : [];
  });

  return noChanges.length === 1 ? { outcome: "closed_no_result", resultRefs: [noChanges[0]!.ref],
    sourceRefs: [grant.grantId, job.jobId, noChanges[0]!.ref, ...noChanges[0]!.receipt.sourceRefs], reason: "collaboration_explicit_no_change" }
    : pending("collaboration_proposal_or_no_change_receipt_missing");
}
