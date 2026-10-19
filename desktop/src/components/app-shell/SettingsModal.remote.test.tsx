import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { settingsDefaults } from '../../settings/settings-store';

test('settings links to the unified remote dialog instead of duplicating account login', () => {
  const onOpenRemote = vi.fn();
  render(<SettingsModal open initial={settingsDefaults} initialTab="remote" onOpenRemote={onOpenRemote} onClose={vi.fn()}/>);
  expect(screen.queryByLabelText('密码（至少 12 位）')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开远程与连接' }));
  expect(onOpenRemote).toHaveBeenCalledOnce();
});
