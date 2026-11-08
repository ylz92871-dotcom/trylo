import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { BoardState } from "../../../../control/state.js";
import type { ProposalSource } from "../../../../control/contracts.js";
import type { WorkflowLearningArtifact, WorkflowLearningResult, WorkflowTrace } from "../domain/trace-contracts.js";
import { parseWorkflowLearningArtifact, parseWorkflowTrace, record, workflowFailure } from "../domain/trace-parse.js";
import { selectWorkflowPath, workflowMatches } from "../domain/trace-learn.js";
import { isDeepStrictEqual } from "node:util";
import { workflowAssetVisibility, workflowAssetVisibilityIndex, type WorkflowAssetVisibility } from "./asset-visibility.js";

/** The Board remains the sole durable writer; no parallel workflow registry. */
export async function readWorkflowVersion(boardRoot: string, versionId: string): Promise<WorkflowLearningResult<WorkflowLearningArtifact>> {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? workflowFromBoard(loaded.state, versionId) : workflowFailure(loaded.reason, loaded.detail);
}

export function workflowFromBoard(state: BoardState, versionId: string): WorkflowLearningResult<WorkflowLearningArtifact> {
  const visibility = workflowAssetVisibility(state, versionId);
  if (visibility === "forgotten") return workflowFailure("workflow_forgotten", "This workflow or one of its sources was forgotten");
  if (!state.assets.some(item => item.versionId === versionId && item.kind === "workflow")) return workflowFailure("workflow_not_found", versionId);
  if (visibility === "unknown") return workflowFailure("workflow_source_unknown", "The workflow owning source could not be established");
  return parseWorkflowAsset(state, versionId);
}

function parseWorkflowAsset(state: BoardState, versionId: string): WorkflowLearningResult<WorkflowLearningArtifact> {
  const asset = state.assets.find(item => item.versionId === versionId && item.kind === "workflow");
  if (asset === undefined) return workflowFailure("workflow_not_found", versionId);
  const parsed = parseWorkflowLearningArtifact(asset.content);
  if (!parsed.ok) return parsed;
  return asset.scope === parsed.value.scope && asset.contentHash === contentHashOf(parsed.value)
    ? parsed : workflowFailure("invalid_artifact", "asset hash or scope does not match workflow content");
}

export type WorkflowVersion = { readonly versionId: string; readonly artifact: WorkflowLearningArtifact; readonly source: ProposalSource;
  /** Local origin resolution only; unavailable bodies must never enter provider context. */
  readonly visibility?: WorkflowAssetVisibility };

export type LegacyWorkflowCatalog = { readonly versions: readonly WorkflowVersion[]; readonly providerVersions: readonly WorkflowVersion[] };

/** Complete local history resolves intent inheritance; only providerVersions may enter a prompt. */
export async function readLegacyWorkflowCatalog(boardRoot: string): Promise<WorkflowLearningResult<LegacyWorkflowCatalog>> {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return workflowFailure(loaded.reason, "The workflow catalog could not be read");

  const visibility = workflowAssetVisibilityIndex(loaded.state);
  const versions: WorkflowVersion[] = [];

  for (const asset of loaded.state.assets) {
    if (!record(asset.content) || asset.content.type !== "workflow_learning") continue;
    const found = parseWorkflowAsset(loaded.state, asset.versionId);
    if (!found.ok) return workflowFailure("workflow_catalog_corrupt", "A stored workflow cannot be decoded safely");
    versions.push({ versionId: asset.versionId, artifact: found.value, source: asset.source,
      visibility: visibility.get(asset.versionId) ?? "unknown" });
  }

  return { ok: true, value: { versions, providerVersions: versions.filter(item => item.visibility === "available") } };
}

export async function listWorkflowVersions(boardRoot: string): Promise<WorkflowLearningResult<readonly WorkflowVersion[]>> {
  const catalog = await readLegacyWorkflowCatalog(boardRoot);
  return catalog.ok ? { ok: true, value: catalog.value.versions.filter(item => item.visibility !== "forgotten" && item.visibility !== "unknown") } : catalog;
}

export async function workflowFeedback(boardRoot: string, versionId: string): Promise<WorkflowLearningResult<readonly WorkflowTrace[]>> {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

  const parent = workflowFromBoard(loaded.state, versionId);
  if (!parent.ok) return parent;

  const visibility = workflowAssetVisibilityIndex(loaded.state);
  const traces: WorkflowTrace[] = [];

  for (const asset of loaded.state.assets) {
    if (visibility.get(asset.versionId) === "forgotten" || visibility.get(asset.versionId) === "unknown") continue;

    if (!record(asset.content) || asset.content.type !== "workflow_trace") continue;

    const parsed = parseWorkflowTrace(asset.content.trace);
    if (!parsed.ok) return parsed;

    if (parsed.value.workflowVersionId !== versionId) continue;

    const bound = bindFeedback(parsed.value, parent.value);
    if (!bound.ok) return bound;

    if (asset.kind !== "workflow" || asset.scope !== parsed.value.scope || asset.parentVersionId !== versionId || contentHashOf(asset.content) !== asset.contentHash) {
      return workflowFailure("invalid_feedback", "feedback asset hash, scope or parent differs");
    }

    traces.push(parsed.value);
  }

  return { ok: true, value: traces };
}

export async function saveWorkflowVersion(boardRoot: string, artifact: WorkflowLearningArtifact, issuedAt: string, source: ProposalSource = "inferred") {
  const parsed = parseWorkflowLearningArtifact(artifact);
  if (!parsed.ok) return parsed;
  return save(boardRoot, parsed.value, issuedAt, parsed.value.parentVersionId, source);
}

export async function saveWorkflowTrace(boardRoot: string, trace: WorkflowTrace, issuedAt: string) {
  const parsed = parseWorkflowTrace(trace);
  if (!parsed.ok) return parsed;
  if (trace.workflowVersionId === undefined) return workflowFailure("missing_workflow_version", "runtime feedback must bind a frozen workflow version");
  return save(boardRoot, { type: "workflow_trace", schemaVersion: 1, trace: parsed.value, scope: parsed.value.scope }, issuedAt, trace.workflowVersionId);
}

type StoredWorkflow = WorkflowLearningArtifact | { readonly type: "workflow_trace"; readonly schemaVersion: 1; readonly trace: WorkflowTrace; readonly scope: string };

async function save(boardRoot: string, content: StoredWorkflow, issuedAt: string, parentVersionId?: string, source: ProposalSource = "inferred"): Promise<WorkflowLearningResult<{ readonly versionId: string }>> {
  const versionId = `${content.type === "workflow_learning" ? "wfl" : "wft"}_${contentHashOf(content).slice(0, 32)}`;
  const proposalId = `proposal_${versionId}`;
  const result = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

    if (parentVersionId !== undefined) {
      const parent = workflowFromBoard(loaded.state, parentVersionId);
      if (!parent.ok) return parent;

      const task = content.type === "workflow_learning" ? content : content.trace;
      if (!workflowMatches(task, parent.value)) return workflowFailure("parent_mismatch", "updates and feedback cannot cross applicability boundaries");

      if (content.type === "workflow_trace") {
        const bound = bindFeedback(content.trace, parent.value);
        if (!bound.ok) return bound;
      }
    }

    const existing = loaded.state.assets.find(item => item.versionId === versionId);
    if (existing !== undefined) {
      if (workflowAssetVisibility(loaded.state, versionId) !== "available") return workflowFailure("workflow_source_unavailable", "An unavailable workflow record cannot be reused");
      return existing.source !== source
        ? workflowFailure("workflow_source_conflict", "an immutable version cannot change its intent source; use a new requestId")
        : { ok: true as const, value: { versionId } };
    }

    const refs = content.type === "workflow_learning" ? content.traces.map(trace => trace.traceId) : [content.trace.traceId];
    const commandId = (step: string) => `${versionId}:${step}`;
    const commands: readonly BoardCommand[] = [
      { type: "submit_proposal", commandId: commandId("submit"), issuedAt, proposal: {
        proposalId, domain: "workflow", scope: content.scope, assetKind: "workflow", candidateRef: versionId,
        hypothesis: content.type === "workflow_learning" ? "working workflow experience; usefulness is established by later use" : "observed workflow execution feedback",
        observationRefs: refs, risk: "low", requiredVerifiers: [], requestedAuthorities: [], source,
        ...(parentVersionId === undefined ? {} : { baseVersionId: parentVersionId }),
      } },
      { type: "commit_asset", commandId: commandId("commit"), issuedAt, proposalId, versionId, content, schemaVersion: 1,
        ...(parentVersionId === undefined ? {} : { parentVersionId }) },
    ];

    for (const command of commands) {
      const applied = await store.apply(command);
      if (!applied.ok) return workflowFailure(applied.reason, applied.detail);
    }

    return { ok: true as const, value: { versionId } };
  });

  return "reason" in result ? workflowFailure(result.reason, result.detail) : result;
}

function bindFeedback(trace: WorkflowTrace, parent: WorkflowLearningArtifact): WorkflowLearningResult<WorkflowTrace> {
  if (trace.source !== "runtime" || !workflowMatches(trace, parent)) return workflowFailure("invalid_feedback", "runtime feedback requires matching parent premises");

  const selected = selectWorkflowPath(parent, trace);
  if (!selected.ok) return workflowFailure("invalid_feedback", `feedback applicability does not select a frozen path: ${selected.code}`);

  if (trace.adoptedBranchId !== undefined && trace.adoptedBranchId !== selected.value.adoptedBranchId) {
    return workflowFailure("invalid_feedback", "feedback branch identity differs from the path selected by its conditions");
  }

  // Legacy traces omitted the optional branch id. Their conditions still must
  // select one path; an explicit id can never override those premises.
  const path = selected.value.artifact;

  for (const step of trace.steps) {
    const node = path.nodes.find(item => item.id === step.nodeId);
    if (node === undefined || node.check !== step.check || !isDeepStrictEqual(node.dependsOn, step.dependsOn)) {
      return workflowFailure("invalid_feedback", "feedback node contract differs from frozen parent");
    }
    const expected = path.recovery.find(item => item.afterNode === node.id)?.goto;
    if (step.status === "failed" && step.recoveryTo !== expected) return workflowFailure("invalid_feedback", "feedback recovery differs from frozen parent");
  }

  if (trace.outcome === "success" && path.nodes.some(node => !trace.steps.some(step => step.nodeId === node.id && step.status === "passed"))) {
    return workflowFailure("invalid_feedback", "successful feedback must check every frozen node");
  }

  return { ok: true, value: trace };
}
