export interface CollaborationLearningSettings {
  readonly enabled: boolean;
  readonly tokenBudget: number;
}

export const DEFAULT_COLLABORATION_LEARNING: CollaborationLearningSettings = { enabled: true, tokenBudget: 16000 };

/** Old settings get the newly authorized team default; an explicit opt-out persists. */
export function collaborationLearningSettings(value: unknown): CollaborationLearningSettings {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tokens = row.tokenBudget;
  return { enabled: row.enabled !== false, tokenBudget: typeof tokens === 'number' && Number.isSafeInteger(tokens)
    && tokens >= 256 && tokens <= 64000 ? tokens : DEFAULT_COLLABORATION_LEARNING.tokenBudget };
}
