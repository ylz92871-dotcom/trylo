import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { record, text, workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovement, WorkflowImprovementFeedback } from "../improvement/contracts.js";
import { parseWorkflowImprovement, parseWorkflowImprovementEvidence, parseWorkflowImprovementFeedback, parseWorkflowOpportunity, parseWorkflowProcessTask } from "../improvement/parse.js";
import { latestWorkflowImprovement, workflowCorrectionAllows } from "../runtime/improvement-lineage.js";
import { improvementApplies } from "../improvement/validation.js";
import { selectWorkflowImprovement } from "../runtime/improvement-selection.js";
import type { WorkflowImprovementBoardContent, WorkflowImprovementBoardView, WorkflowImprovementUseRecord, WorkflowImprovementPublishOwner, WorkflowImprovementDispatchPolicy, WorkflowImprovementAdoption } from "../runtime/improvement-contracts.js";
import { workflowImprovementGrantSuffix, workflowImprovementRecordId } from "../runtime/improvement-identities.js";
import { workflowAssetSelfVisibility, workflowAssetVisibilityIndex, workflowForgottenAssetIds } from "../runtime/asset-visibility.js";
import { parseWorkflowResearchCheckpoint, type WorkflowResearchHead } from "../runtime/research-state.js";
import { workflowResearchCheckpointBound } from "../runtime/research-relations.js";

export { workflowImprovementRecordId } from "../runtime/improvement-identities.js";

export type { WorkflowImprovementOpportunityRecord, WorkflowImprovementUseRecord, WorkflowImprovementBoardContent, WorkflowImprovementBoardView } from "../runtime/improvement-contracts.js";

function scopeOf(content: WorkflowImprovementBoardContent): string {
  if (content.type === "workflow_improvement_research") return content.scope;
  return content.type === "workflow_improvement" || content.type === "workflow_improvement_opportunity" ? content.opportunity.task.scope
    : content.type === "workflow_improvement_use" ? content.use.task.scope : content.feedback.task.scope;
}

/** Shared Board remains the only writer. These data records never create an active pointer. */
export async function saveWorkflowImprovementRecord(store: BoardStore, content: WorkflowImprovementBoardContent, issuedAt: string,
  mayCommit?: () => boolean): Promise<WorkflowLearningResult<{ readonly versionId: string }>> {
  const parsed = parseContent(content);
  if (!parsed.ok) return parsed;

  if (contentHashOf(parsed.value) !== contentHashOf(content)) return workflowFailure("workflow_improvement_noncanonical", "Only canonical validated improvement records may be written");

  const versionId = workflowImprovementRecordId(content), scope = scopeOf(content), hash = contentHashOf(content);
  const loaded = await store.load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

  if (content.type === "workflow_improvement_research") {
    const centralScope = loaded.state.centralLearningGrants?.find(item => item.grantId === content.grantId)?.scope ?? content.scope;
    if (!workflowResearchCheckpointBound(loaded.state, content, centralScope)) return workflowFailure("workflow_research_source_conflict",
      "A checkpoint requires its original source and a confirmed settled research reservation");
  }

  const previous = loaded.state.assets.find(item => item.versionId === versionId);
  if (previous !== undefined) return available(loaded.state, versionId) && previous.scope === scope && previous.kind === "workflow"
    && previous.contentHash === hash && contentHashOf(previous.content) === hash
    ? { ok: true, value: { versionId } } : workflowFailure("workflow_improvement_conflict", "An immutable record differs or was withdrawn");

  const proposalId = `proposal:${versionId}`;
  const commands: readonly BoardCommand[] = [
    { type: "submit_proposal", commandId: `${proposalId}:submit`, issuedAt, proposal: {
      proposalId, domain: "workflow", scope, assetKind: "workflow", candidateRef: versionId,
      hypothesis: "Proposed workflow change or observed use; benefit requires attributed feedback", observationRefs: [],
      risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred",
    } },
    { type: "commit_asset", commandId: `${proposalId}:commit`, issuedAt, proposalId, versionId, content, schemaVersion: 1 },
  ];

  for (const command of commands) {
    if (mayCommit !== undefined && !mayCommit()) return workflowFailure("cancelled", "Workflow write was cancelled before its commit boundary");
    const applied = await store.apply(command);
    if (!applied.ok) return workflowFailure(applied.reason, applied.detail);
  }

  return { ok: true, value: { versionId } };
}

export async function commitWorkflowImprovementRecord(boardRoot: string, content: WorkflowImprovementBoardContent, issuedAt: string, signal?: AbortSignal) {
  const saved = await withBoardWriter(boardRoot, store => saveWorkflowImprovementRecord(store, content, issuedAt, () => signal?.aborted !== true));
  return "reason" in saved ? workflowFailure(saved.reason, saved.detail) : saved;
}

/** Selection and use commit share a snapshot; a late correction cannot be missed at the handoff. */
export async function commitWorkflowImprovementUse(boardRoot: string, record: WorkflowImprovementUseRecord, issuedAt: string, signal?: AbortSignal,
  dispatchPolicy?: WorkflowImprovementDispatchPolicy, centralScope?: string) {
  const saved = await withBoardWriter(boardRoot, async (store): Promise<WorkflowLearningResult<WorkflowImprovementAdoption>> => {
    if (signal?.aborted) return workflowFailure("cancelled", "The handoff closed before adoption");

    const loaded = await store.load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

    const view = workflowImprovementsFromBoard(loaded.state, record.use.task.scope, centralScope);
    if (!view.ok) return view;

    const policy = dispatchPolicy?.(record.use.task, view.value.sourceVisibility);
    if (policy !== undefined && !policy.ok) return policy;

    if (policy?.ok && policy.value.kind !== "allowed") return workflowFailure("workflow_improvement_dispatch_deferred", "Current host governance does not allow this handoff");

    const current = selectWorkflowImprovement(view.value, record.use.task, { versionId: record.use.versionId });
    if (current === undefined) return workflowFailure("workflow_improvement_handoff_stale", "The selected procedure no longer meets the current lineage, correction floor or observed standing");

    const written = await saveWorkflowImprovementRecord(store, record, issuedAt, () => signal?.aborted !== true);

    return !written.ok ? written : { ok: true, value: { ...written.value,
      ...(policy?.ok && policy.value.kind === "allowed" ? { dispatchChecked: true as const,
        ...(policy.value.guidance === undefined ? {} : { hostGuidance: policy.value.guidance }) } : {}) } };
  });
  return "reason" in saved ? workflowFailure(saved.reason, saved.detail) : saved;
}

/** A late researcher cannot publish a child after a newer correction or revision won. */
export async function commitWorkflowImprovementRevision(boardRoot: string, artifact: WorkflowImprovement, issuedAt: string,
  owner: WorkflowImprovementPublishOwner) {
  const saved = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

    if (!available(loaded.state, owner.reservation.inputVersionId)) {
      return workflowFailure("workflow_improvement_source_unavailable", "The saved research input was withdrawn before publication");
    }

    const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === owner.reservation.grantId);
    const job = loaded.state.jobs.find(item => item.jobId === owner.reservation.jobId);
    const issue = loaded.state.learningIssues?.find(item => item.issueId === grant?.issueId);
    if (owner.signal.aborted || grant?.status !== "open" || grant.domain !== "workflow" || grant.scope !== (owner.centralScope ?? artifact.opportunity.task.scope)
      || grant.claim?.claimId !== owner.reservation.claimId || Date.parse(grant.claim.expiresAt) <= owner.now()
      || issue?.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision
      || issue.grantId !== grant.grantId || issue.jobId !== job?.jobId
      || owner.reservation.expectedIssueRevision !== undefined && issue.revision !== owner.reservation.expectedIssueRevision
      || job?.state !== "running") return workflowFailure("learning_claim_conflict", "A cancelled or stale worker cannot publish its proposal");

    const view = workflowImprovementsFromBoard(loaded.state, artifact.opportunity.task.scope, owner.centralScope);
    if (!view.ok) return view;

    const latest = latestWorkflowImprovement(view.value.versions, artifact.opportunity);
    if (latest?.versionId !== artifact.parentVersionId) return workflowFailure("workflow_improvement_stale_parent", "A newer problem revision committed before this worker");

    if (!workflowCorrectionAllows(view.value.versions, view.value.opportunities, artifact.opportunity, artifact.parentVersionId)) {
      return workflowFailure("workflow_correction_pending", "A later correction must be incorporated before publishing older research");
    }

    const committed = await saveWorkflowImprovementRecord(store, artifact, issuedAt, () => !owner.signal.aborted);
    if (!committed.ok) return committed;

    // Finishing under this same writer closes the cancellation gap between the
    // immutable proposal and its usable result reference. A crash leaves an
    // unfieldable data record until its central outcome is explicitly recovered.
    const finished = await store.apply({ type: "coordinate_learning", issuedAt: new Date(owner.now()).toISOString(),
      commandId: `workflow-publish:${owner.reservation.jobId}:${committed.value.versionId}`, action: { kind: "finish",
        jobId: owner.reservation.jobId, claimId: owner.reservation.claimId, expectedIssueRevision: issue.revision,
        result: { kind: "completed", resultRefs: [committed.value.versionId] } } });

    return finished.ok ? committed : workflowFailure(finished.reason, finished.detail);
  });
  return "reason" in saved ? workflowFailure(saved.reason, saved.detail) : saved;
}

function available(state: BoardState, id: string): boolean {
  return workflowAssetSelfVisibility(state, id) === "available" && !workflowForgottenAssetIds(state).has(id);
}

function parseContent(value: unknown): WorkflowLearningResult<WorkflowImprovementBoardContent> {
  if (!record(value) || value.schemaVersion !== 1) return workflowFailure("workflow_improvement_corrupt", "Unknown improvement record schema");

  if (value.type === "workflow_improvement") return parseWorkflowImprovement(value);

  if (value.type === "workflow_improvement_research") return parseWorkflowResearchCheckpoint(value);

  if (value.type === "workflow_improvement_opportunity") {
    const opportunity = parseWorkflowOpportunity(value.opportunity), evidence = parseWorkflowImprovementEvidence(value.evidence);
    if (!opportunity.ok) return opportunity;
    if (!evidence.ok) return evidence;
    if (value.parentVersionId !== undefined && !text(value.parentVersionId)) return workflowFailure("workflow_improvement_corrupt", "Invalid parent identity");
    return { ok: true, value: { type: value.type, schemaVersion: 1, opportunity: opportunity.value, evidence: evidence.value,
      ...(value.parentVersionId === undefined ? {} : { parentVersionId: value.parentVersionId }) } };
  }

  if (value.type === "workflow_improvement_feedback") {
    const feedback = parseWorkflowImprovementFeedback(value.feedback);
    return feedback.ok ? { ok: true, value: { type: value.type, schemaVersion: 1, feedback: feedback.value } } : feedback;
  }

  if (value.type !== "workflow_improvement_use" || !record(value.use) || !text(value.use.useId)
    || !text(value.use.versionId) || !text(value.use.boundary) || !text(value.sessionId)
    || typeof value.afterSequence !== "number" || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) {
    return workflowFailure("workflow_improvement_corrupt", "Invalid frozen use");
  }

  const task = parseWorkflowProcessTask(value.use.task);

  return task.ok ? { ok: true, value: { type: value.type, schemaVersion: 1, sessionId: value.sessionId, afterSequence: value.afterSequence,
    use: { useId: value.use.useId, versionId: value.use.versionId, boundary: value.use.boundary, task: task.value } } } : task;
}

/** Immutable arrival order is preserved; malformed owned content fails closed. */
export function workflowImprovementsFromBoard(state: BoardState, scope: string, centralScope = scope): WorkflowLearningResult<WorkflowImprovementBoardView> {
  const versions: WorkflowImprovementBoardView["versions"][number][] = [];
  const opportunities: WorkflowImprovementBoardView["opportunities"][number][] = [];
  const uses: WorkflowImprovementUseRecord[] = [], feedback: WorkflowImprovementFeedback[] = [], research: WorkflowResearchHead[] = [];
  const forgottenVersions = new Set<string>(), forgottenUses = new Set<string>();
  const visibility = workflowAssetVisibilityIndex(state);
  const forgotten = new Set([...visibility].filter(([, value]) => value === "forgotten").map(([id]) => id));

  for (const asset of state.assets) {
    if (asset.scope !== scope || !record(asset.content) || !forgotten.has(asset.versionId)) continue;
    if (asset.content.type === "workflow_improvement") forgottenVersions.add(asset.versionId);
    if (asset.content.type === "workflow_improvement_use" && record(asset.content.use) && text(asset.content.use.useId)) forgottenUses.add(asset.content.use.useId);
  }

  for (const item of state.tombstones) if (item.entityType === "asset") forgottenVersions.add(item.entityId);

  for (const asset of state.assets) {
    if (asset.scope !== scope || !record(asset.content) || typeof asset.content.type !== "string"
      || !asset.content.type.startsWith("workflow_improvement") || forgotten.has(asset.versionId)) continue;

    const parsed = parseContent(asset.content);
    if (!parsed.ok) return parsed;

    if (asset.kind !== "workflow" || scopeOf(parsed.value) !== scope || contentHashOf(parsed.value) !== asset.contentHash
      || asset.versionId !== workflowImprovementRecordId(parsed.value)) return workflowFailure("workflow_improvement_corrupt", "Stored improvement identity differs from content");

    const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
    if (proposal === undefined || proposal.domain !== "workflow" || proposal.scope !== scope || proposal.assetKind !== "workflow") {
      return workflowFailure("workflow_improvement_corrupt", "An improvement record has no matching owning proposal");
    }

    const ownVisibility = workflowAssetSelfVisibility(state, asset.versionId);
    if (ownVisibility === "unknown" || visibility.get(asset.versionId) === "unknown") {
      return workflowFailure("workflow_improvement_corrupt", "An improvement record has unavailable owning metadata or missing provenance");
    }

    const item = parsed.value;
    if (item.type === "workflow_improvement") {
      const completed = state.jobs.some(job => job.domain === "workflow" && (job.scope === scope || job.scope === centralScope) && job.state === "succeeded"
        && job.coordination?.resultRefs?.includes(asset.versionId));
      versions.push({ versionId: asset.versionId, artifact: item,
        status: !completed ? "unsettled" : ownVisibility === "available" ? "eligible" : "blocked" });
    }
    // Withdrawn nominations no longer impose a correction floor. Their immutable
    // history remains in Board; it must not keep ordinary new work blocked.
    else if (item.type === "workflow_improvement_opportunity") {
      if (ownVisibility === "available") opportunities.push({ versionId: asset.versionId, record: item });
    }
    else if (item.type === "workflow_improvement_use") {
      if (forgottenVersions.has(item.use.versionId)) forgottenUses.add(item.use.useId);
      else uses.push(item);
    }
    else if (item.type === "workflow_improvement_research") {
      if (!workflowResearchCheckpointBound(state, item, centralScope)) return workflowFailure("workflow_research_corrupt", "Research cursor has no matching original source, grant or confirmed step");
      if (ownVisibility === "available" && visibility.get(asset.versionId) === "available") research.push({ versionId: asset.versionId, record: item });
    }
    else if (ownVisibility === "available") feedback.push(item.feedback);
  }

  for (const item of uses) {
    const version = versions.find(candidate => candidate.versionId === item.use.versionId);
    if (version === undefined || !improvementApplies(version.artifact, item.use.task)) {
      return workflowFailure("workflow_improvement_corrupt", "A frozen use must bind an available version and its applicable task contract");
    }
  }

  const retainedFeedback = feedback.filter(item => !forgottenUses.has(item.useId) && !forgottenVersions.has(item.versionId));

  for (const item of retainedFeedback) {
    const use = uses.find(candidate => candidate.use.useId === item.useId);
    if (use === undefined || item.versionId !== use.use.versionId || contentHashOf(item.task) !== contentHashOf(use.use.task)
      || !item.executionId.startsWith(`${use.sessionId}/`)) {
      return workflowFailure("workflow_improvement_corrupt", "Feedback differs from its real session, frozen version or task contract");
    }
  }

  const recentIssues = opportunities.slice(-8).map(item => {
    const grant = [...(state.centralLearningGrants ?? [])].reverse().find(candidate => candidate.domain === "workflow"
      && (candidate.scope === scope || candidate.scope === centralScope) && candidate.grantId.endsWith(workflowImprovementGrantSuffix(item.versionId)));
    const job = state.jobs.find(candidate => candidate.jobId === grant?.jobId);

    return { opportunityVersionId: item.versionId, opportunityId: item.record.opportunity.opportunityId,
      issueKey: item.record.opportunity.issueKey, task: item.record.opportunity.task, trigger: item.record.opportunity.trigger,
      problem: item.record.opportunity.problem, proposalState: job?.state ?? "unfunded" as const,
      ...(grant === undefined ? {} : { grantId: grant.grantId, jobId: grant.jobId,
        ...(grant.closedReason === undefined ? {} : { reason: grant.closedReason }) }) };
  });

  return { ok: true, value: { versions, opportunities, uses, feedback: retainedFeedback, recentIssues, research,
    sourceVisibility: Object.fromEntries(visibility) } };
}

export async function readWorkflowImprovements(boardRoot: string, scope: string, centralScope?: string) {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? workflowImprovementsFromBoard(loaded.state, scope, centralScope) : workflowFailure(loaded.reason, loaded.detail);
}
