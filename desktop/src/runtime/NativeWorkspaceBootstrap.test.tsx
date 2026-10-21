import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../host-adapter/tauri-detect';
import { NativeWorkspaceBootstrap } from './NativeWorkspaceBootstrap';
import { AppErrorBoundary } from '../components/app-shell/AppErrorBoundary';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../host-adapter/tauri-detect', () => ({ isTauri: vi.fn() }));
beforeEach(() => { vi.mocked(isTauri).mockReturnValue(true); vi.mocked(invoke).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('native startup workspace', () => {
  it('does not mount application runtimes until a real workspace is ready', async () => {
    let resolve!: (root: string) => void;
    vi.mocked(invoke).mockReturnValue(new Promise<string>(done => { resolve = done; }));
    const children = vi.fn((root: string | undefined) => <span>{root}</span>);
    render(<NativeWorkspaceBootstrap>{children}</NativeWorkspaceBootstrap>);
    expect(screen.getByRole('status').textContent).toContain('正在准备');
    expect(children).not.toHaveBeenCalled();
    await act(async () => { resolve('C:/Users/用户/AppData/Trylo/Workspace'); });
    expect(children).toHaveBeenCalledWith('C:/Users/用户/AppData/Trylo/Workspace');
    expect(invoke).toHaveBeenCalledWith('default_workspace_root');
  });

  it.each(['', 'relative/folder'])('refuses invalid native workspace %s', async root => {
    vi.mocked(invoke).mockResolvedValue(root);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const children = vi.fn(() => <span>unexpected</span>);
    render(<AppErrorBoundary><NativeWorkspaceBootstrap>{children}</NativeWorkspaceBootstrap></AppErrorBoundary>);
    await waitFor(() => expect(screen.getByText('页面加载失败')).toBeTruthy());
    expect(children).not.toHaveBeenCalled();
  });

  it('shows existing recovery UI after directory creation fails', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Access denied'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<AppErrorBoundary><NativeWorkspaceBootstrap>{() => <span>unexpected</span>}</NativeWorkspaceBootstrap></AppErrorBoundary>);
    await waitFor(() => expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy());
    expect(screen.queryByText('unexpected')).toBeNull();
  });

  it('keeps browser preview independent of native commands', () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const children=vi.fn(() => <span>preview</span>);
    render(<NativeWorkspaceBootstrap>{children}</NativeWorkspaceBootstrap>);
    expect(children).toHaveBeenCalledWith(undefined);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('bounds a stuck native request and ignores a late response after timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolve!: (root: string) => void;
    vi.mocked(invoke).mockReturnValue(new Promise<string>(done => { resolve=done; }));
    const children=vi.fn(() => <span>unexpected</span>);
    render(<AppErrorBoundary><NativeWorkspaceBootstrap>{children}</NativeWorkspaceBootstrap></AppErrorBoundary>);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByRole('button', { name:'重新加载' })).toBeTruthy();
    await act(async () => { resolve('C:/late/workspace'); });
    expect(children).not.toHaveBeenCalled();
  });
});
