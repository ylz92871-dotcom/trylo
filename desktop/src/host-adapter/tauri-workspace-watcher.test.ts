import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage?: (event: object) => void }[] }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  Channel: class { constructor() { mocks.channels.push(this); } onmessage?: (event: object) => void; },
}));
import { TauriChannelWorkspaceWatcher } from './tauri-workspace-watcher';
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(undefined); mocks.channels.length = 0; });

describe('workspace watcher ownership', () => {
  it('serializes global teardown before watching the same root again', async () => {
    let release!: () => void;
    mocks.invoke.mockImplementation(async (method: string) => { if (method === 'unwatch') await new Promise<void>((resolve) => { release = resolve; }); });
    const watcher = new TauriChannelWorkspaceWatcher();
    const old = watcher.watch('D:/alpha'); await old.ready;
    const closing = watcher.close(); const replacement = watcher.watch('D:/alpha');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(mocks.invoke.mock.calls.map(([method]) => method)).toEqual(['watch', 'unwatch']);
    release(); await closing; await replacement.ready;
    expect(mocks.invoke.mock.calls.map(([method]) => method)).toEqual(['watch', 'unwatch', 'watch']);
    mocks.invoke.mockResolvedValue(undefined); await replacement.close();
  });
  it('keeps roots and per-handle subscribers independent', async () => {
    const watcher = new TauriChannelWorkspaceWatcher();
    const a = watcher.watch('D:/alpha');
    const sibling = watcher.watch('d:\\ALPHA\\');
    const b = watcher.watch('D:/beta');
    const aChanged = vi.fn(), siblingChanged = vi.fn(), bChanged = vi.fn();
    a.onDidChangeFile('D:/alpha', aChanged);
    sibling.onDidChangeFile('D:/alpha/report.pdf', siblingChanged);
    b.onDidChangeFile('D:/beta', bChanged);
    await Promise.all([a.ready, b.ready]);
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'watch')).toHaveLength(2);
    mocks.channels[0]?.onmessage?.({ kind: 'modified', path: 'D:/alpha/report.pdf' });
    expect(aChanged).toHaveBeenCalledTimes(1); expect(siblingChanged).toHaveBeenCalledTimes(1); expect(bChanged).not.toHaveBeenCalled();
    await a.close();
    mocks.channels[0]?.onmessage?.({ kind: 'modified', path: 'D:/alpha/report.pdf' });
    expect(aChanged).toHaveBeenCalledTimes(1); expect(siblingChanged).toHaveBeenCalledTimes(2);
    mocks.channels[0]?.onmessage?.({ kind: 'modified', path: 'D:/alpha/report.pdf-other' });
    expect(siblingChanged).toHaveBeenCalledTimes(2);
    await sibling.close(); await b.close();
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'unwatch')).toHaveLength(2);
  });
  it('does not let a pending unwatch destroy a replacement handle', async () => {
    let release!: () => void;
    mocks.invoke.mockImplementation(async (method: string) => { if (method === 'unwatch') await new Promise<void>((resolve) => { release = resolve; }); });
    const watcher = new TauriChannelWorkspaceWatcher();
    const old = watcher.watch('D:/alpha'); await old.ready;
    const closing = old.close();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const replacement = watcher.watch('D:/alpha');
    const callback = vi.fn(); replacement.onDidChangeFile('D:/alpha', callback);
    release(); await closing; await replacement.ready;
    expect(mocks.invoke.mock.calls.map(([method]) => method)).toEqual(['watch', 'unwatch', 'watch']);
    mocks.channels[0]?.onmessage?.({ kind: 'created', path: 'D:/alpha/new.pdf' });
    expect(callback).toHaveBeenCalledTimes(1);
    mocks.invoke.mockResolvedValue(undefined); await replacement.close();
  });
});
