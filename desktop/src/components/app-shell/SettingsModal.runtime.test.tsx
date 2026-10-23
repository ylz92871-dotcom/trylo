import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllEnvs(); });

it('saves a legacy selection with its entry and keeps it after reloading development settings', () => {
  const initial = { ...settingsDefaults, cliPath: '', apiModel: 'recording-model' };
  const onSave = vi.fn();
  render(<SettingsModal open initialTab="behavior" initial={initial} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('CLI runtime'), { target: { value: 'legacy-stream-json' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
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
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(loadSettings()).toMatchObject({ cliRuntimeProtocol: 'trylo-v1', cliPath: '', cliRuntimeSelection: 'user' });
});

it('offers only the new CLI in a new-only release', () => {
  vi.stubEnv('VITE_TRYLO_NEW_CLI_ONLY', 'true');
  render(<SettingsModal open initialTab="behavior" initial={loadSettings()} onSave={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByLabelText('CLI runtime')).toHaveValue('trylo-v1');
  expect(screen.queryByRole('option', { name: '旧 CLI — legacy-stream-json' })).not.toBeInTheDocument();
  expect(screen.getByText('此版本仅包含新版 Trylo CLI。', { exact: false })).toBeInTheDocument();
});
