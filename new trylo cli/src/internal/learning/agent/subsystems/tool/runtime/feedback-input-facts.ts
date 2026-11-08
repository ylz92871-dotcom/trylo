import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { toolFeedbackIsExternal } from "../domain/evolution/task-feedback.js";
import type { ToolUseRecord } from "../domain/evolution/use.js";
import { toolLearningFeedbackVersions, toolLearningParentFromBoard } from "./learning-parent.js";
import { taskFeedbackForCandidate, type ToolFeedbackEntry } from "./tool-task-feedback.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";

type FeedbackFact = { readonly versionId: string; readonly contentHash: string;
  readonly lifecycle: BoardState["proposals"][number]["lifecycle"] | "missing" };

type Facts = { readonly ok: true; readonly feedback: readonly FeedbackFact[]; readonly uses: readonly ToolUseRecord[] };

export type ToolLearningFeedbackScope = { readonly ok: true; readonly parentVersionId?: string; readonly workspaceId?: string;
  readonly historyScope: "bound" | "unknown"; readonly versions: readonly string[]; readonly entries: readonly ToolFeedbackEntry[]; readonly uses: readonly ToolUseRecord[] };

/** Learning scope identifies the original task; a production use has its own
 * slot scope. Cross that boundary only through the exact immutable parent and
 * actual source-workspace bindings, never by scanning foreign capability text. */
export function toolLearningFeedbackScope(state: BoardState, plan: ToolLearningPlan, parentVersionId?: string): PipelineFailure | ToolLearningFeedbackScope {
  const references = [...plan.trigger.evidenceRefs, ...(plan.opportunity?.executions.flatMap(fact =>
    fact.versionId === undefined || fact.tool !== plan.trigger.tool ? [] : [fact.versionId]) ?? [])];
  const target = parentVersionId ?? plan.targetVersionId ?? (plan.trigger.tool === undefined ? undefined : [...references].reverse()
    .find(ref => state.assets.some(asset => asset.kind === "tool_package" && asset.versionId === ref)));
  if (target === undefined) return { ok: true, historyScope: "unknown", versions: [], entries: [], uses: [] };

  const selected = toolLearningParentFromBoard(state, target);
  if (!selected.ok) return selected;

  if (selected.parent.scope !== plan.scope) return pipelineFailure("planning_scope_mismatch", "The exact feedback parent belongs to another task scope");

  const canonicalParent = selected.parent.versionId, versions = new Set(toolLearningFeedbackVersions(state, canonicalParent));
  const history = taskFeedbackForCandidate(state, canonicalParent);
  if (!history.ok) return history;

  const workspaceIds = new Set<string>();

  for (const ref of [target, ...references]) {
    const asset = state.assets.find(row => row.versionId === ref), production = decodeToolProductionPlan(asset?.content);
    if (production !== undefined && versions.has(ref)) workspaceIds.add(production.workspaceId);
  }

  const initialFeedbackId = plan.trigger.proposalKey.startsWith("task-feedback:") ? plan.trigger.proposalKey.slice("task-feedback:".length) : undefined;
  const initial = history.entries.find(entry => entry.feedbackVersionId === initialFeedbackId);
  const explicitUses = new Set([...references, ...(initial?.feedback.useIds ?? [])]);

  for (const use of state.toolUses ?? []) if (versions.has(use.versionId) && explicitUses.has(use.useId)) workspaceIds.add(use.workspaceId);

  if (selected.parent.kind === "npm") workspaceIds.add(selected.parent.plan.workspaceId);

  if (workspaceIds.size === 0) return { ok: true, parentVersionId: canonicalParent, historyScope: "unknown", versions: [], entries: [], uses: [] };

  if (workspaceIds.size !== 1) return pipelineFailure("tool_feedback_workspace_mismatch", "The inquiry's exact production and source-use bindings disagree about their workspace");

  const workspaceId = [...workspaceIds][0]!, uses: ToolUseRecord[] = [];
  const scopedVersions = [...versions].filter(versionId => {
    const production = decodeToolProductionPlan(state.assets.find(asset => asset.versionId === versionId)?.content);
    return production === undefined ? versionId === canonicalParent : production.workspaceId === workspaceId;
  });

  for (const use of state.toolUses ?? []) {
    if (!versions.has(use.versionId) || use.workspaceId !== workspaceId) continue;

    const asset = state.assets.find(row => row.versionId === use.versionId), production = decodeToolProductionPlan(asset?.content);
    if (asset === undefined || asset.contentHash !== contentHashOf(asset.content) || use.contentHash !== asset.contentHash || use.scope !== asset.scope
      || (production !== undefined && production.workspaceId !== workspaceId)) {
      return pipelineFailure("tool_feedback_binding_mismatch", "Host use facts no longer bind their exact immutable candidate or production workspace");
    }

    uses.push(use);
  }

  const ids = new Set(uses.map(use => use.useId));
  const entries = history.entries.filter(entry => entry.feedback.useIds.every(useId => ids.has(useId)));

  return { ok: true, parentVersionId: canonicalParent, workspaceId, historyScope: "bound", versions: scopedVersions, entries, uses };
}

/** Model hypotheses remain available to diagnostics, but their new wording is
 * not a new fact that can wake a waiting funded job. */
export function toolLearningFeedbackInputFacts(state: BoardState, plan: ToolLearningPlan): PipelineFailure | Facts {
  const scoped = toolLearningFeedbackScope(state, plan);
  if (!scoped.ok) return scoped;

  const feedback = scoped.entries.flatMap<FeedbackFact>(entry => {
    const asset = state.assets.find(row => row.versionId === entry.feedbackVersionId);
    return asset === undefined || !toolFeedbackIsExternal(entry.feedback) ? [] : [{ versionId: asset.versionId, contentHash: asset.contentHash,
      lifecycle: state.proposals.find(proposal => proposal.proposalId === asset.createdFromProposalId)?.lifecycle ?? "missing" }];
  });

  return { ok: true, feedback, uses: scoped.uses };
}
