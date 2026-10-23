import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadSettings, saveSettings, settingsDefaults } from './settings-store';

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_TRYLO_NEW_CLI_ONLY', 'true');
});
afterEach(() => { localStorage.clear(); vi.unstubAllEnvs(); });

it('migrates an explicitly saved legacy engine and path without changing connection or permission settings', () => {
  const previous = { ...settingsDefaults, cliRuntimeProtocol: 'legacy-stream-json' as const,
    cliRuntimeSelection: 'user' as const, cliPath: 'C:/old/cli.cjs',
    apiModel: 'my-model', apiHost: 'https://example.test', permissionLevel: 'read_only' as const };
  saveSettings(previous);
  expect(loadSettings()).toEqual({ ...previous, cliRuntimeProtocol: 'trylo-v1', cliPath: '' });
  expect(JSON.parse(localStorage.getItem('trylo:settings:v1')!)).toEqual(previous);
});

it('keeps an explicitly configured new CLI path', () => {
  const previous = { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const,
    cliRuntimeSelection: 'user' as const, cliPath: 'C:/custom/main.js' };
  saveSettings(previous);
  expect(loadSettings()).toEqual(previous);
});

it('ignores the historical default legacy path on a clean installation', () => {
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'trylo-v1', cliPath: '' });
});
