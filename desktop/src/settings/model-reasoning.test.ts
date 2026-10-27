import { afterEach, expect, it } from 'vitest';
import { settingsDefaults, saveSettings, loadSettings } from './settings-store';
import { contextModelKey } from './context-window';
import { amdReasoningChoices, modelReasoningEffort, parseModelReasoningPreferences } from './model-reasoning';
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor';
afterEach(() => window.localStorage.clear());

it('keeps the free-model effort separate from private API settings and other pool models', () => {
  const qwen = { ...settingsDefaults, apiModel: 'private-model', reasoningEffort: 'high' as const, poolModel: 'Qwen3.8-Flash-Next' };
  expect(modelReasoningEffort(qwen)).toBeUndefined();
  const next = { ...qwen, modelReasoningPreferences: { [contextModelKey(qwen)]: 'low' as const } };
  saveSettings(next);
  expect(modelReasoningEffort(loadSettings())).toBe('low');
  expect(modelReasoningEffort({ ...next, poolModel: 'GLM-5.3-Flash' })).toBeUndefined();
  expect(modelReasoningEffort({ ...next, poolModel: '' })).toBe('high');
  const run = settingsForCodeRun(next, 'D:/fixture');
  expect(run.reasoningEffort).toBe('low'); expect(run.platformModel).toBe('Qwen3.8-Flash-Next');
  expect(run.apiKey).toBeUndefined();
  expect(settingsForCodeRun({ ...next, modelReasoningPreferences: { [contextModelKey(qwen)]: 'default' } }, 'D:/fixture')).not.toHaveProperty('reasoningEffort');
});
it('uses AMD-specific levels rather than direct-vendor GLM/Qwen assumptions', () => {
  expect(amdReasoningChoices('Qwen3.8-Flash-Next').levels).toEqual(['none', 'low', 'medium', 'xhigh']);
  expect(amdReasoningChoices('GLM-5.3-Flash').levels).toEqual(['low', 'medium', 'high']);
  expect(amdReasoningChoices('MiniCPM5-2B').levels).toEqual([]);
  expect(parseModelReasoningPreferences({ one: 'low', two: 'default', invalid: 'ultra', other: 12 })).toEqual({ one: 'low', two: 'default' });
});
