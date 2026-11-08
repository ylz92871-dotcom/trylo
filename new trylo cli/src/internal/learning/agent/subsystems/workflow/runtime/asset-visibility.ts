import type { LearningAssetVersion } from "../../../../control/contracts.js";
import type { BoardState } from "../../../../control/state.js";
import { record } from "../domain/trace-parse.js";

/** Availability is derived from the canonical Board; this is not an activation pointer. */
export type WorkflowAssetVisibility = "available" | "blocked" | "forgotten" | "unknown";

const severity: Readonly<Record<WorkflowAssetVisibility, number>> = { available: 0, blocked: 1, unknown: 2, forgotten: 3 };

/** Tombstones take precedence even when retained metadata is incomplete or inconsistent. */
export function workflowAssetSelfVisibility(state: BoardState, versionId: string): WorkflowAssetVisibility {
  const asset = state.assets.find(item => item.versionId === versionId);
  if (state.tombstones.some(item => item.entityType === "asset" && item.entityId === versionId
    || item.entityType === "proposal" && item.entityId === asset?.createdFromProposalId)) return "forgotten";

  if (asset === undefined || asset.kind !== "workflow") return "unknown";

  const owner = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  if (owner === undefined || owner.domain !== "workflow" || owner.assetKind !== asset.kind || owner.scope !== asset.scope
    || owner.source !== asset.source || owner.candidateRef !== asset.versionId) return "unknown";

  if (["rejected", "retired", "suspended", "rolled_back"].includes(owner.lifecycle)
    || state.activations.some(item => item.versionId === versionId && ["retired", "suspended", "rolled_back"].includes(item.pointer))) return "blocked";

  return "available";
}

type SemanticReferences = {
  readonly opportunities: ReadonlyMap<string, readonly string[]>;
  readonly uses: ReadonlyMap<string, readonly string[]>;
  readonly feedback: ReadonlyMap<string, readonly string[]>;
};

const scopedId = (scope: string, id: string) => JSON.stringify([scope, id]);

/** IDs join the existing record formats; no new state or text-content index is persisted. */
function semanticReferences(assets: readonly LearningAssetVersion[]): SemanticReferences {
  const opportunities = new Map<string, string[]>(), uses = new Map<string, string[]>(), feedback = new Map<string, string[]>();
  const add = (index: Map<string, string[]>, scope: string, key: unknown, versionId: string) => {
    if (typeof key === "string") {
      const scoped = scopedId(scope, key);
      index.set(scoped, [...(index.get(scoped) ?? []), versionId]);
    }
  };

  for (const asset of assets) {
    const content = asset.content;
    if (asset.kind !== "workflow" || !record(content)) continue;
    if (content.type === "workflow_improvement_opportunity" && record(content.opportunity)) add(opportunities, asset.scope, content.opportunity.opportunityId, asset.versionId);
    if (content.type === "workflow_improvement_use" && record(content.use)) add(uses, asset.scope, content.use.useId, asset.versionId);
    if (content.type === "workflow_improvement_feedback" && record(content.feedback)) add(feedback, asset.scope, content.feedback.feedbackId, asset.versionId);
  }

  return { opportunities, uses, feedback };
}

/** Inspect only named provenance fields, never arbitrary strings or hidden reasoning. */
function sourceReferences(asset: LearningAssetVersion, semantic: SemanticReferences, knownIds: ReadonlySet<string>): readonly string[] {
  const refs = new Set<string>();
  const direct = (value: unknown) => { if (typeof value === "string") refs.add(value); };
  const known = (value: unknown) => {
    if (typeof value !== "string") return;
    if (knownIds.has(value)) refs.add(value);
    for (const prefix of ["legacy-correction:", "legacy-conditional-correction:"]) {
      if (value.startsWith(prefix)) direct(value.slice(prefix.length));
    }
    for (const id of semantic.feedback.get(scopedId(asset.scope, value)) ?? []) refs.add(id);
  };
  const content = asset.content;

  direct(asset.parentVersionId);

  if (!record(content)) return [...refs];

  direct(content.parentVersionId);

  if (content.type === "workflow_improvement_research") {
    direct(content.inputVersionId);
    direct(content.previousVersionId);
    if (record(content.observation) && Array.isArray(content.observation.versionIds)) content.observation.versionIds.forEach(direct);
    if (record(content.observation) && Array.isArray(content.observation.evidenceRefs)) content.observation.evidenceRefs.forEach(known);
    if (record(content.observation) && record(content.observation.finding) && Array.isArray(content.observation.finding.sourceRefs)) {
      content.observation.finding.sourceRefs.forEach(known);
    }
  }

  if (record(content.opportunity)) {
    for (const id of semantic.opportunities.get(scopedId(asset.scope, String(content.opportunity.opportunityId))) ?? []) if (id !== asset.versionId) refs.add(id);
    if (Array.isArray(content.opportunity.evidenceRefs)) content.opportunity.evidenceRefs.forEach(known);
  }

  if (Array.isArray(content.evidence)) for (const fact of content.evidence) if (record(fact)) {
    direct(fact.sourceVersionId);
    known(fact.ref);
  }

  if (record(content.use)) direct(content.use.versionId);

  if (record(content.feedback)) {
    direct(content.feedback.versionId);
    const useId = content.feedback.useId;
    if (typeof useId === "string") {
      const uses = semantic.uses.get(scopedId(asset.scope, useId));
      if (uses === undefined) refs.add(useId);
      else uses.forEach(direct);
    }

    if (Array.isArray(content.feedback.evidenceRefs)) content.feedback.evidenceRefs.forEach(known);
  }

  if (record(content.trace)) direct(content.trace.workflowVersionId);

  // Imported historical traces may name an external version. Only known Board
  // IDs participate here; an actual stored feedback already has a direct parent.
  if (Array.isArray(content.traces)) for (const trace of content.traces) if (record(trace)) known(trace.workflowVersionId);

  return [...refs];
}

/** A forgotten/blocked/unknown source cannot reappear through an inferred copy or feedback join. */
export function workflowAssetVisibilityIndex(state: BoardState): ReadonlyMap<string, WorkflowAssetVisibility> {
  const statuses = new Map<string, WorkflowAssetVisibility>();
  // A real new explicit correction is a fresh intent, not inherited authority
  // from the trial it repairs. Privacy and unknown provenance still propagate.
  const freshIntents = new Set(state.assets.filter(asset => asset.source === "user_explicit" && record(asset.content)
    && asset.content.type === "workflow_learning" && record(asset.content.correction)).map(asset => asset.versionId));
  const knownIds = new Set(state.assets.map(asset => asset.versionId));

  for (const tombstone of state.tombstones) if (tombstone.entityType === "asset") knownIds.add(tombstone.entityId);

  const semantic = semanticReferences(state.assets), dependents = new Map<string, string[]>();

  for (const id of knownIds) statuses.set(id, workflowAssetSelfVisibility(state, id));

  for (const asset of state.assets) {
    if (asset.kind !== "workflow") continue;
    for (const sourceId of sourceReferences(asset, semantic, knownIds)) {
      dependents.set(sourceId, [...(dependents.get(sourceId) ?? []), asset.versionId]);
      if (!statuses.has(sourceId)) statuses.set(sourceId, "unknown");
    }
  }

  const pending = [...statuses.keys()];

  for (let index = 0; index < pending.length; index += 1) {
    const id = pending[index]!, status = statuses.get(id)!;
    for (const child of dependents.get(id) ?? []) {
      if (status === "blocked" && freshIntents.has(child)) continue;
      const previous = statuses.get(child) ?? "unknown";
      if (severity[status] > severity[previous]) {
        statuses.set(child, status);
        pending.push(child);
      }
    }
  }

  return statuses;
}

/** Privacy closure only. Modern repair children do not inherit a parent's blocked lifecycle. */
export function workflowForgottenAssetIds(state: BoardState): ReadonlySet<string> {
  return new Set([...workflowAssetVisibilityIndex(state)].filter(([, visibility]) => visibility === "forgotten").map(([id]) => id));
}

/** Legacy inherited authority requires every named source to remain available. */
export function workflowAssetVisibility(state: BoardState, versionId: string, forgottenIds?: ReadonlySet<string>): WorkflowAssetVisibility {
  if (forgottenIds?.has(versionId)) return "forgotten";
  return workflowAssetVisibilityIndex(state).get(versionId) ?? "unknown";
}
