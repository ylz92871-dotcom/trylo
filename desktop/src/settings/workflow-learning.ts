export interface WorkflowLearningSettings {
  readonly enabled: boolean;
  readonly tokenBudget: number;
}

export const DEFAULT_WORKFLOW_LEARNING: WorkflowLearningSettings = { enabled: false, tokenBudget: 16000 };

/** Missing settings preserve an existing installation's collection choices. */
export function workflowLearningSettings(value: unknown): WorkflowLearningSettings {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const budget = raw.tokenBudget;
  return { enabled: raw.enabled === true,
    tokenBudget: typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 4096 && budget <= 64000
      ? budget : DEFAULT_WORKFLOW_LEARNING.tokenBudget };
}
