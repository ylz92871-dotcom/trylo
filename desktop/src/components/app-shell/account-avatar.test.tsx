import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { LeftRail } from './LeftRail';
import { useDesktopAccount } from '../../account/use-desktop-account';
import { defaultProfile } from '../../user-profile/profile-types';
import type { DesktopAccountPort } from '../../account/desktop-account';
import type { RelayAccountStatus } from '../../services-host/methods';

vi.mock('../../user-profile/profile-store', () => ({ userProfileStore: {
  load: async () => ({ ...defaultProfile(), nickname: '小渡', avatarUrl: null }),
  save: vi.fn(async value => ({ ...value, avatarUrl: null })), importAvatar: vi.fn(), pickImage: vi.fn(),
} }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
function fixture(loggedIn = false, remoteActive = false, delayedStatus?: Promise<RelayAccountStatus>) {
  const status = { loggedIn, username: loggedIn ? 'ylz' : '', serverUrl: 'https://relay.trylocode.me', online: false };
  const io: DesktopAccountPort = {
    relayStatus: vi.fn(async () => delayedStatus ? await delayedStatus : status), relayLogout: vi.fn(async () => ({ ...status, loggedIn: false })),
    relayBrowserBegin: vi.fn(async () => ({ id: 'attempt', verificationUrl: 'https://trylocode.me/account/#authorize?code=ABCDEF123456', userCode: 'ABCDEF123456', expiresAt: Date.now() + 600000, interval: 5000 })),
    relayBrowserPoll: vi.fn(async () => ({ status: 'complete' as const, account: { ...status, loggedIn: true, username: 'ylz' } })),
    relayBrowserCancel: vi.fn(async () => ({ ok: true })), relayBrowserOpen: vi.fn(async () => ({ ok: true })), relayAccountOpen: vi.fn(async () => ({ ok: true })),
  };
  function Shell() {
    const account = useDesktopAccount(io, { serverUrl: status.serverUrl });
    const [request, setRequest] = useState(0);
    return <><button onClick={() => setRequest(value => value + 1)}>从远程窗口打开账号</button><LeftRail account={account} accountOpenRequest={request} accountRemoteActive={remoteActive}
      workspaces={[]} currentWorkspaceId="fixture" sessions={[]} activeSessionId={null} runningSessionIds={new Set()} collapsed={false}
      onSwitchWorkspace={vi.fn()} onOpenFolder={vi.fn()} onCloseWorkspace={vi.fn()} onSelectSession={vi.fn()} onNewSession={vi.fn()}
      onDeleteSession={vi.fn()} onRenameSession={vi.fn()} onArchiveSession={vi.fn()} onUnarchiveSession={vi.fn()} onToggleCollapse={vi.fn()} onOpenSettings={vi.fn()}/></>;
  }
  render(<Shell/>); return io;
}

it('the original avatar is the only account entry and keeps login polling after Escape', async () => {
  vi.useFakeTimers(); const io = fixture(); await act(async () => {});
  const avatar = screen.getByRole('button', { name: '账号与个人资料' }); fireEvent.click(avatar);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '在浏览器中登录' })); });
  expect(screen.getByText('ABCD EF12 3456')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(avatar).toHaveFocus(); expect(screen.queryByRole('dialog')).toBeNull();
  expect(io.relayBrowserCancel).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(io.relayBrowserPoll).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(avatar);
  expect(screen.getByRole('button', { name: '账号中心' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '在浏览器中登录' })).toBeNull();
});

it('keeps native local profile editing behind the account view and returns to account', async () => {
  fixture(true); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '账号与个人资料' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑个人资料' }));
  expect(screen.getByRole('button', { name: '当前头像，点击更换' })).toBeVisible();
  expect(screen.getByRole('button', { name: '昵称' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '返回账号' }));
  expect(screen.getByRole('button', { name: '账号中心' })).toBeVisible();
});

it('an explicit remote-panel request reopens the original avatar popover', async () => {
  fixture(); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '从远程窗口打开账号' }));
  expect(screen.getByRole('dialog', { name: '账号与个人资料' })).toBeVisible();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: '从远程窗口打开账号' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
});

it('a late account refresh does not steal focus from local nickname editing', async () => {
  let resolve!: (status: RelayAccountStatus) => void;
  const read = new Promise<RelayAccountStatus>(done => { resolve = done; });
  fixture(false, false, read); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: '账号与个人资料' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑个人资料' }));
  fireEvent.click(screen.getByRole('button', { name: '昵称' }));
  const input = screen.getByRole('textbox', { name: '昵称' });
  fireEvent.change(input, { target: { value: '正在编辑' } });
  await act(async () => { resolve({ loggedIn: false, username: '', serverUrl: '', online: false }); });
  expect(input).toHaveFocus(); expect(input).toHaveValue('正在编辑');
});

it('warns only for an active remote logout and clears that confirmation on external account changes', async () => {
  const io = fixture(true, true); await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '账号与个人资料' })); });
  fireEvent.click(screen.getByRole('button', { name: '退出账号' }));
  expect(screen.getByRole('heading', { name: '退出 Trylo 账号？' })).toBeVisible();
  expect(io.relayLogout).not.toHaveBeenCalled();
  vi.mocked(io.relayStatus).mockResolvedValue({ loggedIn: false, username: '', serverUrl: '', online: false });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  vi.mocked(io.relayStatus).mockResolvedValue({ loggedIn: true, username: 'ylz', serverUrl: 'https://relay.trylocode.me', online: false });
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(screen.queryByRole('heading', { name: '退出 Trylo 账号？' })).toBeNull();
  expect(screen.getByRole('button', { name: '账号中心' })).toBeVisible();
});

it('a missing clipboard API leaves the browser-login recovery usable', async () => {
  const io = fixture(); await act(async () => {});
  const begin = io.relayBrowserBegin!;
  io.relayBrowserBegin = vi.fn(async params => ({ ...await begin(params), browserOpened: false }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '账号与个人资料' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '在浏览器中登录' })); });
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  try {
    fireEvent.click(screen.getByRole('button', { name: '复制登录链接' }));
    expect(screen.getByText('当前环境无法复制，请重新打开浏览器')).toBeVisible();
    expect(screen.getByRole('button', { name: '重新打开浏览器' })).toBeEnabled();
  } finally { if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else Reflect.deleteProperty(navigator, 'clipboard'); }
});
