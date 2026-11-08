import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collaborationLearningSettings, DEFAULT_COLLABORATION_LEARNING } from './collaboration-learning';
import { loadSettings, saveSettings, settingsDefaults } from './settings-store';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('collaboration learning settings compatibility', () => {
  it('migrates absent legacy settings to the separately authorized team default', () => {
    localStorage.setItem('trylo:settings:v1', JSON.stringify({ ...settingsDefaults, collaborationLearning: undefined }));
    expect(loadSettings().collaborationLearning).toEqual(DEFAULT_COLLABORATION_LEARNING);
  });

  it('keeps explicit opt-out and quota after save and reload without changing user learning', () => {
    const userLearning = { ...settingsDefaults.userLearning, enabled: false };
    saveSettings({ ...settingsDefaults, collaborationLearning: { enabled: false, tokenBudget: 32000 }, userLearning });
    expect(loadSettings()).toMatchObject({ collaborationLearning: { enabled: false, tokenBudget: 32000 }, userLearning });
    saveSettings({ ...loadSettings(), collaborationLearning: { enabled: true, tokenBudget: 8000 } });
    expect(loadSettings()).toMatchObject({ collaborationLearning: { enabled: true, tokenBudget: 8000 }, userLearning });
  });

  it('uses a bounded quota for corrupt or future settings while preserving an explicit opt-out', () => {
    for (const tokenBudget of [null, '32000', -1, 0, 255, 64001, 1000.5, Number.POSITIVE_INFINITY]) {
      expect(collaborationLearningSettings({ enabled: false, tokenBudget })).toEqual({ enabled: false, tokenBudget: 16000 });
    }
    expect(collaborationLearningSettings({ enabled: true, tokenBudget: 64000 })).toEqual({ enabled: true, tokenBudget: 64000 });
  });
});
