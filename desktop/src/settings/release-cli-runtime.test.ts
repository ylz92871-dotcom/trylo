import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); vi.resetModules(); vi.stubEnv('DEV', false); });
afterEach(() => { localStorage.clear(); vi.unstubAllEnvs(); vi.resetModules(); });

it('uses the legacy release default on a clean installation', async () => {
  vi.stubEnv('VITE_TRYLO_DEFAULT_CLI_RUNTIME', 'legacy-stream-json');
  const { loadSettings } = await import('./settings-store');
  expect(loadSettings().cliRuntimeProtocol).toBe('legacy-stream-json');
});

it('preserves an explicit new CLI selection across a legacy release reload', async () => {
  vi.stubEnv('VITE_TRYLO_DEFAULT_CLI_RUNTIME', 'legacy-stream-json');
  const settings = await import('./settings-store');
  settings.saveSettings({ ...settings.settingsDefaults, cliRuntimeProtocol: 'trylo-v1',
    cliRuntimeSelection: 'user', cliPath: '' });
  vi.resetModules();
  expect((await import('./settings-store')).loadSettings()).toMatchObject({
    cliRuntimeProtocol: 'trylo-v1', cliRuntimeSelection: 'user', cliPath: '',
  });
});

it('keeps the public source default when the release value is invalid', async () => {
  vi.stubEnv('VITE_TRYLO_DEFAULT_CLI_RUNTIME', 'invalid');
  const { loadSettings } = await import('./settings-store');
  expect(loadSettings().cliRuntimeProtocol).toBe('trylo-v1');
});
