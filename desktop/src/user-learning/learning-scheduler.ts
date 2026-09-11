import { DEFAULT_LEARNING_INFERENCE, type UserLearningSettings } from './types';

export function inferenceSettings(settings: UserLearningSettings) {
  return settings.inference ?? DEFAULT_LEARNING_INFERENCE;
}

export function shouldRunLearningLlm(settings: UserLearningSettings, reason: 'trace' | 'correction' | 'manual' = 'trace'): boolean {
  const inference = inferenceSettings(settings);
  if (!settings.enabled) return false;
  if (!inference.enabled || inference.mode !== 'assisted') return false;
  if (reason === 'trace' && inference.maxCallsPerTrace <= 0) return false;
  return true;
}
