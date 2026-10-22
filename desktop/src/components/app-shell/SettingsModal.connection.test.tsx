import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { connectionFields, loadSettings, saveSettings, settingsDefaults } from '../../settings/settings-store';
import { testConnection, type TestConnectionResult } from '../../host-adapter/test-connection';
vi.mock('../../host-adapter/test-connection', () => ({ testConnection: vi.fn() }));

vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }));

const profile = { id: 'old', name: 'Old', ...connectionFields(settingsDefaults), apiFormat: 'anthropic' as const, apiModel: 'old-model' };
const initial = { ...settingsDefaults, ...connectionFields(profile), modelProfiles: [profile], activeModelProfileId: profile.id, poolModel: 'old-pool' };
beforeEach(() => { window.localStorage.clear(); saveSettings(initial); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

it('saving an edited OpenAI connection detaches a stale saved-profile pointer and pool override', () => {
  const onSave = vi.fn(), onClose = vi.fn();
  render(<SettingsModal open initial={initial} onSave={onSave} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("API 协议"), { target: { value: 'openai' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiFormat: 'openai', activeModelProfileId: '', poolModel: '' }), 'connection');
  expect(loadSettings()).toMatchObject({ apiFormat: 'openai', activeModelProfileId: '', poolModel: '' });
  expect(loadSettings().modelProfiles[0]?.apiFormat).toBe('anthropic');
  expect(onClose).toHaveBeenCalledOnce();
});

it('a failed primary write keeps the edited form open and never reports save success', () => {
  const onSave = vi.fn(), onClose = vi.fn();
  render(<SettingsModal open initial={initial} onSave={onSave} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("API 协议"), { target: { value: 'openai' } });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(screen.getByRole('alert')).toHaveTextContent('保存');
  expect(screen.getByLabelText("API 协议")).toHaveValue('openai');
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(loadSettings().apiFormat).toBe('anthropic');
});

it('applies connection edits even when saving from another category', () => {
  const onSave = vi.fn();
  render(<SettingsModal open initial={initial} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'updated-model' } });
  fireEvent.click(screen.getByRole('button', { name: '工具与控制' }));
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiModel: 'updated-model', poolModel: '' }), 'connection');
});

it('keeps malformed custom headers editable and reports how to fix them', () => {
  const onSave = vi.fn();
  render(<SettingsModal open initial={initial} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('额外请求头（JSON）'), { target: { value: '{broken' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(screen.getByRole('alert')).toHaveTextContent('JSON 对象');
  expect(onSave).not.toHaveBeenCalled();
  expect(loadSettings().extraHeadersText).toBe(initial.extraHeadersText);
});

it('ignores an old service probe after editing the address and shows only the new result', async () => {
  let resolveOld!: (result: TestConnectionResult) => void;
  let resolveNew!: (result: TestConnectionResult) => void;
  vi.mocked(testConnection).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  render(<SettingsModal open initial={initial} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '检查服务可达性' }));
  fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://changed.example/v1' } });
  fireEvent.click(screen.getByRole('button', { name: '检查服务可达性' }));
  const result = { ok: true, provider: 'anthropic', keyStatus: 'present', endpoint: '', message: 'old endpoint result' };
  await act(async () => resolveOld(result));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: '正在检查…' })).toBeDisabled();
  await act(async () => resolveNew({ ...result, message: 'new endpoint result' }));
  expect(screen.getByRole('status')).toHaveTextContent('new endpoint result');
});
