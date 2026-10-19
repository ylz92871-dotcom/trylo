import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSettings, saveSettings, settingsDefaults } from './settings-store';

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_TRYLO_CLI_RUNTIME_PROTOCOL', 'trylo-v1');
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

it('uses the resolved new CLI in development even with a persisted legacy selection', () => {
  const stored = { ...settingsDefaults, cliPath: 'D:/old/cli.js', apiModel: 'preview-model' };
  saveSettings(stored);
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'trylo-v1', cliPath: '', apiModel: 'preview-model' });
  expect(JSON.parse(window.localStorage.getItem('trylo:settings:v1')!)).toEqual(stored);
});

it('selects the new CLI before settings have ever been saved', () => {
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'trylo-v1', cliPath: '' });
});

it('restores the saved runtime when the development override is removed or invalid', () => {
  const stored = { ...settingsDefaults, cliPath: 'D:/old/cli.js' };
  saveSettings(stored);
  for (const value of ['', 'invalid']) {
    vi.stubEnv('VITE_TRYLO_CLI_RUNTIME_PROTOCOL', value);
    expect(loadSettings()).toEqual(stored);
  }
});

it('never overrides a production build', () => {
  vi.stubEnv('DEV', false);
  saveSettings(settingsDefaults);
  expect(loadSettings()).toEqual(settingsDefaults);
});

it('keeps an explicit runtime selection after save and reload even with a development preview', () => {
  const stored = { ...settingsDefaults, cliRuntimeProtocol: 'legacy-stream-json',
    cliRuntimeSelection: 'user', cliPath: 'C:/trylo-cli/cli.js' };
  window.localStorage.setItem('trylo:settings:v1', JSON.stringify(stored));
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'legacy-stream-json',
    cliRuntimeSelection: 'user', cliPath: stored.cliPath });
});

it('pairs a temporary legacy preview with the legacy entry when the previous v1 path was empty', () => {
  vi.stubEnv('VITE_TRYLO_CLI_RUNTIME_PROTOCOL', 'legacy-stream-json');
  saveSettings({ ...settingsDefaults, cliPath: '' });
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'legacy-stream-json', cliPath: settingsDefaults.cliPath });
});
