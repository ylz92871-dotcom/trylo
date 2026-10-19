import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { connectionFields, loadSettings, settingsDefaults } from '../../settings/settings-store';

vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }));

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_TRYLO_CLI_RUNTIME_PROTOCOL', 'trylo-v1');
});
afterEach(() => { localStorage.clear(); vi.unstubAllEnvs(); });

it('saves a legacy selection with its entry and keeps it after reloading development settings', () => {
  const initial = { ...settingsDefaults, cliPath: '', apiModel: 'recording-model' };
  const onSave = vi.fn();
  render(<SettingsModal open initialTab="behavior" initial={initial} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('CLI runtime'), { target: { value: 'legacy-stream-json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ cliRuntimeProtocol: 'legacy-stream-json',
    cliPath: settingsDefaults.cliPath, cliRuntimeSelection: 'user' }), 'preferences');
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'legacy-stream-json', cliPath: settingsDefaults.cliPath });
  expect(connectionFields(loadSettings())).toEqual(connectionFields(initial));
});

it('switches back to the new CLI with automatic path resolution despite a recording fallback', () => {
  vi.stubEnv('VITE_TRYLO_CLI_RUNTIME_PROTOCOL', 'legacy-stream-json');
  const initial = { ...settingsDefaults, cliRuntimeProtocol: 'legacy-stream-json' as const };
  render(<SettingsModal open initialTab="behavior" initial={initial} onSave={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('CLI runtime'), { target: { value: 'trylo-v1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'trylo-v1', cliPath: '', cliRuntimeSelection: 'user' });
});
