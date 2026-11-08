import type { BoardState } from "../../../../control/state.js";
import type { ToolParentUsageContext, ToolParentUsageHistory, ToolParentUsageLesson } from "../domain/evolution/parent-usage.js";
import type { AssessedToolUsageLesson } from "../domain/evolution/usage-learning.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { assessedUsageLessonsFromBoard } from "./usage-lessons.js";
import { taskFeedbackFromBoard } from "./tool-task-feedback.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { toolLearningFeedbackScope } from "./feedback-input-facts.js";
import { planForJob } from "./pipeline-records.js";

const MAX_PARENTS = 8, MAX_SOURCES = 8, MAX_LESSONS = 4, MAX_ASSESSMENTS = 3;

/** Exact presented parents only. The production aliases of a pure candidate are
 * distinct evidence sources, never different versions of an inherited lesson.
 * This pure view does not import learning-context or traverse arbitrary lineage. */
export function toolParentUsageContext(state: BoardState, input: { readonly scope: string; readonly parentVersionIds: readonly string[];
  readonly targetVersionId?: string; readonly plan?: ToolLearningPlan }): PipelineFailure | { readonly ok: true; readonly context: ToolParentUsageContext } {
  const requested = [...new Set(input.parentVersionIds)];
  const canonicalTarget = input.targetVersionId === undefined ? undefined : toolLearningParentFromBoard(state, input.targetVersionId);
  const target = canonicalTarget?.ok ? canonicalTarget.parent.versionId : input.targetVersionId;
  const ordered = requested.sort((left, right) => Number(right === target) - Number(left === target));
  const parents: ToolParentUsageHistory[] = [];

  for (const parentVersionId of ordered.slice(0, MAX_PARENTS)) {
    const parent = toolLearningParentFromBoard(state, parentVersionId);
    if (!parent.ok) return parent;

    if (parent.parent.scope !== input.scope) return pipelineFailure("parent_usage_scope_mismatch", "historical usage must remain in the presented parent's learning scope");

    const scoped = input.plan === undefined ? undefined : toolLearningFeedbackScope(state, input.plan, parentVersionId);
    if (scoped !== undefined && !scoped.ok) return scoped;

    if (scoped === undefined || scoped.historyScope === "unknown" || scoped.workspaceId === undefined) {
      parents.push({ parentVersionId, historyScope: "unknown", coverage: "partial", sources: [], omittedSourceCount: 0, omittedLessonCount: 0 });
      continue;
    }

    const feedbackIds = new Set(scoped.entries.map(entry => entry.feedbackVersionId));
    const omittedDecisions = new Set<string>();
    const allowedDecisions = new Set<string>();

    for (const asset of state.assets) {
      if (!recordOf(asset.content) || asset.content.type !== "tool_learning_decision"
        || typeof asset.content.selectedToolVersionId !== "string" || !scoped.versions.includes(asset.content.selectedToolVersionId)
        || typeof asset.content.jobId !== "string") continue;

      const original = planForJob(state, asset.content.jobId);
      if (original === undefined) continue;

      const source = toolLearningFeedbackScope(state, original, asset.content.selectedToolVersionId);
      if (!source.ok) return source;

      if (source.historyScope === "unknown") omittedDecisions.add(asset.versionId);
      else if (source.workspaceId === scoped.workspaceId) allowedDecisions.add(asset.versionId);
    }

    // Standing must be recomputed from bound facts, not merely decorated with
    // filtered citations after foreign feedback already changed its verdict.
    const projected: BoardState = { ...state, toolUses: [...scoped.uses], assets: state.assets.filter(asset => {
      if (!recordOf(asset.content)) return true;
      if (asset.content.type === "tool_task_feedback") return feedbackIds.has(asset.versionId);
      if (asset.content.type === "tool_learning_decision" && typeof asset.content.selectedToolVersionId === "string"
        && scoped.versions.includes(asset.content.selectedToolVersionId)) return allowedDecisions.has(asset.versionId);
      return true;
    }) };
    const versions = [...scoped.versions].reverse().sort((left, right) =>
      Number(right === input.targetVersionId) - Number(left === input.targetVersionId));
    const rows: { readonly versionId: string; readonly contentHash: string; readonly lesson: AssessedToolUsageLesson;
      readonly assessments: ToolParentUsageLesson["assessments"]; readonly omittedAssessmentCount: number }[] = [];

    for (const versionId of versions.slice(0, MAX_SOURCES)) {
      const exact = toolLearningParentFromBoard(state, versionId);
      if (!exact.ok) return exact;

      if (exact.parent.scope !== input.scope) return pipelineFailure("parent_usage_scope_mismatch", "a production usage source belongs to another learning scope");

      const assessed = assessedUsageLessonsFromBoard(projected, versionId);
      if (!assessed.ok) return assessed;

      const feedback = taskFeedbackFromBoard(projected, versionId);
      if (!feedback.ok) return feedback;

      const asset = state.assets.find(item => item.versionId === versionId)!;

      for (const lesson of assessed.lessons) {
        const relevant = feedback.entries.filter(entry => lesson.assessmentRefs.includes(entry.feedbackVersionId));
        const selected = [...relevant].reverse().sort((left, right) => Number(isCorrection(right.feedback)) - Number(isCorrection(left.feedback))).slice(0, MAX_ASSESSMENTS);
        const assessments = selected.map(entry => {
          const returned = scoped.uses.filter(use => entry.feedback.useIds.includes(use.useId) && use.execution === "returned");
          return { feedbackRef: entry.feedbackVersionId, feedback: entry.feedback, returnedUseIds: returned.map(use => use.useId),
            observedLessonUseIds: returned.filter(use => use.usageLessonRefs?.includes(lesson.decisionVersionId)).map(use => use.useId) };
        });

        rows.push({ versionId, contentHash: asset.contentHash, lesson, assessments, omittedAssessmentCount: relevant.length - selected.length });
      }
    }

    rows.sort((left, right) => Number(right.versionId === input.targetVersionId) - Number(left.versionId === input.targetVersionId)
      || Number(hasCorrection(right.lesson) || right.assessments.some(entry => isCorrection(entry.feedback)))
        - Number(hasCorrection(left.lesson) || left.assessments.some(entry => isCorrection(entry.feedback))) || right.lesson.order - left.lesson.order);
    const selected = rows.slice(0, MAX_LESSONS);
    const sources: ToolParentUsageHistory["sources"][number][] = [];

    for (const row of selected) {
      const { order: _order, ...lesson } = row.lesson;
      const value = { ...lesson, assessments: row.assessments, omittedAssessmentCount: row.omittedAssessmentCount };
      const source = sources.find(source => source.toolVersionId === row.versionId);
      if (source === undefined) sources.push({ toolVersionId: row.versionId, contentHash: row.contentHash, lessons: [value] });
      else sources[sources.indexOf(source)] = { ...source, lessons: [...source.lessons, value] };
    }

    const omittedSourceCount = Math.max(0, versions.length - MAX_SOURCES), omittedLessonCount = rows.length - selected.length + omittedDecisions.size;

    parents.push({ parentVersionId, historyScope: "bound", sources, omittedSourceCount, omittedLessonCount,
      coverage: omittedSourceCount > 0 || omittedLessonCount > 0 || selected.some(row => row.omittedAssessmentCount > 0) ? "partial" : "complete" });
  }

  const omittedParentVersionIds = ordered.slice(MAX_PARENTS);

  return { ok: true, context: { parents, omittedParentVersionIds,
    coverage: omittedParentVersionIds.length > 0 || parents.some(parent => parent.coverage === "partial") ? "partial" : "complete" } };
}

function hasCorrection(lesson: AssessedToolUsageLesson): boolean {
  return lesson.conditionStandings.some(condition => condition.standing === "withdrawn" || condition.standing === "contested");
}

function isCorrection(feedback: ToolParentUsageLesson["assessments"][number]["feedback"]): boolean {
  return feedback.recommendation === "avoid" || feedback.recommendation === "change_usage" || feedback.outcome === "unsolved" || feedback.outcome === "partial";
}
