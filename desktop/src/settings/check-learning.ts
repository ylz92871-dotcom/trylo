export interface CheckLearningSettings {
  readonly enabled: boolean;
  readonly tokenBudget: number;
}

export const MAX_CHECK_LEARNING_TOKENS = 262144;
export const DEFAULT_CHECK_LEARNING: CheckLearningSettings = { enabled: false, tokenBudget: 32768 };

export function checkLearningBudgetProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CHECK_LEARNING_TOKENS
    ? undefined : '请输入 0–262144 的整数 token 额度。';
}

/** Additive migration: no existing learning preference enables this subsystem. */
export function checkLearningSettings(value: unknown): CheckLearningSettings {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { enabled: row.enabled === true,
    tokenBudget: checkLearningBudgetProblem(row.tokenBudget) === undefined ? row.tokenBudget as number : DEFAULT_CHECK_LEARNING.tokenBudget };
}

/** The current CLI check runtime persists its experiences; private sends must not enter it. */
export function checkLearningForRun(value: CheckLearningSettings | undefined, directive?: {
  readonly applyExistingPreferences?: boolean;
  readonly collectNewLearning: boolean;
  readonly retention: 'normal' | 'session_only';
}): { readonly checkLearning?: CheckLearningSettings } {
  const settings = checkLearningSettings(value);
  return settings.enabled && directive?.applyExistingPreferences !== false && directive?.collectNewLearning !== false && directive?.retention !== 'session_only'
    ? { checkLearning: { ...settings } } : {};
}
