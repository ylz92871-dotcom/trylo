import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDesktopAccount } from './use-desktop-account';
import type { DesktopAccountPort } from './desktop-account';
import type { RelayAccountStatus, RelayBrowserLogin, RelayBrowserPoll } from '../services-host/methods';

const signedOut = { loggedIn: false, username: '', serverUrl: '', online: false };
const signedIn = { loggedIn: true, username: 'ylz', serverUrl: 'https://relay.trylocode.me', online: false };
const options = { serverUrl: 'https://relay.trylocode.me' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function port(): DesktopAccountPort {
  return {
    relayStatus: vi.fn(async () => signedOut), relayLogout: vi.fn(async () => signedOut),
    relayBrowserBegin: vi.fn(async () => ({ id: 'attempt', userCode: 'ABCDEF123456', verificationUrl: 'https://trylocode.me/account/#authorize?code=ABCDEF123456', expiresAt: Date.now() + 600000, interval: 5000 })),
    relayBrowserPoll: vi.fn(async () => ({ status: 'pending' as const })), relayBrowserCancel: vi.fn(async () => ({ ok: true })),
    relayBrowserOpen: vi.fn(async () => ({ ok: true })), relayAccountOpen: vi.fn(async () => ({ ok: true })),
  };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function flush() { await act(async () => {}); }

it('restores the native account and refreshes external revocation on window focus', async () => {
  const io = port(); vi.mocked(io.relayStatus).mockResolvedValueOnce(signedIn).mockResolvedValueOnce(signedOut);
  const { result } = renderHook(() => useDesktopAccount(io, options)); await flush();
  expect(result.current.account).toEqual(signedIn);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(result.current.account).toEqual(signedOut);
  expect(io.relayBrowserBegin).not.toHaveBeenCalled();
});

it('keeps one poll schedule through frequent parent rerenders, and accepts only a public account result', async () => {
  vi.useFakeTimers(); const io = port(); vi.mocked(io.relayBrowserPoll!).mockResolvedValue({ status: 'complete', account: signedIn });
  const changed = vi.fn(async () => {});
  const { result, rerender } = renderHook(() => useDesktopAccount(io, { ...options, onSessionChanged: async () => changed() })); await flush();
  await act(async () => { await result.current.start(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); rerender();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(io.relayBrowserPoll).toHaveBeenCalledTimes(1);
  expect(result.current.account).toEqual(signedIn); expect(result.current.login).toBeNull(); expect(changed).toHaveBeenCalledTimes(1);
});

it('a late initial status cannot overwrite a completed browser sign-in', async () => {
  vi.useFakeTimers(); const read = deferred<RelayAccountStatus>(), io = port(); vi.mocked(io.relayStatus).mockReturnValue(read.promise);
  vi.mocked(io.relayBrowserPoll!).mockResolvedValue({ status: 'complete', account: signedIn });
  const { result } = renderHook(() => useDesktopAccount(io, options));
  await act(async () => { await result.current.start(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => { read.resolve(signedOut); });
  expect(result.current.account).toEqual(signedIn);
});

it('cancelling an unresolved begin prevents its late result from restarting the flow', async () => {
  const io = port(), begin = deferred<RelayBrowserLogin>(); vi.mocked(io.relayBrowserBegin!).mockReturnValue(begin.promise);
  const { result } = renderHook(() => useDesktopAccount(io, options)); await flush();
  let starting!: Promise<void>; await act(async () => { starting = result.current.start(); });
  await act(async () => { await result.current.cancel(); });
  await act(async () => { begin.resolve({ id: 'late', userCode: 'ABCDEF123456', verificationUrl: 'fixture', expiresAt: Date.now() + 100000, interval: 5000 }); await starting; });
  expect(result.current.phase).toBe('ready'); expect(result.current.login).toBeNull();
});

it('late poll success after cancel cannot restore an account or invoke session effects', async () => {
  vi.useFakeTimers(); const io = port(), poll = deferred<RelayBrowserPoll>(), changed = vi.fn(async () => {});
  vi.mocked(io.relayBrowserPoll!).mockReturnValue(poll.promise);
  const { result } = renderHook(() => useDesktopAccount(io, { ...options, onSessionChanged: changed })); await flush();
  await act(async () => { await result.current.start(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(io.relayBrowserPoll).toHaveBeenCalledTimes(1);
  await act(async () => { await result.current.cancel(); poll.resolve({ status: 'complete', account: signedIn }); });
  expect(result.current.account?.loggedIn).toBe(false); expect(changed).not.toHaveBeenCalled();
});

it('expires without polling beyond the deadline and can start a fresh attempt', async () => {
  vi.useFakeTimers(); const io = port();
  vi.mocked(io.relayBrowserBegin!).mockResolvedValue({ id: 'short', userCode: 'ABCDEF123456', verificationUrl: 'fixture', expiresAt: Date.now() + 3000, interval: 5000 });
  const { result } = renderHook(() => useDesktopAccount(io, options)); await flush();
  await act(async () => { await result.current.start(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(result.current.phase).toBe('expired'); expect(io.relayBrowserPoll).not.toHaveBeenCalled();
  expect(io.relayBrowserCancel).toHaveBeenCalledTimes(2);
});

it('failed browser opening preserves the pending attempt for a safe reopen', async () => {
  const io = port(), original = io.relayBrowserBegin!;
  io.relayBrowserBegin = vi.fn(async params => ({ ...await original(params), browserOpened: false }));
  const { result } = renderHook(() => useDesktopAccount(io, options)); await flush();
  await act(async () => { await result.current.start(); });
  expect(result.current.login?.id).toBe('attempt'); expect(result.current.error).toContain('浏览器');
  await act(async () => { await result.current.reopen(); });
  expect(io.relayBrowserOpen).toHaveBeenCalledWith({ id: 'attempt' }); expect(result.current.error).toBeNull();
});

it('changing the server invalidates the old browser attempt', async () => {
  const io = port(); const { result, rerender } = renderHook(({ serverUrl }) => useDesktopAccount(io, { serverUrl }), { initialProps: options }); await flush();
  await act(async () => { await result.current.start(); });
  rerender({ serverUrl: 'https://other.example' }); await flush();
  expect(result.current.login).toBeNull(); expect(io.relayBrowserCancel).toHaveBeenCalledTimes(2);
});

it('logout failure keeps the account visible and retry actually repeats logout', async () => {
  const io = port(); vi.mocked(io.relayStatus).mockResolvedValue(signedIn);
  vi.mocked(io.relayLogout).mockRejectedValueOnce(new Error('网络暂时中断')).mockResolvedValueOnce(signedOut);
  const { result } = renderHook(() => useDesktopAccount(io, options)); await flush();
  await act(async () => { await result.current.logout(); });
  expect(result.current.account?.loggedIn).toBe(true); expect(result.current.error).toContain('网络');
  await act(async () => { await result.current.retry(); });
  expect(result.current.account?.loggedIn).toBe(false); expect(io.relayLogout).toHaveBeenCalledTimes(2);
});

it('unmount clears pending polling and cancels the Service Host attempt', async () => {
  vi.useFakeTimers(); const io = port(); const { result, unmount } = renderHook(() => useDesktopAccount(io, options)); await flush();
  await act(async () => { await result.current.start(); }); unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(io.relayBrowserPoll).not.toHaveBeenCalled(); expect(io.relayBrowserCancel).toHaveBeenCalledTimes(2);
});
