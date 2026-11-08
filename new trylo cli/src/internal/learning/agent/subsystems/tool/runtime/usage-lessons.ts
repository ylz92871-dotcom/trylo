import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { decodeToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assessToolUsageLessons, toolFeedbackGuidance, toolUsageLessonAdvice,
  type ToolUsageLesson, type ToolUsageAssessment } from "../domain/evolution/usage-learning.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { taskFeedbackForWorkspace } from "./tool-task-feedback.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { planForJob, resultForJob } from "./pipeline-queue.js";
import { toolLearningOutcomeCode } from "../domain/evolution/pipeline.js";

/** A derived view of Board facts, not another activation/policy store. Legacy
 * unbound proposals remain queryable but cannot silently apply to another version. */
export function usageLessonsFromBoard(state: BoardState, versionId: string) {
  const selected = toolLearningParentFromBoard(state, versionId);
  if (!selected.ok) return selected;

  const lessons: ToolUsageLesson[] = [];

  for (const [order, asset] of state.assets.entries()) {
    if (asset.kind !== "workflow" || asset.scope !== selected.parent.scope || !assetAvailable(state, asset)
      || !recordOf(asset.content) || asset.content.type !== "tool_learning_decision"
      || asset.content.selectedToolVersionId !== versionId || typeof asset.content.jobId !== "string"
      || !Number.isSafeInteger(asset.content.attempt) || typeof asset.content.attempt !== "number") continue;

    const plan = planForJob(state, asset.content.jobId);
    const result = resultForJob(state, asset.content.jobId, asset.content.attempt);
    if (plan?.scope !== selected.parent.scope || result?.decisionVersionId !== asset.versionId
      || (toolLearningOutcomeCode(result) !== "usage_revision_proposed" && toolLearningOutcomeCode(result) !== "existing_capability_reused")) continue;

    const decision = decodeToolLearningDecision(asset.content.decision);
    if (decision === undefined || (decision.action !== "reuse" && decision.action !== "refine") || decision.usageContext === undefined) continue;

    lessons.push({ decisionVersionId: asset.versionId, toolVersionId: versionId, toolId: decision.toolId,
      usage: decision.usage, situations: decision.usageContext.situations, exclusions: decision.usageContext.exclusions,
      evidenceRefs: decision.usageContext.evidenceRefs, order });
  }

  return { ok: true as const, lessons };
}

/** Freeze at the next normal mount; the execution model judges semantic
 * applicability from conditions, including when no task-situation tag was supplied. */
export async function readToolUsageGuidance(boardRoot: string, versionId: string, workspaceId: string, taskSituation?: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  return assessedUsageLessonsFromBoard(loaded.state, versionId, workspaceId, taskSituation);
}

export function assessedUsageLessonsFromBoard(state: BoardState, versionId: string, workspaceId?: string, taskSituation?: string) {
  const proposed = usageLessonsFromBoard(state, versionId);
  if (!proposed.ok) return proposed;

  const feedback = taskFeedbackForWorkspace(state, versionId, workspaceId);
  if (!feedback.ok) return feedback;

  const order = new Map(state.assets.map((asset, index) => [asset.versionId, index]));
  const assessments: ToolUsageAssessment[] = feedback.entries.map(entry => ({ ...entry, order: order.get(entry.feedbackVersionId)!,
    observedLessonRefs: [...new Set((state.toolUses ?? []).filter(use => entry.feedback.useIds.includes(use.useId) && use.execution === "returned")
      .flatMap(use => use.usageLessonRefs ?? []))] }));
  const lessons = assessToolUsageLessons(proposed.lessons, assessments);
  // One actionable lesson and one correction have a visible budget in the
  // existing frozen catalog. Full history remains available through context.
  const lessonBindings = toolUsageLessonAdvice(lessons, taskSituation).slice(-1);
  const guidance = [...lessonBindings.map(row => row.text), ...toolFeedbackGuidance(assessments, taskSituation)];

  return { ok: true as const, guidance, lessonBindings, lessons };
}
