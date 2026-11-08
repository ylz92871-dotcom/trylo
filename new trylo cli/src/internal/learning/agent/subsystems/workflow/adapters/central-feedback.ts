import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { workflowFamilyKey, workflowConditionKey } from "../domain/family.js";
import { workflowImprovementReputation } from "../improvement/reputation.js";
import { workflowImprovementsFromBoard } from "./improvement-board.js";
import { workflowImprovementRecordId } from "../runtime/improvement-identities.js";
import { WORKFLOW_IMPROVEMENT_SELECTION_POLICY } from "../runtime/improvement-selection.js";
import { workflowResearchProgressFromBoard } from "./research-progress.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import { readWorkflowNativeFeedbackBodies } from "./central-feedback-changes.js";

/** Read-only original-consumer feedback, kept separate from proposal delivery and central numerical value labels.
 * The complete projection changes only when its own source/use/feedback heads change, not on unrelated Board writes.
 */
export function projectWorkflowCentralFeedback(board: BoardState, input: {
  readonly scope: string; readonly issueId: string;
  readonly nativeChanges?: readonly ContentDomainFeedbackChange[];
}): { readonly sourceRef: string; readonly sourceRefs: readonly string[]; readonly records: readonly JsonObject[] } | undefined {
  const legacy = projectLegacyWorkflowCentralFeedback(board, input);

  if (input.nativeChanges === undefined) return legacy;

  const native = readWorkflowNativeFeedbackBodies(board, { ...input, nativeChanges: input.nativeChanges });
  if (native.records.length === 0) return legacy;

  const records = [...legacy?.records ?? [], ...native.records];

  return { sourceRef: `workflow-followup:${contentHashOf(records)}`,
    sourceRefs: [...new Set([...legacy?.sourceRefs ?? [], ...native.sourceRefs])], records };
}

function projectLegacyWorkflowCentralFeedback(board: BoardState, input: { readonly scope: string; readonly issueId: string }) {
  const issue = board.learningIssues?.find(item => item.issueId === input.issueId && item.scope === input.scope);
  if (issue === undefined) return undefined;

  const originalSources = new Set(issue.reports.flatMap(report => "subsystem" in report.source && report.source.subsystem === "workflow" ? [report.source.versionId] : []));
  const assetScopes = [...new Set(board.assets.filter(asset => originalSources.has(asset.versionId)).map(asset => asset.scope))];
  if (assetScopes.length !== 1) return undefined;

  const view = workflowImprovementsFromBoard(board, assetScopes[0]!, input.scope);
  if (!view.ok) return undefined;

  const sources = view.value.opportunities.filter(source => originalSources.has(source.versionId));
  const grants = (board.centralLearningGrants ?? []).filter(grant => grant.issueId === issue.issueId && grant.scope === input.scope && grant.domain === "workflow");
  const resultRefs = new Set(board.jobs.filter(job => grants.some(grant => grant.jobId === job.jobId && job.coordination?.grantId === grant.grantId))
    .flatMap(job => job.coordination?.resultRefs ?? []));
  const versions = view.value.versions.filter(version => resultRefs.has(version.versionId) && sources.some(source =>
    source.record.opportunity.opportunityId === version.artifact.opportunity.opportunityId));
  const versionIds = new Set(versions.map(version => version.versionId));
  const uses = view.value.uses.filter(use => versionIds.has(use.use.versionId));
  const useIds = new Set(uses.map(use => use.use.useId));
  const feedback = view.value.feedback.filter(item => versionIds.has(item.versionId) && useIds.has(item.useId));
  const records: JsonObject[] = [{ schema: "workflow-central-followup/v1", issueId: issue.issueId,
    interpretation: { frozenUse: "selection_at_a_real_handoff_not_proof_of_following", reportedUsed: "model_claim_with_bound_post_use_receipts",
      quality: "independent_host_or_user_channel_only", comparison: "original_paired_measurement_units_not_central_gain",
      missingFeedback: "unknown_not_zero", reputation: "original_domain_estimator_not_a_central_value_label",
      consumerPolicy: "current_implementation_description_historical_selector_protocol_was_not_recorded" } }];
  const research = workflowResearchProgressFromBoard(board, { scope: assetScopes[0]!, centralScope: input.scope, issueId: issue.issueId });
  if (research !== undefined) records.push({ kind: "workflow_research_progress", progressJson: JSON.stringify(research),
    handback: research.handback.kind, checkpointRef: research.checkpointRef });

  for (const version of versions) records.push({ kind: "workflow_version", versionId: version.versionId, sourceStatus: version.status,
    consumerPolicyFamilyRef: WORKFLOW_IMPROVEMENT_SELECTION_POLICY, processKey: version.artifact.opportunity.task.process?.key ?? null,
    taskFamilyKey: workflowFamilyKey(version.artifact.opportunity.task.taskFamily), conditionKey: workflowConditionKey(version.artifact.opportunity.task.conditions),
    reputation: workflowImprovementReputation(version.artifact, feedback, version.versionId, version.artifact.opportunity.task) });

  for (const use of uses) records.push({ kind: "workflow_frozen_use", recordRef: workflowImprovementRecordId(use),
    useId: use.use.useId, versionId: use.use.versionId, boundary: use.use.boundary, sessionId: use.sessionId, afterSequence: use.afterSequence,
    taskRef: contentHashOf(use.use.task), conditionKey: workflowConditionKey(use.use.task.conditions), selectorProtocolAtUse: "not_recorded" });

  for (const item of feedback) records.push({ kind: "workflow_feedback",
    recordRef: workflowImprovementRecordId({ type: "workflow_improvement_feedback", schemaVersion: 1, feedback: item }),
    feedbackId: item.feedbackId, useId: item.useId, versionId: item.versionId, executionId: item.executionId, exposure: item.exposure,
    quality: item.quality, evidenceRefs: item.evidenceRefs, followedStepIds: item.followedStepIds, explanation: item.explanation,
    processEvidence: item.processEvidence ?? { kind: "unverified" }, ...(item.userAssessment === undefined ? {} : { userAssessment: item.userAssessment }),
    ...(item.comparison === undefined ? {} : { comparison: item.comparison }) });

  const sourceRefs = [...new Set([...sources.map(source => source.versionId), ...versions.map(version => version.versionId),
    ...(research?.sourceRefs ?? []),
    ...records.flatMap(record => typeof record.recordRef === "string" ? [record.recordRef] : [])])];

  return { sourceRef: `workflow-followup:${contentHashOf(records)}`, sourceRefs, records };
}
