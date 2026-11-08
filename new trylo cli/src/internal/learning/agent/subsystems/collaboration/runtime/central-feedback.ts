import type { BoardState } from "../../../../control/state.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ExperienceBoundaryReceipt, ExperienceUseFeedback } from "../../../../../protocol/collaboration-experience.js";
import type { CollaborationRuntimeReceipt } from "../../../../../protocol/collaboration-resource.js";
import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import { isCollaborationExperienceContent } from "../experience/parse.js";
import { collaborationExperienceSourcesValid } from "../experience/provenance.js";
import { liveExperienceAssets, experienceOwnerFingerprint, COLLABORATION_EXPERIENCE_SELECTION_POLICY } from "../experience/policy.js";
import { isCollaborationPlan, collaborationPlanSourcesValid } from "../orchestration/parse.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { isCollaborationPracticeV2 } from "../domain/v2-parse.js";
import type { LearningIssue } from "../../../../control/coordination-contract.js";

function boundaryRecord(boundary: ExperienceBoundaryReceipt["boundary"]): JsonObject {
  return { executionId: boundary.executionId, taskId: boundary.taskId, round: boundary.round, role: boundary.role,
    ...(boundary.memberId === undefined ? {} : { memberId: boundary.memberId }),
    ...(boundary.teamRunId === undefined ? {} : { teamRunId: boundary.teamRunId }),
    ...(boundary.configurationRef === undefined ? {} : { configurationRef: boundary.configurationRef }),
    ...(boundary.requestId === undefined ? {} : { requestId: boundary.requestId }) };
}

function isUseReceipt(receipt: CollaborationRuntimeReceipt): receipt is ExperienceBoundaryReceipt | ExperienceUseFeedback {
  return receipt.phase === "loaded" || receipt.phase === "dispatched" || receipt.phase === "use_feedback";
}

/** Metadata selects original facts. It cannot supply a body or invent a unit's
 * relation to this issue. Cold V2 facts require their separate archive owner. */
function appendNativeFacts(board: BoardState, issue: LearningIssue, changes: readonly ContentDomainFeedbackChange[],
  records: JsonObject[], sourceRefs: Set<string>) {
  const assets = new Map(board.assets.filter(asset => asset.scope === issue.scope).map(asset => [asset.versionId, asset]));
  const references = new Set(issue.reports.flatMap(report => [report.reportId, ...report.evidenceRefs]));
  const receipts = new Map((board.collaborationRuntimeReceipts ?? []).filter(receipt => receipt.scope === issue.scope).map(receipt => [receipt.receiptId, receipt]));
  const facts = new Map((board.collaborationV2Facts ?? []).filter(fact => fact.scope === issue.scope).map(fact => [fact.factId, fact]));
  const dependencies = new Map((board.learningDependencies ?? []).filter(dependency => dependency.issueId === issue.issueId).map(dependency => [dependency.dependencyId, dependency]));
  const grants = new Map((board.centralLearningGrants ?? []).map(grant => [grant.grantId, grant])), jobs = new Map(board.jobs.map(job => [job.jobId, job]));
  const tombstones = new Map(board.tombstones.filter(tombstone => tombstone.entityType === "asset" || tombstone.entityType === "proposal")
    .map(tombstone => [`${tombstone.entityId}:revision:${tombstone.boardSequence}`, tombstone]));
  const exposureFor = (id: string, versionId: string) => {
    const fact = facts.get(id);
    return fact?.kind === "exposure" && fact.versionId === versionId ? fact : undefined;
  };
  const adoptionFor = (id: string, versionId: string) => { const fact = facts.get(id);
  return fact?.kind === "adoption"
    && exposureFor(fact.exposureId, versionId)?.actionIds.includes(fact.actionId)
    && fact.eventIds.every(ref => facts.get(ref)?.kind === "event") ? fact : undefined; };
  const seen = new Set<string>();

  for (const change of changes) {
    if (change.domain !== "collaboration" || change.issueId !== issue.issueId) continue;

    const key = [change.factRef, change.unitRef, change.revisionRef].join("\0");
    if (seen.has(key)) continue;

    const asset = assets.get(change.unitRef), content = asset?.content;
    const nativeUnit = asset !== undefined && contentHashOf(content) === asset.contentHash
      && (isCollaborationExperienceContent(content) || isCollaborationPlan(content)) && content.issueId === issue.issueId && content.focusRevision <= issue.revision;
    const legacyUnit = asset !== undefined && contentHashOf(content) === asset.contentHash
      && isCollaborationPracticeV2(content) && references.has(asset.versionId);
    let original: unknown, kind: string | undefined;
    const dependency = dependencies.get(change.factRef), tombstone = tombstones.get(change.revisionRef), fact = facts.get(change.factRef), receipt = receipts.get(change.factRef);
    if (change.kind === "dependency" && dependency !== undefined && change.unitRef === dependency.dependencyId
      && change.revisionRef === `${dependency.dependencyId}:revision:${dependency.revision}`) {
      const grant = grants.get(dependency.grantId), job = jobs.get(dependency.jobId);
      if (grant?.scope !== issue.scope || grant.issueId !== issue.issueId || grant.jobId !== dependency.jobId
        || (grant.domain ?? "collaboration") !== "collaboration" || grant.focusRevision > issue.revision || job?.scope !== issue.scope
        || job.domain !== "collaboration" || job.coordination?.issueId !== issue.issueId || job.coordination.grantId !== grant.grantId) continue;
      original = dependency;
      kind = "collaboration_dependency_fact";
    } else if (change.kind === "correction" && tombstone?.entityId === change.factRef && (nativeUnit || legacyUnit)
      && (tombstone.entityType === "asset" ? tombstone.entityId === change.unitRef : tombstone.entityId === asset?.createdFromProposalId)) {
      original = tombstone;
      kind = "collaboration_tombstone_fact";
    } else if (legacyUnit && fact !== undefined && change.revisionRef === fact.factId) {
      const linked = fact.kind === "exposure" && change.kind === "delivery" && fact.versionId === change.unitRef
        || fact.kind === "adoption" && change.kind === "adoption" && adoptionFor(fact.factId, change.unitRef) !== undefined
        || fact.kind === "outcome" && change.kind === "quality" && fact.adoptionIds.some(ref => adoptionFor(ref, change.unitRef) !== undefined)
        || fact.kind === "correction" && change.kind === "correction" && isCollaborationPracticeV2(content) && fact.familyId === content.familyId;
      if (!linked) continue;
      original = fact;
      kind = "collaboration_legacy_fact";
    } else if (nativeUnit && isCollaborationExperienceContent(content) && receipt !== undefined && "versionIds" in receipt
      && receipt.versionIds.includes(change.unitRef) && experienceOwnerFingerprint(receipt.owner) === experienceOwnerFingerprint(content.owner)
      && change.revisionRef === receipt.receiptId && change.kind === (receipt.phase === "use_feedback" ? "quality" : "delivery")) {
      if (receipt.phase === "use_feedback") {
        const dispatched = receipts.get(receipt.usageReceiptId);
        if (dispatched?.phase !== "dispatched" || experienceOwnerFingerprint(dispatched.owner) !== experienceOwnerFingerprint(receipt.owner)
          || dispatched.versionIds.length !== receipt.versionIds.length || !receipt.versionIds.every(ref => dispatched.versionIds.includes(ref))) continue;
      }
      original = receipt;
      kind = "collaboration_use_fact";
    }

    if (kind === undefined) continue;

    seen.add(key);
    records.push({ kind, factRef: change.factRef, unitRef: change.unitRef, revisionRef: change.revisionRef,
      original: JSON.parse(canonicalJson(original)) as JsonObject,
      interpretation: "Original recorded source only; delivery, adoption, approval and attributed quality are distinct and do not establish incremental benefit." });
    sourceRefs.add(change.factRef);
    sourceRefs.add(change.unitRef);
    sourceRefs.add(change.revisionRef);
  }
}

/** Original normal-consumer evidence. Exposure and PA claims are deliberately distinct from independent benefit labels. */
export function projectCollaborationCentralFeedback(board: BoardState, input: {
  readonly scope: string; readonly issueId: string;
  readonly nativeChanges?: readonly ContentDomainFeedbackChange[];
}): { readonly sourceRef: string; readonly sourceRefs: readonly string[]; readonly records: readonly JsonObject[] } | undefined {
  const issue = board.learningIssues?.find(item => item.issueId === input.issueId && item.scope === input.scope);
  if (issue === undefined || learningIssueOwner(issue) !== "collaboration") return undefined;

  const assets = board.assets.filter(asset => asset.scope === input.scope
    && !board.tombstones.some(tombstone => tombstone.entityId === asset.versionId || tombstone.entityId === asset.createdFromProposalId)
    && contentHashOf(asset.content) === asset.contentHash);
  const experiences = assets.filter(asset => isCollaborationExperienceContent(asset.content) && asset.content.issueId === issue.issueId
    && collaborationExperienceSourcesValid(board, input.scope, asset.content));
  const versionIds = new Set(experiences.map(asset => asset.versionId));
  const live = new Set(liveExperienceAssets(board, input.scope).map(asset => asset.versionId));
  const plans = assets.filter(asset => isCollaborationPlan(asset.content) && asset.content.issueId === issue.issueId
    && collaborationPlanSourcesValid(board, input.scope, asset.content));
  const receipts = (board.collaborationRuntimeReceipts ?? []).filter(isUseReceipt).filter(receipt => receipt.scope === input.scope
    && receipt.versionIds.some(versionId => versionIds.has(versionId)));
  const records: JsonObject[] = [{ schema: "collaboration-central-followup/v1", issueId: issue.issueId,
    interpretation: { published: "trial_not_adopted", loaded: "loaded_not_dispatched", dispatched: "exact_request_exposure_not_behavioral_success",
      useFeedback: "PA_attributed_claim_not_independent_verdict", missingFeedback: "unknown_not_zero",
      assessment: "version_and_owner_bound_hypothesis_not_global_rule",
      consumerPolicy: "current_implementation_description_historical_selector_protocol_was_not_recorded" } }];

  for (const asset of experiences) {
    if (!isCollaborationExperienceContent(asset.content)) continue;
    records.push({ kind: "collaboration_experience_version", versionId: asset.versionId, owner: asset.content.owner,
      familyId: asset.content.familyId, currentSelectorHead: live.has(asset.versionId), conditionsJson: canonicalJson(asset.content.conditions),
      consumerPolicyFamilyRef: COLLABORATION_EXPERIENCE_SELECTION_POLICY,
      ...(asset.content.expertVersion === undefined ? {} : { expertVersion: asset.content.expertVersion }),
      ...(asset.content.evaluation === undefined ? {} : { evaluation: asset.content.evaluation }) });
  }

  for (const asset of plans) records.push({ kind: "collaboration_plan_version", versionId: asset.versionId,
    adoption: "not_inferred_from_publication" });

  for (const receipt of receipts) {
    const common = { receiptId: receipt.receiptId, owner: receipt.owner, versionIds: receipt.versionIds,
      relevantVersionIds: receipt.versionIds.filter(versionId => versionIds.has(versionId)), recordedAt: receipt.recordedAt };
    if (receipt.phase === "use_feedback") records.push({ kind: "collaboration_use_feedback", ...common,
      usageReceiptId: receipt.usageReceiptId, outcome: receipt.outcome, summary: receipt.summary, sourceRefs: receipt.sourceRefs,
      ...(receipt.assessments === undefined ? {} : { assessments: receipt.assessments }) });
    else records.push({ kind: `collaboration_${receipt.phase}`, ...common, ownerFingerprint: receipt.ownerFingerprint,
      boundary: boundaryRecord(receipt.boundary) });
  }

  const sourceRefs = new Set([...experiences.map(asset => asset.versionId), ...plans.map(asset => asset.versionId), ...receipts.map(receipt => receipt.receiptId)]);

  if (input.nativeChanges !== undefined) appendNativeFacts(board, issue, input.nativeChanges, records, sourceRefs);

  return { sourceRef: `collaboration-followup:${contentHashOf(records)}`, sourceRefs: [...sourceRefs], records };
}
