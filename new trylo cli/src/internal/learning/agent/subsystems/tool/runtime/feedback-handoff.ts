import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { keysAre, recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure, savePipelineAsset, type PipelineFailure } from "./pipeline-assets.js";
import { planForJob } from "./pipeline-queue.js";
import { decodeToolTaskFeedbackArtifact } from "../domain/evolution/task-feedback.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";

/** Merging new evidence into an existing job needs a durable relation. Otherwise
 * restart after completion would buy another investigation for the merged report. */
export function feedbackHandoffFromBoard(state: BoardState, feedbackVersionId: string): PipelineFailure | {
  readonly ok: true; readonly jobId?: string;
} {
  const asset = state.assets.find(item => item.versionId === handoffVersion(feedbackVersionId));
  if (asset === undefined) return { ok: true };

  const raw = asset.content;
  if (!assetAvailable(state, asset) || asset.kind !== "workflow" || !recordOf(raw)
    || !keysAre(raw, ["type", "schemaVersion", "feedbackVersionId", "jobId", "scope", "parentVersionId", "situation"])
    || raw.type !== "tool_feedback_learning_handoff" || raw.schemaVersion !== 1 || raw.feedbackVersionId !== feedbackVersionId
    || typeof raw.jobId !== "string" || typeof raw.parentVersionId !== "string" || typeof raw.situation !== "string" || raw.scope !== asset.scope) {
    return pipelineFailure("invalid_tool_feedback_handoff", "feedback-to-job archive failed immutable shape or lifecycle checks");
  }

  const plan = planForJob(state, raw.jobId), job = state.jobs.find(item => item.jobId === raw.jobId);
  const feedbackAsset = state.assets.find(item => item.versionId === feedbackVersionId);
  const feedback = feedbackAsset === undefined ? undefined : decodeToolTaskFeedbackArtifact(feedbackAsset.content);
  if (plan === undefined || job === undefined || plan.targetVersionId !== raw.parentVersionId || plan.scope !== raw.scope
    || job.domain !== "tool" || job.scope !== raw.scope || feedback?.feedback.situation !== raw.situation) {
    return pipelineFailure("invalid_tool_feedback_handoff", "feedback-to-job archive does not identify its original scoped learning question");
  }

  return { ok: true, jobId: job.jobId };
}

export async function saveToolFeedbackHandoff(boardRoot: string, input: {
  readonly feedbackVersionId: string; readonly jobId: string; readonly plan: ToolLearningPlan;
  readonly situation: string; readonly issuedAt: string;
}) {
  const saved = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const existing = feedbackHandoffFromBoard(loaded.state, input.feedbackVersionId);
    if (!existing.ok) return existing;

    if (existing.jobId !== undefined) return existing.jobId === input.jobId ? { ok: true as const }
      : pipelineFailure("tool_feedback_handoff_conflict", "this assessment was already assigned to another investigation");

    const plan = planForJob(loaded.state, input.jobId);
    if (plan?.scope !== input.plan.scope || plan?.targetVersionId !== input.plan.targetVersionId || input.plan.targetVersionId === undefined) {
      return pipelineFailure("tool_feedback_handoff_mismatch", "the selected investigation does not bind the feedback parent");
    }

    const feedbackAsset = loaded.state.assets.find(item => item.versionId === input.feedbackVersionId);
    const feedback = feedbackAsset === undefined ? undefined : decodeToolTaskFeedbackArtifact(feedbackAsset.content);
    const parent = feedback === undefined ? undefined : toolLearningParentFromBoard(loaded.state, feedback.feedback.versionId);
    if (feedback === undefined || feedbackAsset === undefined || !assetAvailable(loaded.state, feedbackAsset)
      || feedback.feedback.situation !== input.situation || parent?.ok !== true || parent.parent.versionId !== plan.targetVersionId
      || parent.parent.scope !== plan.scope) return pipelineFailure("tool_feedback_handoff_mismatch", "the assessment does not bind this parent and situation");

    return savePipelineAsset(store, { versionId: handoffVersion(input.feedbackVersionId), kind: "workflow", scope: plan.scope,
      source: "inferred", issuedAt: input.issuedAt, observations: [input.feedbackVersionId],
      content: { type: "tool_feedback_learning_handoff", schemaVersion: 1, feedbackVersionId: input.feedbackVersionId,
        jobId: input.jobId, scope: plan.scope, parentVersionId: plan.targetVersionId, situation: input.situation } });
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

function handoffVersion(feedbackVersionId: string): string {
  return `tool-feedback-handoff_v1_${contentHashOf(feedbackVersionId)}`;
}
