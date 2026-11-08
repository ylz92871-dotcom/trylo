import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { planVersionId, resultVersionId, toolLearningJobId } from "../domain/evolution/pipeline.js";
import { readToolResearchLineage } from "../domain/evolution/research-lineage.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { selectToolFocusedSource } from "./central-source.js";
import { resultForJob } from "./pipeline-records.js";
import { productionFromBoard } from "./production-assets.js";
import { assetAvailable } from "./pipeline-assets.js";
import { usageLessonsFromBoard, assessedUsageLessonsFromBoard } from "./usage-lessons.js";
import { taskFeedbackFromBoard } from "./tool-task-feedback.js";
import { contractRevisionReviewFromBoard } from "./contract-revisions.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import { nativeToolFeedbackIdentities, readNativeToolFeedbackUnits } from "./central-feedback-native.js";

type Selection = { readonly scope: string; readonly centralScope: string; readonly issueId: string;
  readonly nativeChanges?: readonly ContentDomainFeedbackChange[] };

/** scope is the original tool plan/asset scope; centralScope is issue.scope.
 * No approval, activation, feedback or statistical result is written here. */
export async function readToolCentralFeedback(input: Selection & { readonly boardRoot: string }) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) throw new Error(`tool_central_feedback:${loaded.reason}`);
  return toolCentralFeedbackFromBoard(loaded.state, input);
}

/** Source-bound original history, including explicit negative/unknown feedback.
 * A returned tool, checker receipt, approval and task assessment have separate
 * units. Board receipt coordinates are not re-resolved verifier authority. */
export function toolCentralFeedbackFromBoard(state: BoardState, selection: Selection) {
  const issue = state.learningIssues?.find(item => item.issueId === selection.issueId);
  const source = selectToolFocusedSource(state, issue, selection.scope, selection.centralScope);
  if (!source.ok || issue === undefined) return undefined;

  const records: JsonObject[] = [], sourceRefs = new Set([issue.issueId, planVersionId(source.jobId), ...issue.reports.map(item => item.reportId)]);
  const versions = new Set<string>(), producedVersions = new Set<string>(), decisions = new Set<string>();

  if (source.plan.targetVersionId !== undefined) versions.add(source.plan.targetVersionId);

  const add = (kind: string, unit: string, factRef: string, payload: unknown, metadata: JsonObject = {}) => {
    sourceRefs.add(factRef);
    const identities = typeof metadata.unitRef === "string" && typeof metadata.revisionRef === "string" ? []
      : nativeToolFeedbackIdentities(selection.nativeChanges ?? [], issue.issueId, kind, factRef, payload);
    const append = (identity: JsonObject) => {
      if (typeof identity.unitRef === "string") sourceRefs.add(identity.unitRef);
      if (typeof identity.revisionRef === "string") sourceRefs.add(identity.revisionRef);
      records.push({ kind, unit, factRef, revisionRef: `tool-history:${contentHashOf(payload)}`, ...metadata, ...identity, payloadJson: canonicalJson(payload) });
    };

    if (identities.length === 0) append(metadata);
    else for (const identity of identities) append({ ...identity });
  };
  const lineage = readToolResearchLineage(state, source.plan);
  const episodes = lineage?.plans ?? [source.plan];

  for (const episode of episodes) {
    const episodeJobId = toolLearningJobId(episode), job = state.jobs.find(row => row.jobId === episodeJobId);

    sourceRefs.add(planVersionId(episodeJobId));

    for (let attempt = 1; attempt <= (job?.attempt ?? 0); attempt += 1) {
    const result = resultForJob(state, episodeJobId, attempt);
    if (result === undefined) continue;

    add("tool_learning_attempt", "tool_attempt_proposal_receipt", resultVersionId(episodeJobId, attempt), result);

    if (result.candidateVersionId !== undefined) {
      versions.add(result.candidateVersionId);
      producedVersions.add(result.candidateVersionId);
    }

    if (result.contractProposalId !== undefined) {
      const review = contractRevisionReviewFromBoard(state, result.contractProposalId, selection.scope);
      if (review.ok) {
        versions.add(review.proposal.parentVersionId);
        add("tool_contract_review", "tool_contract_correction_approval", review.proposalId,
          { proposal: review.proposal, revisionId: review.revisionId, approved: review.approved, changes: review.changes });
      } else add("tool_contract_review_unavailable", "tool_contract_correction_read_state", result.contractProposalId,
        { code: review.code, message: review.message });
    }

    if (result.decisionVersionId !== undefined && result.decision !== undefined) {
      const decision = state.assets.find(item => item.versionId === result.decisionVersionId);
      if (decision !== undefined && assetAvailable(state, decision) && recordOf(decision.content)
        && decision.content.type === "tool_learning_decision" && decision.content.jobId === episodeJobId
        && decision.content.attempt === attempt && contentHashOf(decision.content.decision) === contentHashOf(result.decision)) {
        decisions.add(decision.versionId);
        if (typeof decision.content.selectedToolVersionId === "string") versions.add(decision.content.selectedToolVersionId);
      }
    }
  }
  }

  // Generated production packages retain the exact candidate origin. Different
  // npm adaptations intentionally keep separate version identities.
  for (const asset of state.assets) {
    if (asset.kind !== "tool_package") continue;

    const plan = decodeToolProductionPlan(asset.content);
    if (plan?.type !== "tool_production_package" || !versions.has(plan.origin.versionId)) continue;

    const selected = productionFromBoard(state, asset.versionId, plan.workspaceId);
    if (!selected.ok) continue;

    versions.add(asset.versionId);

    if (producedVersions.has(plan.origin.versionId)) producedVersions.add(asset.versionId);
  }

  if (selection.nativeChanges !== undefined) {
    const native = readNativeToolFeedbackUnits(state, { ...selection, plan: source.plan, jobId: source.jobId, versions, producedVersions,
      changes: selection.nativeChanges });
    for (const versionId of native.versions) versions.add(versionId);
    for (const versionId of native.producedVersions) producedVersions.add(versionId);
    for (const record of native.records) add(record.kind, record.unit, record.factRef, record.payload,
      { unitRef: record.unitRef, revisionRef: record.revisionRef, changeKind: record.changeKind });
  }

  for (const versionId of versions) {
    const asset = state.assets.find(item => item.versionId === versionId);
    const proposal = state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);
    if (asset === undefined || proposal === undefined) continue;

    const relation = producedVersions.has(versionId) ? "produced_version" : "source_version";

    add("tool_asset_lifecycle", "tool_version_lifecycle", versionId,
      { versionId, proposalId: proposal.proposalId, contentHash: asset.contentHash, lifecycle: proposal.lifecycle,
        tombstones: state.tombstones.filter(item => item.entityId === versionId || item.entityId === proposal.proposalId) }, { relation });

    for (const approval of state.approvals.filter(item => item.proposalId === proposal.proposalId)) {
      add("tool_approval", "tool_approval_record", approval.approvalId, approval, { versionId });
    }

    for (const activation of state.activations.filter(item => item.versionId === versionId || item.previousVersionId === versionId)) {
      add("tool_activation", "tool_activation_pointer", activation.activationId, activation, { versionId });
    }

    for (const evidence of state.evidence.filter(item => item.proposalId === proposal.proposalId && item.dataVersion === versionId)) {
      add("tool_checker_archive", "tool_archived_check_evidence", evidence.evidenceId, evidence,
        { versionId, authorityResolution: "not_reresolved", economicComparison: "unregistered" });
    }

    const lessons = usageLessonsFromBoard(state, versionId);
    if (lessons.ok) for (const lesson of lessons.lessons.filter(item => decisions.has(item.decisionVersionId))) {
      add("tool_usage_proposal", "tool_conditional_usage_proposal", lesson.decisionVersionId, lesson, { versionId });
    }

    const assessed = assessedUsageLessonsFromBoard(state, versionId);
    if (assessed.ok) for (const lesson of assessed.lessons.filter(item => decisions.has(item.decisionVersionId))) {
      add("tool_usage_standing", "tool_conditional_assessment_standing", lesson.decisionVersionId, lesson, { versionId });
    }

    const uses = (state.toolUses ?? []).filter(item => item.versionId === versionId && item.contentHash === asset.contentHash
      && item.scope === asset.scope);

    for (const use of uses) {
      add("tool_invocation", "tool_execution_return", use.useId, use,
        { relation, observedStageLessonRefs: (use.usageLessonRefs ?? []).filter(ref => decisions.has(ref)), quality: "unverified" });
    }

    const feedback = taskFeedbackFromBoard(state, versionId);
    if (!feedback.ok) throw new Error(`tool_central_feedback:${feedback.code}`);

    const useIds = new Set(uses.map(item => item.useId));

    for (const entry of feedback.entries) {
      if (!entry.feedback.useIds.every(id => useIds.has(id))) continue;
      add("tool_task_assessment", "tool_task_assessment", entry.feedbackVersionId, entry.feedback,
        { relation, source: entry.feedback.source, outcome: entry.feedback.outcome, economicComparison: "unregistered",
          observedStageLessonRefs: [...new Set(uses.filter(use => entry.feedback.useIds.includes(use.useId))
            .flatMap(use => use.usageLessonRefs ?? []).filter(ref => decisions.has(ref)))] });
    }
  }

  return { sourceRef: `tool-central-feedback:${contentHashOf({ issueId: issue.issueId, records })}`,
    sourceRefs: [...sourceRefs].sort(), records };
}
