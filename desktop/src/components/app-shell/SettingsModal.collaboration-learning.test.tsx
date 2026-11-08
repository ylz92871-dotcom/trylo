import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { loadSettings, settingsDefaults } from '../../settings/settings-store';

vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }));

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); });

it('saves the collaboration quota independently and retains it across closing and reopening settings', () => {
  const onSave = vi.fn();
  const userLearning = { ...settingsDefaults.userLearning, enabled: false };
  const rendered = render(<SettingsModal open initialTab="learning" initial={{ ...settingsDefaults, userLearning }}
    onSave={onSave} onClose={vi.fn()} />);
  expect(screen.getByRole('checkbox', { name: '启用团队协作学习' })).toBeChecked();
  fireEvent.change(screen.getByLabelText('每个团队任务的学习额度'), { target: { value: '32000' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    collaborationLearning: { enabled: true, tokenBudget: 32000 }, userLearning,
  }), 'preferences');
  rendered.unmount();
  render(<SettingsModal open initialTab="learning" initial={loadSettings()} onClose={vi.fn()} />);
  expect(screen.getByLabelText('每个团队任务的学习额度')).toHaveValue('32000');
});

it('makes an explicit opt-out visible and persists it without losing the allocated quota', () => {
  render(<SettingsModal open initialTab="learning" initial={settingsDefaults} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: '启用团队协作学习' }));
  expect(screen.getByLabelText('每个团队任务的学习额度')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(loadSettings().collaborationLearning).toEqual({ enabled: false, tokenBudget: 16000 });
});
