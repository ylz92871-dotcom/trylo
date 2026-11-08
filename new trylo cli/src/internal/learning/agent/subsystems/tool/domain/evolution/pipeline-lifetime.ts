import type { BoardState } from "../../../../../control/state.js";
import { MAX_CENTRAL_LEARNING_RESOURCE } from "../../../../../control/central-learning-resources.js";
import { toolLearningPlanFromBoard, toolResearchReportsMatchRoot } from "./research-lineage.js";

export function isToolPipelineCounter(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= MAX_CENTRAL_LEARNING_RESOURCE;
}

/** Readability survives closing a managed grant. Only the shared writer's live
 * checkpoint/claim proof can authorize a continuation beyond the legacy cap. */
export function hasManagedToolPipelineHistory(state: BoardState, jobId: string): boolean {
  const plan = toolLearningPlanFromBoard(state, jobId);
  if (plan === undefined) return false;
  return (state.centralLearningGrants ?? []).some(grant => grant.domain === "tool" && grant.budgetId !== undefined
    && state.centralLearningBudgets?.some(root => root.budgetId === grant.budgetId && root.scope === grant.scope)
    && state.learningIssues?.some(issue => issue.issueId === grant.issueId && issue.scope === grant.scope && issue.reports.length > 0
      && toolResearchReportsMatchRoot(state, issue.reports, plan)));
}
