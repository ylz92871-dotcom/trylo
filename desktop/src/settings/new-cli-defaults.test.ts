import { afterEach, expect, it, vi } from 'vitest';
import { loadSettings, settingsDefaults } from './settings-store';
import { effectiveV1CliPath } from '../host-adapter/cli-runtime-path';

afterEach(() => { localStorage.clear(); vi.unstubAllEnvs(); });

it('starts with an automatically resolved new CLI instead of a developer legacy path', () => {
  expect(settingsDefaults.cliRuntimeProtocol).toBe('trylo-v1');
  expect(settingsDefaults.cliPath).toBe('');
});

const resolution = { cliScript: 'C:/Trylo/cli/dist/cmd/trylo/main.js', cliSource: 'bundled' as const,
  nodeProgram: 'C:/Trylo/runtime/node.exe', nodeSource: 'bundled' as const };

for (const legacyPath of ['C:/trylo-cli/cli.js', 'D:/CC/trylo/trylo cli/cli.js', 'd:\\cc\\trylo\\trylo cli\\CLI.JS']) {
  it(`resolves the historical entry to the new CLI: ${legacyPath}`, () => {
    expect(effectiveV1CliPath(legacyPath, resolution)).toEqual({ path: resolution.cliScript, substituted: true });
  });

  it.each([true, false])(`migrates the old default entry without touching stored connection data (dev=%s): ${legacyPath}`, development => {
    vi.stubEnv('DEV', development);
    vi.stubEnv('VITE_TRYLO_NEW_CLI_ONLY', 'true');
    const previous = { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1', cliRuntimeSelection: 'user',
      cliPath: legacyPath, apiHost: 'https://fixture.example', apiModel: 'kept-model', apiKey: 'fixture-key', permissionLevel: 'read_only' };
    localStorage.setItem('trylo:settings:v1', JSON.stringify(previous));
    expect(loadSettings()).toEqual({ ...previous, cliPath: '' });
    expect(JSON.parse(localStorage.getItem('trylo:settings:v1')!)).toEqual(previous);
  });
}

it('migrates a saved legacy selection in development even when it was explicit', () => {
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_TRYLO_NEW_CLI_ONLY', 'true');
  vi.stubEnv('VITE_TRYLO_CLI_RUNTIME_PROTOCOL', 'legacy-stream-json');
  const previous = { ...settingsDefaults, cliRuntimeProtocol: 'legacy-stream-json', cliRuntimeSelection: 'user',
    cliPath: 'C:/custom/legacy.cjs', providerId: 'kept-provider', apiKey: 'fixture-key' };
  localStorage.setItem('trylo:settings:v1', JSON.stringify(previous));
  expect(loadSettings()).toEqual({ ...previous, cliRuntimeProtocol: 'trylo-v1', cliPath: '' });
  expect(JSON.parse(localStorage.getItem('trylo:settings:v1')!)).toEqual(previous);
});

it('preserves an explicitly configured new CLI entry', () => {
  vi.stubEnv('VITE_TRYLO_NEW_CLI_ONLY', 'true');
  const previous = { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1', cliPath: 'C:/custom/main.js' };
  localStorage.setItem('trylo:settings:v1', JSON.stringify(previous));
  expect(loadSettings()).toEqual(previous);
});
