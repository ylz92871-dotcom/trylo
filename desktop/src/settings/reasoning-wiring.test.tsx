import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsModal } from '../components/app-shell/SettingsModal';
import { applyProfile, connectionFields, loadSettings, saveSettings, settingsDefaults } from './settings-store';
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor';
import { buildTryloV1Args } from '../host-adapter/trylo-v1-runner';
import { providerArgsFor } from '../host-adapter/cli-auth-status';
import type { FilePath } from '../host-adapter/types';

vi.mock('../components/app-shell/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../components/app-shell/WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('../components/app-shell/SkillsModal', () => ({ SkillsModal: () => null }));

afterEach(() => { cleanup(); window.localStorage.clear(); });
const configured = { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const, apiFormat: 'openai' as const,
  apiModel: 'glm-5.3', apiHost: 'https://model.example/v1', apiKey: 'local-test-only' };

it('saves the selected effort and restores it with a named connection', () => {
  const next = { ...configured, reasoningEffort: 'high' as const };
  const profile = { id: 'deep', name: 'Deep', ...connectionFields(next) };
  saveSettings({ ...next, modelProfiles: [profile], activeModelProfileId: profile.id });
  expect(loadSettings()).toMatchObject({ reasoningEffort: 'high', modelProfiles: [expect.objectContaining({ reasoningEffort: 'high' })] });
  expect(applyProfile(configured, loadSettings().modelProfiles[0]!)).toMatchObject({ reasoningEffort: 'high' });
});

it('selects and saves effort in the real model connection form', () => {
  const onSave = vi.fn();
  render(<SettingsModal open initial={configured} onSave={onSave} onClose={vi.fn()} />);
  const select = screen.getByRole('combobox', { name: '思考强度' });
  expect(select).toHaveValue('');
  expect(within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['', 'low', 'high', 'max']);
  fireEvent.change(select, { target: { value: 'low' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low' }), 'connection');
  expect(loadSettings()).toMatchObject({ reasoningEffort: 'low' });
});

it('requires a new choice when a model change makes the selected effort unsupported', () => {
  const onSave = vi.fn();
  const previous = { ...configured, apiModel: 'custom-model', reasoningEffort: 'medium' as const };
  render(<SettingsModal open initial={previous} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'glm-5.3' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('思考'))).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
});

it('carries explicit effort from settings to argv and omits it for the default and legacy', () => {
  const cwd = 'D:/fixture' as FilePath;
  const next = { ...configured, reasoningEffort: 'high' as const };
  const run = settingsForCodeRun(next, cwd);
  expect(run).toMatchObject({ reasoningEffort: 'high' });
  const input = { cliPath: run.cliPath, cwd, model: run.apiModel, reasoningEffort: 'high' as const };
  expect(buildTryloV1Args(input).args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high']));
  expect(settingsForCodeRun(configured, cwd)).not.toHaveProperty('reasoningEffort');
  expect(settingsForCodeRun({ ...next, cliRuntimeProtocol: 'legacy-stream-json' }, cwd)).not.toHaveProperty('reasoningEffort');
});

it('preserves a complete Responses URL for a declared provider', () => {
  expect(providerArgsFor({ apiFormat: 'openai', providerId: 'my-responses', apiHost: 'https://model.example/v1/responses' }))
    .toMatchObject({ providerId: 'my-responses', endpoint: 'https://model.example/v1/responses' });
});
