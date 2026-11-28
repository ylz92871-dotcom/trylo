import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { loadSettings, saveSettings, settingsDefaults } from '../../settings/settings-store';

vi.mock('./AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('./WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('./SkillsModal', () => ({ SkillsModal: () => null }));
const initial = { ...settingsDefaults, apiModel: 'recording-model', companion: { enabled: true } };
beforeEach(() => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
  localStorage.clear();
  saveSettings(initial);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('keeps the companion checkbox draft local on cancel and commits the saved value on reopen', () => {
  const onSave = vi.fn(),
    onClose = vi.fn();
  const view = render(
    <SettingsModal
      open
      initialTab="behavior"
      initial={initial}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: '启用桌面伙伴' }));
  expect(screen.getByRole('checkbox', { name: '启用桌面伙伴' })).not.toBeChecked();
  expect(loadSettings().companion.enabled).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onClose).toHaveBeenCalledOnce();
  view.rerender(
    <SettingsModal
      open={false}
      initialTab="behavior"
      initial={initial}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  view.rerender(
    <SettingsModal
      open
      initialTab="behavior"
      initial={initial}
      onSave={onSave}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('checkbox', { name: '启用桌面伙伴' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: '启用桌面伙伴' }));
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ companion: { enabled: false }, apiModel: initial.apiModel }),
    'preferences',
  );
  expect(loadSettings().companion.enabled).toBe(false);
  view.unmount();
  render(<SettingsModal open initialTab="behavior" initial={loadSettings()} onClose={vi.fn()} />);
  expect(screen.getByRole('checkbox', { name: '启用桌面伙伴' })).not.toBeChecked();
});

it('saves a separate opt-in for the macOS native companion', () => {
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  const onSave = vi.fn();
  render(<SettingsModal open initialTab="behavior" initial={initial} onSave={onSave} onClose={vi.fn()} />);
  const toggle = screen.getByRole('checkbox', { name: '启用桌面伙伴' });
  expect(toggle).toBeEnabled();
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    companion: { enabled: true, macosEnabled: true },
  }), 'preferences');
  expect(loadSettings().companion).toEqual({ enabled: true, macosEnabled: true });
});
