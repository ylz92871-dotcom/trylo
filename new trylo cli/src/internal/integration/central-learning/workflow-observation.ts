import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { workflowImprovementsFromBoard } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { workflowImprovementGrantSuffix } from "../../learning/agent/subsystems/workflow/runtime/improvement-identities.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import { isCentralFundedStage } from "./funded-stage.js";
import type { CentralFundedStage, CentralStageObservation } from "./contracts.js";

/** Receipt eligibility is proposal delivery only. Existing approval, handoff adoption and quality assessment stay untouched. */
export async function observeCentralWorkflowStage(options: { readonly boardRoot: string; readonly scope: string; readonly centralScope: string },
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
    && item.scope === options.centralScope && item.domain === "workflow" && item.budgetId !== undefined);
  if (grant === undefined || dispatch.grantId !== grant.grantId || dispatch.jobId !== grant.jobId) return pending("workflow_observation_grant_mismatch");

  const job = loaded.state.jobs.find(item => item.jobId === grant.jobId && item.coordination?.grantId === grant.grantId);
  if (job?.state !== "succeeded") return pending("workflow_proposal_not_confirmed");

  const view = workflowImprovementsFromBoard(loaded.state, options.scope, options.centralScope);
  if (!view.ok) return pending(view.code);

  const issue = loaded.state.learningIssues?.find(item => item.issueId === input.issueId);
  const source = view.value.opportunities.find(item => grant.grantId.endsWith(workflowImprovementGrantSuffix(item.versionId))
    && issue?.reports.some(report => "subsystem" in report.source && report.source.subsystem === "workflow" && report.source.versionId === item.versionId));
  if (source === undefined) return pending("workflow_observation_source_unavailable");

  const delivered = view.value.versions.filter(item => resultRefs.includes(item.versionId)
    && job.coordination?.resultRefs?.includes(item.versionId) && item.status === "eligible"
    && item.artifact.opportunity.opportunityId === source.record.opportunity.opportunityId
    && contentHashOf(item.artifact.opportunity.task) === contentHashOf(source.record.opportunity.task));
  if (delivered.length === 0 || signal.aborted) return pending("workflow_proposal_receipt_missing");

  return { outcome: "qualified", resultRefs: delivered.map(item => item.versionId),
    sourceRefs: [grant.grantId, job.jobId, source.versionId, ...delivered.map(item => item.versionId)], reason: "workflow_proposal_delivered" };
}
