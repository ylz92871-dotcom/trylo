import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import { decodeToolTaskFeedback, decodeToolTaskFeedbackArtifact, type ToolTaskFeedback, type ToolTaskFeedbackArtifact } from "../domain/evolution/task-feedback.js";
import { assetAvailable, pipelineFailure, savePipelineAsset, type PipelineFailure } from "./pipeline-assets.js";
import { toolLearningFeedbackVersions } from "./learning-parent.js";

export { decodeToolTaskFeedback, toolUsageGuidance } from "../domain/evolution/task-feedback.js";
export { toolTaskFeedbackContext } from "../domain/evolution/feedback-evidence.js";
export type { ToolTaskFeedback, ToolTaskMetrics } from "../domain/evolution/task-feedback.js";

export type ToolFeedbackEntry = { readonly feedbackVersionId: string; readonly feedback: ToolTaskFeedback };

/** A separate assessment linked to immutable execution facts, using the existing Board writer. */
export async function recordToolTaskFeedback(boardRoot: string, raw: unknown, issuedAt: string) {
  const feedback = decodeToolTaskFeedback(raw);
  if (feedback === undefined) return pipelineFailure("invalid_tool_feedback", "feedback requires bounded task, version, use and evidence bindings");

  const saved = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const uses = (loaded.state.toolUses ?? []).filter(item => feedback.useIds.includes(item.useId));
    if (uses.length !== feedback.useIds.length || uses.some(item => item.versionId !== feedback.versionId || item.sessionId !== feedback.sessionId
      || item.scope !== uses[0]?.scope || item.contentHash !== uses[0]?.contentHash)) {
      return pipelineFailure("tool_feedback_binding_mismatch", "feedback use IDs must identify the same immutable tool version and session");
    }

    const use = uses[0];
    if (use === undefined) return pipelineFailure("tool_feedback_binding_mismatch", "at least one recorded use is required");

    const history = taskFeedbackFromBoard(loaded.state, feedback.versionId);
    if (!history.ok) return history;

    const previous = history.entries.find(item => item.feedback.feedbackId === feedback.feedbackId);
    if (previous !== undefined) return contentHashOf(previous.feedback) === contentHashOf(feedback)
      ? { ok: true as const, versionId: feedback.versionId, feedbackVersionId: previous.feedbackVersionId, duplicate: true }
      : pipelineFailure("tool_feedback_conflict", "feedback ID already binds a different assessment");

    const artifact: ToolTaskFeedbackArtifact = { type: "tool_task_feedback", schemaVersion: 1, scope: use.scope,
      contentHash: use.contentHash, occurredAt: issuedAt, feedback };
    if (decodeToolTaskFeedbackArtifact(artifact) === undefined) return pipelineFailure("invalid_tool_feedback", "feedback time or binding is invalid");

    const feedbackVersionId = `tool-feedback:${contentHashOf({ versionId: feedback.versionId, feedbackId: feedback.feedbackId }).slice(0, 40)}`;
    const result = await savePipelineAsset(store, { versionId: feedbackVersionId, kind: "workflow", content: artifact,
      scope: use.scope, source: feedback.source === "user" ? "user_explicit" : "inferred", issuedAt,
      observations: [...feedback.useIds, ...feedback.evidenceRefs] });

    return result.ok ? { ok: true as const, versionId: feedback.versionId, feedbackVersionId, duplicate: false } : result;
  });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

export async function readToolTaskFeedback(boardRoot: string, versionId: string, workspaceId?: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  return taskFeedbackForWorkspace(loaded.state, versionId, workspaceId);
}

export function taskFeedbackForWorkspace(state: BoardState, versionId: string, workspaceId?: string) {
  const found = taskFeedbackFromBoard(state, versionId);
  if (!found.ok || workspaceId === undefined) return found;

  const relevantUses = new Set(found.records.flatMap(item => item.useIds));
  if ((state.toolUses ?? []).some(use => relevantUses.has(use.useId) && use.workspaceId !== workspaceId)) {
    return pipelineFailure("tool_feedback_workspace_mismatch", "task feedback belongs to another workspace");
  }

  return found;
}

/** Generated production interfaces share their candidate lineage. Npm interfaces
 * retain their exact production version, including any adapter and patches. */
export function taskFeedbackForCandidate(state: BoardState, versionId: string) {
  const versions = toolLearningFeedbackVersions(state, versionId);
  const entries: ToolFeedbackEntry[] = [];

  for (const related of versions) {
    const found = taskFeedbackFromBoard(state, related);
    if (!found.ok) return found;
    entries.push(...found.entries);
  }

  return { ok: true as const, entries, records: entries.map(item => item.feedback) };
}

/** Fail closed for malformed feedback assets rather than silently omitting negative evidence. */
export function taskFeedbackFromBoard(state: BoardState, versionId: string): PipelineFailure | {
  readonly ok: true; readonly entries: readonly ToolFeedbackEntry[]; readonly records: readonly ToolTaskFeedback[];
} {
  const entries: ToolFeedbackEntry[] = [];

  for (const asset of state.assets) {
    if (asset.kind !== "workflow" || typeof asset.content !== "object" || asset.content === null
      || !("type" in asset.content) || asset.content.type !== "tool_task_feedback") continue;

    const artifact = decodeToolTaskFeedbackArtifact(asset.content);
    if (artifact === undefined || !assetAvailable(state, asset) || artifact.scope !== asset.scope) {
      return pipelineFailure("invalid_tool_feedback_asset", "task feedback archive failed shape or lifecycle validation");
    }

    if (artifact.feedback.versionId !== versionId) continue;

    const uses = (state.toolUses ?? []).filter(item => artifact.feedback.useIds.includes(item.useId));
    if (uses.length !== artifact.feedback.useIds.length || uses.some(item => item.versionId !== versionId
      || item.sessionId !== artifact.feedback.sessionId || item.scope !== artifact.scope || item.contentHash !== artifact.contentHash)) {
      return pipelineFailure("tool_feedback_binding_mismatch", "archived feedback no longer binds its recorded executions");
    }

    entries.push({ feedbackVersionId: asset.versionId, feedback: artifact.feedback });
  }

  return { ok: true, entries, records: entries.map(item => item.feedback) };
}
