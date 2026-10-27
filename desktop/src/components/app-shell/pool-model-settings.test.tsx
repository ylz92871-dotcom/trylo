import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ModelContextSettings } from './ModelContextSettings';
import { SettingsModal } from './SettingsModal';
import { settingsDefaults, loadSettings } from '../../settings/settings-store';
import { contextModelKey } from '../../settings/context-window';
vi.mock('../../account/use-platform-models', () => ({ usePlatformModels: () => ({ models: [
  { id: 'Qwen3.8-Flash-Next', chat: true, pool: 'free', contextLength: 262144 },
  { id: 'DeepSeek-V4.1-Flash', chat: true, pool: 'free', contextLength: 1048576 },
  { id: 'GLM-5.3-Flash', chat: true, pool: 'free', contextLength: 262144 },
  { id: 'MiniCPM5-2B', chat: true, pool: 'free', contextLength: 131072 },
], loading: false, message: '' }) }));
vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }));
afterEach(() => { cleanup(); window.localStorage.clear(); });
const initial = { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const, poolModel: 'Qwen3.8-Flash-Next', apiModel: 'private', apiKey: 'private-test-key' };

it('shows synchronized capacity and only the selected AMD model reasoning levels', () => {
  function Harness() { const [form,setForm]=useState(initial); return <ModelContextSettings form={form} onChange={modelContextPreferences=>setForm({...form,modelContextPreferences})} onReasoningChange={modelReasoningPreferences=>setForm({...form,modelReasoningPreferences})}/>; }
  render(<Harness/>);
  expect(screen.getByText('AMD 容量 262,144 tokens')).toBeDefined();
  expect(screen.queryByLabelText('模型或服务端上限（tokens）')).toBeNull();
  const choices = () => within(screen.getByLabelText('免费模型思考强度')).getAllByRole('option').map(option=>(option as HTMLOptionElement).value);
  expect(choices()).toEqual(['default','none','low','medium','xhigh']);
  fireEvent.change(screen.getByLabelText('配置模型'),{target:{value:'pool:GLM-5.3-Flash'}});
  expect(choices()).toEqual(['default','low','medium','high']);
  fireEvent.change(screen.getByLabelText('配置模型'),{target:{value:'pool:MiniCPM5-2B'}});
  expect((screen.getByLabelText('免费模型思考强度') as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText('AMD 容量 131,072 tokens')).toBeDefined();
});
it('saves pool context and reasoning together without changing the selected pool or private credentials', () => {
  const save=vi.fn();render(<SettingsModal open initial={initial} onSave={save} onClose={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('上下文窗口'),{target:{value:'262144'}});
  fireEvent.change(screen.getByLabelText('免费模型思考强度'),{target:{value:'low'}});
  fireEvent.click(screen.getByRole('button',{name:'保存设置'}));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({poolModel:initial.poolModel,apiKey:initial.apiKey,apiModel:initial.apiModel}),'preferences');
  expect(loadSettings().modelContextPreferences?.[contextModelKey(initial)]?.window).toBe(262144);
  expect(loadSettings().modelReasoningPreferences?.[contextModelKey(initial)]).toBe('low');
});
