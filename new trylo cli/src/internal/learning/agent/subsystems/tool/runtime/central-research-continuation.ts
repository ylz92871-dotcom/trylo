import type { CentralResearchContinuationInput, CentralResearchContinuation } from "../../../../../integration/central-learning/research-intake-continuation.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isKnownToolPlanningBoundary, isManagedToolCheckpointContinuation } from "../domain/evolution/managed-continuation.js";
import { planVersionId, resultVersionId } from "../domain/evolution/pipeline.js";
import { selectToolFocusedSource, toolCentralSourceBinding, toolCentralStageAttempt } from "./central-source.js";
import { resultForJob } from "./pipeline-records.js";
import { waitingToolJobReady } from "./pipeline-queue.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";

type Options = { readonly workspaceId: string; readonly mode: "manual" | "after_turn";
  readonly executionAuthorized: boolean; readonly explicitResume?: boolean };

/** Pure owner readiness against the actual preceding assignment. The shared
 * reception owner separately binds that assignment to its exact programRef. */
export function readToolCentralContinuation(input: CentralResearchContinuationInput, options: Options): CentralResearchContinuation {
  const { board, lastStage } = input, issue = board.learningIssues?.find(row => row.issueId === input.issueId);
  const refs = [input.issueId, input.grantId];
  const wait = (reason: string): CentralResearchContinuation => ({ kind: "waiting", reason, sourceRefs: refs });
  const inspect = (reason: string): CentralResearchContinuation => ({ kind: "inspection", reason, sourceRefs: refs });
  const source = selectToolFocusedSource(board, issue, options.workspaceId, input.scope);
  if (!source.ok || issue === undefined) return inspect(source.ok ? "tool_continuation_source_missing" : source.code);

  refs.push(planVersionId(source.jobId));
  const grant = board.centralLearningGrants?.find(row => row.grantId === input.grantId);
  if (grant === undefined || grant.grantId !== source.grantId || grant.budgetId === undefined
    || !toolFundingGrantMatches(board, source.plan, grant) || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId
    || issue.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision) return inspect("tool_continuation_grant_binding");

  const planningBoundary = isKnownToolPlanningBoundary(board, source.jobId, resultVersionId(source.jobId, source.job.attempt));
  if (grant.status !== "open" || ["succeeded", "cancelled", "expired"].includes(source.job.state)
    || source.job.state === "failed" && !planningBoundary || source.job.breakerOpen) {
    return { kind: "terminal", reason: "tool_continuation_original_terminal", sourceRefs: refs };
  }

  // The shared reader supplies a canonical archived frame. Recheck its native
  // digest and assignment coordinates without introducing another frame schema.
  const { digest, ...frame } = lastStage;

  if (digest !== contentHashOf(frame)) return inspect("tool_continuation_assignment_binding");

  const report = issue.reports.find(row => row.reportId === lastStage.candidate.source.domainStage.sourceReportId);
  const assignment = toolCentralStageAttempt(lastStage.input.stageRef);
  if (lastStage.scope !== input.scope || lastStage.budgetId !== grant.budgetId
    || lastStage.input.issueId !== issue.issueId || lastStage.input.grantId !== grant.grantId
    || lastStage.input.offer.owner.plane !== "agent" || lastStage.input.offer.owner.domain !== "tool"
    || lastStage.candidate.source.issueId !== issue.issueId || lastStage.candidate.source.grantId !== grant.grantId
    || report === undefined || contentHashOf(report) !== lastStage.sourceReportHash || assignment?.jobId !== source.jobId
    || lastStage.input.sourceBindingRef !== toolCentralSourceBinding(source.jobId, lastStage.input.stageRef, lastStage.input.policyRef)) {
    return inspect("tool_continuation_assignment_binding");
  }

  if (assignment.attempt !== source.job.attempt) return wait("tool_continuation_assignment_not_returned");

  if (grant.claim !== undefined || source.job.state === "running" || grant.reservations.some(row => row.state === "reserved")) {
    return wait("tool_continuation_original_worker_in_flight");
  }

  const result = resultForJob(board, source.jobId, source.job.attempt);
  if (result === undefined) return inspect("tool_continuation_original_result_missing");

  const cursorRef = resultVersionId(source.jobId, result.attempt);
  refs.push(cursorRef);

  if (lastStage.candidate.source.domainStage.readiness.evidenceRefs.includes(cursorRef)) return wait("tool_continuation_cursor_already_consumed");

  // savePipelineAsset's original canonical commit identity is retained when
  // available. Do not infer a sequence from timestamps or older archive forms.
  const committed = board.appliedCommands.find(row => row.commandId === `proposal:${cursorRef}:commit`);
  if (committed !== undefined && committed.sequence <= lastStage.committedAtSequence) return wait("tool_continuation_result_precedes_assignment");

  if (!isManagedToolCheckpointContinuation(board, source.jobId, cursorRef)) return wait("tool_continuation_checkpoint_not_resumable");

  if (!planningBoundary && !waitingToolJobReady(board, source.job, source.plan, options.mode, options.executionAuthorized, options.explicitResume === true)) {
    return wait("tool_continuation_original_evidence_or_authorization_required");
  }

  return { kind: "continuable", cursorRef, sourceRefs: refs };
}
