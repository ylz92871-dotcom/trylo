// Trylo Desktop — root-bound host adapter tests
// (M3 closure spec §9.3, fixing M3-P1-11).
//
// The adapter must refuse untrusted targets BEFORE any IPC
// round trip, forward the allowed root with every file
// request (the Rust side re-validates), and report every
// denial to the onActionError hook.

import { describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports, so the mock fn must be
// hoisted too (plain top-level consts hit a TDZ here).
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { createTryloHostAdapter } from './tryloHostAdapter';

const ROOT = 'C:/work/demo-ws';

describe('createTryloHostAdapter (§9.3)', () => {
  it('forwards contained targets with the allowed root', async () => {
    const adapter = createTryloHostAdapter(ROOT);
    await adapter.openFile('C:/work/demo-ws/.trylo/out/a.md');
    expect(invokeMock).toHaveBeenCalledWith('work_host_open_file', {
      filePath: 'C:/work/demo-ws/.trylo/out/a.md',
      allowedRoot: ROOT,
    });
  });

  it('denies targets outside the root BEFORE any invoke', async () => {
    invokeMock.mockClear();
    const onActionError = vi.fn();
    const adapter = createTryloHostAdapter(ROOT, onActionError);
    await expect(adapter.openFile('C:/windows/system32/cmd.exe')).rejects.toThrow(
      /不在当前项目根目录内/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(onActionError).toHaveBeenCalledWith(
      expect.stringContaining('不在当前项目根目录内'),
      'C:/windows/system32/cmd.exe',
    );
  });

  it('denies .. traversal before any invoke', async () => {
    invokeMock.mockClear();
    const adapter = createTryloHostAdapter(ROOT);
    await expect(
      adapter.showInFolder('C:/work/demo-ws/../../secrets/key.pem'),
    ).rejects.toThrow(/越级段/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('lets http(s) URLs skip the file gate and reach the host', async () => {
    invokeMock.mockClear();
    const adapter = createTryloHostAdapter(ROOT);
    await adapter.openFile('https://example.com/report');
    expect(invokeMock).toHaveBeenCalledWith('work_host_open_file', {
      filePath: 'https://example.com/report',
      allowedRoot: ROOT,
    });
  });

  it('gates openFileWithApp the same way and forwards the app fields', async () => {
    invokeMock.mockClear();
    const adapter = createTryloHostAdapter(ROOT);
    await adapter.openFileWithApp('C:/work/demo-ws/.trylo/out/a.docx', {
      name: 'Microsoft Word',
      identifier: 'winword',
    });
    expect(invokeMock).toHaveBeenCalledWith('work_host_open_file_with_app', {
      filePath: 'C:/work/demo-ws/.trylo/out/a.docx',
      appIdentifier: 'winword',
      appName: 'Microsoft Word',
      allowedRoot: ROOT,
    });
    invokeMock.mockClear();
    await expect(
      adapter.openFileWithApp('D:/elsewhere/a.docx', {
        name: 'Microsoft Word',
        identifier: 'winword',
      }),
    ).rejects.toThrow(/不在当前项目根目录内/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('surfaces host-side failures through onActionError', async () => {
    invokeMock.mockClear();
    invokeMock.mockRejectedValueOnce(new Error('目标不存在或不可访问'));
    const onActionError = vi.fn();
    const adapter = createTryloHostAdapter(ROOT, onActionError);
    await expect(adapter.openFile('C:/work/demo-ws/.trylo/out/gone.md')).rejects.toThrow(
      /目标不存在或不可访问/,
    );
    expect(onActionError).toHaveBeenCalledWith(
      '目标不存在或不可访问',
      'C:/work/demo-ws/.trylo/out/gone.md',
    );
  });
});
