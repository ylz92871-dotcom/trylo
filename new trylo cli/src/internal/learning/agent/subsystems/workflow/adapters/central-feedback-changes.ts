import type { ContentDomainFeedbackChange } from "../../../../../integration/learning-content/sources/domain-feedback.js";
import type { BoardState } from "../../../../control/state.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { learningIssueOwner } from "../../../../control/learning-issue-owner.js";
import { identity, sequence } from "../../../../../validation/json-shape.js";
import { record, text } from "../domain/trace-parse.js";
import { workflowAssetVisibilityIndex } from "../runtime/asset-visibility.js";
import { parseWorkflowImprovement, parseWorkflowImprovementFeedback, parseWorkflowOpportunity, parseWorkflowProcessTask } from "../improvement/parse.js";
import { improvementApplies, workflowProcessMatches } from "../improvement/validation.js";
import type { WorkflowImprovement, WorkflowOpportunity, WorkflowProcessTask } from "../improvement/contracts.js";
import type { WorkflowImprovementFeedbackRecord, WorkflowImprovementUseRecord } from "../runtime/improvement-contracts.js";
import { workflowImprovementRecordId } from "../runtime/improvement-identities.js";

type Use = { readonly ref: string; readonly useId: string; readonly versionId: string; readonly sessionId: string; readonly task: WorkflowProcessTask;
  readonly record: WorkflowImprovementUseRecord };

type NativeRow = { readonly change: Omit<ContentDomainFeedbackChange, "issueId">; readonly issueIds: readonly string[];
  readonly lineageRefs: ReadonlyMap<string, readonly string[]>;
  readonly record: WorkflowImprovementUseRecord | WorkflowImprovementFeedbackRecord };

/** Batch navigation over actual native versions/uses. A frozen use is adoption
 * at a handoff; neither it nor a published candidate proves provider delivery. */
function indexWorkflowNativeFeedback(board: BoardState, input: { readonly scope: string; readonly workspaceId?: string; readonly issueId?: string;
  readonly unitRefs?: ReadonlySet<string>; readonly factRefs?: ReadonlySet<string> }): readonly NativeRow[] {
  const issues = (board.learningIssues ?? []).filter(issue => issue.scope === input.scope && learningIssueOwner(issue) === "workflow"
    && (input.issueId === undefined || issue.issueId === input.issueId));
  const proposals = new Map(board.proposals.map(row => [row.proposalId, row]));
  const visibility = workflowAssetVisibilityIndex(board);
  const assets = board.assets.filter(asset => {
    const proposal = asset.createdFromProposalId === undefined ? undefined : proposals.get(asset.createdFromProposalId);
    return asset.kind === "workflow" && visibility.get(asset.versionId) !== "forgotten" && (input.workspaceId === undefined || asset.scope === input.workspaceId)
      && proposal?.domain === "workflow" && proposal.scope === asset.scope;
  });
  const sources = new Map<string, WorkflowOpportunity>(), byOpportunity = new Map<string, WorkflowOpportunity[]>(), versions = new Map<string, WorkflowImprovement>();
  const sourceVersions = new Map<WorkflowOpportunity, string>();

  for (const asset of assets) {
    if (!record(asset.content) || asset.content.schemaVersion !== 1) continue;
    if (asset.content.type === "workflow_improvement_opportunity") {
      const parsed = parseWorkflowOpportunity(asset.content.opportunity);
      if (!parsed.ok || parsed.value.task.scope !== asset.scope) continue;
      sources.set(asset.versionId, parsed.value);
      sourceVersions.set(parsed.value, asset.versionId);
      byOpportunity.set(parsed.value.opportunityId, [...byOpportunity.get(parsed.value.opportunityId) ?? [], parsed.value]);
    } else if (asset.content.type === "workflow_improvement") {
      const parsed = parseWorkflowImprovement(asset.content);
      if (parsed.ok && parsed.value.opportunity.task.scope === asset.scope) versions.set(asset.versionId, parsed.value);
    }
  }

  const issueSources = new Map<string, Set<string>>();
  const originalSources = new Map<string, Map<string, Set<string>>>();
  const sourceKey = (opportunity: WorkflowOpportunity) => JSON.stringify([opportunity.task.scope, opportunity.opportunityId]);

  for (const issue of issues) {
    const opportunityIds = new Set<string>();
    const refs = new Map<string, Set<string>>();
    const include = (source: WorkflowOpportunity) => {
      const key = sourceKey(source), versionId = sourceVersions.get(source);
      if (versionId === undefined) return;
      opportunityIds.add(key);
      let originals = refs.get(key);
      if (originals === undefined) {
        originals = new Set();
        refs.set(key, originals);
      }
      originals.add(versionId);
    };

    for (const report of issue.reports) {
      if ("subsystem" in report.source && report.source.subsystem === "workflow") {
        const source = sources.get(report.source.versionId);
        if (source !== undefined) include(source);
      } else if ("kind" in report.source && report.source.kind === "research_request" && report.source.domain === "workflow") {
        for (const source of byOpportunity.get(report.source.requestRef) ?? []) if (source.trigger === "central_research") include(source);
      }
    }

    if (opportunityIds.size > 0) {
      issueSources.set(issue.issueId, opportunityIds);
      originalSources.set(issue.issueId, refs);
    }
  }

  const grants = new Map((board.centralLearningGrants ?? []).filter(row => row.scope === input.scope && row.domain === "workflow").map(row => [row.grantId, row]));
  const owners = new Map<string, Set<string>>(), eligible = new Set<string>();
  const lineages = new Map<string, Map<string, Set<string>>>();
  const add = (versionId: string, issueId: string, sourceRefs: readonly string[]) => {
    let values = owners.get(versionId);
    if (values === undefined) {
      values = new Set();
      owners.set(versionId, values);
    }
    let changed = !values.has(issueId);
    values.add(issueId);
    let byIssue = lineages.get(versionId);
    if (byIssue === undefined) {
      byIssue = new Map();
      lineages.set(versionId, byIssue);
    }
    let originals = byIssue.get(issueId);
    if (originals === undefined) {
      originals = new Set();
      byIssue.set(issueId, originals);
    }
    for (const ref of sourceRefs) if (!originals.has(ref)) {
      changed = true;
      originals.add(ref);
    }
    return changed;
  };

  for (const job of board.jobs) {
    const grant = job.coordination === undefined ? undefined : grants.get(job.coordination.grantId);
    if (job.state !== "succeeded" || job.domain !== "workflow" || grant?.jobId !== job.jobId || job.coordination?.issueId !== grant.issueId) continue;

    for (const ref of job.coordination.resultRefs ?? []) {
      const version = versions.get(ref);
      if (version === undefined) continue;
      eligible.add(ref);
      const key = sourceKey(version.opportunity);
      if (issueSources.get(grant.issueId)?.has(key)) add(ref, grant.issueId, [ref, ...originalSources.get(grant.issueId)?.get(key) ?? []]);
    }
  }

  const children = new Map<string, string[]>();

  for (const [versionId, version] of versions) if (eligible.has(versionId) && version.parentVersionId !== undefined) {
    const parent = versions.get(version.parentVersionId);
    if (parent !== undefined && parent.opportunity.issueKey === version.opportunity.issueKey
      && workflowProcessMatches(parent.opportunity.task, version.opportunity.task)) children.set(version.parentVersionId, [...children.get(version.parentVersionId) ?? [], versionId]);
  }

  const queue = [...owners].flatMap(([versionId, issueIds]) => [...issueIds].map(issueId => ({ versionId, issueId })));

  for (let index = 0; index < queue.length; index += 1) for (const versionId of children.get(queue[index]!.versionId) ?? []) {
    const parent = queue[index]!;
    if (add(versionId, parent.issueId, [versionId, ...lineages.get(parent.versionId)?.get(parent.issueId) ?? []])) queue.push({ versionId, issueId: parent.issueId });
  }

  const uses = new Map<string, Use>(), ambiguousUses = new Set<string>();

  for (const asset of assets) {
    const content = asset.content;
    if (!record(content) || content.schemaVersion !== 1 || content.type !== "workflow_improvement_use" || !record(content.use)
      || !identity(content.use.useId) || !identity(content.use.versionId) || !text(content.use.boundary) || !identity(content.sessionId) || !sequence(content.afterSequence)) continue;

    if (input.unitRefs !== undefined && !input.unitRefs.has(content.use.useId)) continue;

    const task = parseWorkflowProcessTask(content.use.task), version = versions.get(content.use.versionId);
    if (!task.ok || task.value.scope !== asset.scope || version === undefined || !owners.has(content.use.versionId) || !improvementApplies(version, task.value)) continue;

    if (uses.has(content.use.useId) || ambiguousUses.has(content.use.useId)) {
      uses.delete(content.use.useId);
      ambiguousUses.add(content.use.useId);
      continue;
    }

    uses.set(content.use.useId, { ref: asset.versionId, useId: content.use.useId, versionId: content.use.versionId, sessionId: content.sessionId, task: task.value,
      record: { type: "workflow_improvement_use", schemaVersion: 1, sessionId: content.sessionId, afterSequence: content.afterSequence,
        use: { useId: content.use.useId, versionId: content.use.versionId, boundary: content.use.boundary, task: task.value } } });
  }

  const rows: NativeRow[] = [];
  const emit = (versionId: string, kind: ContentDomainFeedbackChange["kind"], factRef: string, useId: string, sourceRefs: readonly string[],
    record: NativeRow["record"]) => {
    rows.push({ issueIds: [...owners.get(versionId) ?? []], lineageRefs: new Map([...lineages.get(versionId) ?? []].map(([issueId, refs]) => [issueId, [...refs]])),
      record, change: { domain: "workflow", kind, factRef,
      unitRef: useId, revisionRef: factRef, sourceRefs: [...new Set(sourceRefs)] } });
  };

  for (const use of uses.values()) emit(use.versionId, "adoption", use.ref, use.useId, [use.ref, use.versionId, use.useId], use.record);

  for (const asset of assets) {
    if (input.factRefs !== undefined && !input.factRefs.has(asset.versionId)) continue;

    if (!record(asset.content) || asset.content.schemaVersion !== 1 || asset.content.type !== "workflow_improvement_feedback") continue;

    const parsed = parseWorkflowImprovementFeedback(asset.content.feedback);
    if (!parsed.ok) continue;

    const feedback = parsed.value, use = uses.get(feedback.useId);
    if (use === undefined || feedback.versionId !== use.versionId || feedback.task.scope !== asset.scope
      || !feedback.executionId.startsWith(`${use.sessionId}/`) || JSON.stringify(feedback.task) !== JSON.stringify(use.task)) continue;

    emit(use.versionId, feedback.userAssessment === undefined ? "quality" : "correction", asset.versionId, use.useId,
      [asset.versionId, feedback.feedbackId, use.ref, use.versionId, use.useId], { type: "workflow_improvement_feedback", schemaVersion: 1, feedback });
  }

  return rows;
}

export function projectWorkflowCentralFeedbackChanges(board: BoardState, input: { readonly scope: string; readonly workspaceId?: string }): readonly ContentDomainFeedbackChange[] {
  return indexWorkflowNativeFeedback(board, input).flatMap(row => row.issueIds.map(issueId => ({ ...row.change, issueId })));
}

/** Explicit body reads reuse the same original relationships, restricted to the
 * requested issue. Directory metadata is a locator, never the source payload. */
export function readWorkflowNativeFeedbackBodies(board: BoardState, input: { readonly scope: string; readonly issueId: string;
  readonly nativeChanges: readonly ContentDomainFeedbackChange[] }): { readonly sourceRefs: readonly string[]; readonly records: readonly JsonObject[] } {
  const requested = input.nativeChanges.filter(row => row.domain === "workflow" && row.issueId === input.issueId);
  const advertised = new Set(requested.map(row => JSON.stringify([row.factRef, row.unitRef, row.revisionRef, row.kind])));
  const records: JsonObject[] = [], sourceRefs = new Set<string>();

  if (advertised.size === 0) return { sourceRefs: [], records: [] };

  const assets = new Map(board.assets.map(asset => [asset.versionId, asset]));
  const checked = new Map<string, boolean>();
  const originalLineage = (ref: string) => {
    const prior = checked.get(ref);
    if (prior !== undefined) return prior;
    const asset = assets.get(ref), content = asset?.content;
    const valid = asset !== undefined && record(content) && content.schemaVersion === 1
      && (content.type === "workflow_improvement_opportunity" || content.type === "workflow_improvement")
      && asset.contentHash === contentHashOf(content) && asset.versionId === workflowImprovementRecordId({ ...content, type: content.type });
    checked.set(ref, valid);
    return valid;
  };

  for (const row of indexWorkflowNativeFeedback(board, { ...input, unitRefs: new Set(requested.map(row => row.unitRef)), factRefs: new Set(requested.map(row => row.factRef)) })) {
    const change = row.change;
    if (!row.issueIds.includes(input.issueId) || !advertised.has(JSON.stringify([change.factRef, change.unitRef, change.revisionRef, change.kind]))) continue;

    const original = assets.get(change.factRef);

    // Only explicit body retrieval pays the canonical native identity check.
    if (original?.contentHash !== contentHashOf(row.record) || original.versionId !== workflowImprovementRecordId(row.record)) continue;

    const lineage = row.lineageRefs.get(input.issueId);
    if (lineage === undefined || lineage.length === 0 || !lineage.every(originalLineage)) continue;

    for (const ref of lineage) sourceRefs.add(ref);

    for (const ref of change.sourceRefs) sourceRefs.add(ref);

    records.push({ kind: "workflow_native_feedback", changeKind: change.kind, factRef: change.factRef, unitRef: change.unitRef,
      revisionRef: change.revisionRef, sourceRefs: [...change.sourceRefs], payloadJson: canonicalJson(row.record),
      interpretation: row.record.type === "workflow_improvement_use" ? "frozen_selection_not_proof_of_following_or_benefit" : "original_feedback_not_central_gain" });
  }

  return { sourceRefs: [...sourceRefs], records };
}
