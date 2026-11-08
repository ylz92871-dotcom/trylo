/** Desktop's validated projection of the CLI goal_state v1 contract. */
export const GOAL_STATUSES = ['active', 'paused_by_user', 'paused_by_system', 'budget_exhausted', 'cancelled', 'complete', 'blocked'] as const;
export type GoalStatus = typeof GOAL_STATUSES[number];
export interface GoalSnapshot {
  readonly objective: string; readonly status: GoalStatus; readonly tokensUsed: number;
  readonly tokenBudget?: number; readonly createdAtTurn: string; readonly updatedAtTurn: string; readonly note?: string;
  readonly usageUncertain?: true;
}
export type GoalCommand = { readonly version: 1; readonly action: 'create' | 'edit'; readonly objective: string; readonly tokenBudget?: number }
  | { readonly version: 1; readonly action: 'resume' | 'cancel'; readonly tokenBudget?: number };
export type GoalControl = GoalCommand | { readonly version: 1; readonly action: 'pause' };
export function isGoalSnapshot(value: unknown): value is GoalSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  return typeof g.objective === 'string' && g.objective.trim().length > 0 && g.objective.length <= 2000
    && GOAL_STATUSES.includes(g.status as GoalStatus) && typeof g.tokensUsed === 'number' && Number.isFinite(g.tokensUsed) && g.tokensUsed >= 0
    && typeof g.createdAtTurn === 'string' && g.createdAtTurn.length > 0 && typeof g.updatedAtTurn === 'string' && g.updatedAtTurn.length > 0
    && (g.note === undefined || typeof g.note === 'string')
    && (g.usageUncertain === undefined || g.usageUncertain === true)
    && (g.tokenBudget === undefined || (typeof g.tokenBudget === 'number' && Number.isSafeInteger(g.tokenBudget) && g.tokenBudget > 0));
}
