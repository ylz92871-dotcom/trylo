import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { record } from "../domain/trace-parse.js";
import type { WorkflowResearchCheckpoint } from "./research-state.js";
import { workflowImprovementGrantSuffix } from "./improvement-identities.js";

/** A syntactically valid cursor still needs its real source and confirmed paid
 * address. Generic asset writes cannot manufacture a free proposal or progress. */
export function workflowResearchCheckpointBound(board: BoardState, checkpoint: WorkflowResearchCheckpoint, centralScope: string): boolean {
  const source = board.assets.find(item => item.versionId === checkpoint.inputVersionId && item.scope === checkpoint.scope && item.kind === "workflow");
  if (source === undefined || !record(source.content) || source.content.type !== "workflow_improvement_opportunity") return false;

  const grant = board.centralLearningGrants?.find(item => item.grantId === checkpoint.grantId && item.domain === "workflow" && item.scope === centralScope);
  const job = board.jobs.find(item => item.jobId === grant?.jobId && item.domain === "workflow"
    && item.coordination?.grantId === grant?.grantId && item.coordination?.issueId === grant?.issueId);
  const issue = board.learningIssues?.find(item => item.issueId === grant?.issueId && item.scope === centralScope);
  const reservation = grant?.reservations.find(item => item.reservationId === checkpoint.reservationId);
  if (grant === undefined || job === undefined || issue === undefined
    || !grant.grantId.endsWith(workflowImprovementGrantSuffix(checkpoint.inputVersionId))
    || !issue.reports.some(item => "subsystem" in item.source && item.source.subsystem === "workflow" && item.source.versionId === checkpoint.inputVersionId)
    || reservation?.state !== "settled" || reservation.usage?.kind !== "reported"
    || !checkpoint.reservationId.endsWith(`:wf-research:${checkpoint.step}`)) return false;

  return checkpoint.status !== "candidate" || contentHashOf(checkpoint.artifact.opportunity) === contentHashOf(source.content.opportunity)
    && checkpoint.artifact.parentVersionId === source.content.parentVersionId;
}
