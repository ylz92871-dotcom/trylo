import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneClient } from '@trylo/work';
import {
  isMissingControlPlaneWorkspaceError,
  resolveControlPlaneWorkspace,
} from './control-plane-workspace';

function clientWith(send: ControlPlaneClient['send']): ControlPlaneClient {
  return {
    status: () => 'connected',
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(() => vi.fn()),
    whenReady: vi.fn(async () => {}),
    send,
  };
}

describe('resolveControlPlaneWorkspace', () => {
  it('reuses a daemon workspace registered for the same Windows path', async () => {
    const send = vi.fn(async () => ({
      workspaces: [{ id: 'existing', path: 'c:/work/demo-ws/' }],
    })) as unknown as ControlPlaneClient['send'];

    await expect(resolveControlPlaneWorkspace(clientWith(send), 'C:\\work\\demo-ws', 'trylo'))
      .resolves.toBe('existing');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('workspace.list');
  });

  it('creates a workspace only when the path is not registered', async () => {
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ workspaces: [] })
      .mockResolvedValueOnce({ workspace: { id: 'created', path: 'C:/work/new' } });
    const send = sendMock as unknown as ControlPlaneClient['send'];

    await expect(resolveControlPlaneWorkspace(clientWith(send), 'C:/work/new', 'new'))
      .resolves.toBe('created');
    expect(sendMock).toHaveBeenNthCalledWith(2, 'workspace.create', {
      name: 'new',
      path: 'C:/work/new',
    });
  });

  it('recovers when another renderer creates the same workspace first', async () => {
    const sendMock = vi.fn()
      .mockResolvedValueOnce({ workspaces: [] })
      .mockRejectedValueOnce(new Error(
        '[ControlPlane] workspace.create failed: A workspace with path "C:/work/demo-ws" already exists (INVALID_PARAMS)',
      ))
      .mockResolvedValueOnce({ workspaces: [{ id: 'raced', path: 'C:/work/demo-ws' }] });
    const send = sendMock as unknown as ControlPlaneClient['send'];

    await expect(resolveControlPlaneWorkspace(clientWith(send), 'C:/work/demo-ws', 'trylo'))
      .resolves.toBe('raced');
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});

describe('isMissingControlPlaneWorkspaceError', () => {
  it('only matches a stale workspace id reported by task.create', () => {
    expect(isMissingControlPlaneWorkspaceError(new Error(
      '[ControlPlane] task.create failed: Workspace not found: old-id (INVALID_PARAMS)',
    ))).toBe(true);
    expect(isMissingControlPlaneWorkspaceError(new Error('task failed'))).toBe(false);
  });
});
