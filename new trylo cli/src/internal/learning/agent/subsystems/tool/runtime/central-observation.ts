import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { toolLearningFundingClaimBelongsTo } from "../domain/evolution/funding-identity.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { planVersionId, resultVersionId } from "../domain/evolution/pipeline.js";
import { recordOf } from "../domain/evolution/parse.js";
import { selectToolFocusedSource, toolCentralPolicyRef, toolCentralSourceBinding, toolCentralStageAttempt } from "./central-source.js";
import type { ManagedToolStage } from "./central-learning.js";
import { resultForJob } from "./pipeline-records.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { productionFromBoard } from "./production-assets.js";
import { contractRevisionReviewFromBoard } from "./contract-revisions.js";
import { toolAcquisitionDecisionFromBoard } from "./acquisition-decision.js";
import { usageLessonsFromBoard } from "./usage-lessons.js";
import { assetAvailable } from "./pipeline-assets.js";
import { isKnownToolPlanningBoundary, isSettledToolPlanningAttempt } from "../domain/evolution/managed-continuation.js";

/** Read back the exact attempt's delivered proposal through its original readers.
 * This observes proposal delivery; approval, adoption and task benefit remain separate.
 */
export async function observeToolCentralStage(options: { readonly boardRoot: string; readonly scope: string;
  readonly centralScope: string; readonly modelRef: string; readonly mode: "manual" | "after_turn" },
  input: ManagedToolStage, signal: AbortSignal) {
  const sourceRefs = [input.issueId, input.grantId, input.stageRef, input.sourceBindingRef];
  const pending = (reason: string) => ({ outcome: "pending" as const, reason, sourceRefs, resultRefs: [] });

  if (signal.aborted) return pending("learning_observation_cancelled");

  const stage = toolCentralStageAttempt(input.stageRef);
  const policyRef = toolCentralPolicyRef(options.mode, options.modelRef);
  if (stage === undefined || input.policyRef !== policyRef || input.sourceBindingRef !== toolCentralSourceBinding(stage.jobId, input.stageRef, policyRef)) {
    return pending("tool_observation_stage_binding");
  }

  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return pending(loaded.reason);

  const state = loaded.state, issue = state.learningIssues?.find(item => item.issueId === input.issueId);
  const report = issue?.reports.find(item => "subsystem" in item.source && item.source.subsystem === "tool"
    && item.source.versionId === stage.jobId);
  const source = selectToolFocusedSource(state, issue === undefined || report === undefined ? undefined : { ...issue, reports: [report] },
    options.scope, options.centralScope);
  const grant = state.centralLearningGrants?.find(item => item.grantId === input.grantId && item.issueId === input.issueId
    && item.domain === "tool" && item.scope === options.centralScope && item.budgetId !== undefined);
  if (!source.ok || source.jobId !== stage.jobId || source.grantId !== input.grantId || grant === undefined) return pending("tool_observation_source_binding");

  sourceRefs.push(planVersionId(stage.jobId));
  const result = resultForJob(state, stage.jobId, stage.attempt);
  if (result === undefined) return pending("tool_original_attempt_result_pending");

  const resultRefs = [resultVersionId(stage.jobId, stage.attempt)];
  const qualified = (reason: string) => ({ outcome: "qualified" as const, reason, sourceRefs, resultRefs });

  if (result.candidateVersionId !== undefined) {
    const versionId = result.candidateVersionId;
    const raw = decodeToolProductionPlan(state.assets.find(item => item.versionId === versionId)?.content);
    const candidate = raw === undefined ? candidateFromBoard(state, versionId) : productionFromBoard(state, versionId, raw.workspaceId);
    if (candidate.ok) {
      resultRefs.push(versionId);
      return qualified("tool_candidate_proposal_delivered");
    }
    return pending("tool_candidate_proposal_unavailable");
  }

  if (result.contractProposalId !== undefined) {
    const proposal = contractRevisionReviewFromBoard(state, result.contractProposalId, options.scope);
    if (proposal.ok) {
      resultRefs.push(result.contractProposalId);
      return qualified("tool_contract_correction_proposal_delivered");
    }
    return pending("tool_contract_proposal_unavailable");
  }

  if (result.decision?.action === "acquire") {
    const request = toolAcquisitionDecisionFromBoard(state, stage.jobId, options.scope, stage.attempt);
    if (request.ok) {
      resultRefs.push(request.approvalId);
      return qualified("tool_acquisition_proposal_delivered");
    }
    return pending("tool_acquisition_proposal_unavailable");
  }

  if (result.decision?.action === "reuse" || result.decision?.action === "refine") {
    const decision = state.assets.find(item => item.versionId === result.decisionVersionId);
    const versionId = decision !== undefined && assetAvailable(state, decision) && recordOf(decision.content)
      && typeof decision.content.selectedToolVersionId === "string" ? decision.content.selectedToolVersionId : undefined;
    const lessons = versionId === undefined ? undefined : usageLessonsFromBoard(state, versionId);
    if (lessons?.ok && lessons.lessons.some(item => item.decisionVersionId === result.decisionVersionId)) {
      resultRefs.push(result.decisionVersionId!);
      return qualified("tool_conditioned_usage_proposal_delivered");
    }

    if (versionId === undefined && decision !== undefined && assetAvailable(state, decision) && result.cleanupCode === undefined
      && isSettledToolPlanningAttempt(state, stage.jobId, stage.attempt)) {
      resultRefs.push(result.decisionVersionId!);
      return { outcome: "closed_no_result" as const, reason: "tool_runtime_reuse_without_versioned_usage_proposal", sourceRefs, resultRefs };
    }

    return pending("tool_usage_proposal_binding_pending");
  }

  const reservations = grant.reservations.filter(item => toolLearningFundingClaimBelongsTo(source.plan, stage.jobId, stage.attempt, item.claimId));

  if (isKnownToolPlanningBoundary(state, stage.jobId, resultVersionId(stage.jobId, stage.attempt))) {
    return { outcome: "closed_no_result" as const, reason: "tool_planning_returned_unqualified_without_proposal", sourceRefs, resultRefs };
  }

  const closed = result.outcome === "succeeded" && result.decision?.action === "defer" && result.decision.reason === "not_worthwhile"
    && result.cleanupCode === undefined && reservations.length > 0
    && reservations.every(item => item.state === "settled" && item.usage?.kind === "reported")
    && (grant.claim === undefined || !toolLearningFundingClaimBelongsTo(source.plan, stage.jobId, stage.attempt, grant.claim.claimId));

  return closed ? { outcome: "closed_no_result" as const, reason: "tool_attempt_closed_without_new_proposal", sourceRefs, resultRefs }
    : pending("tool_attempt_or_final_receipt_pending");
}
