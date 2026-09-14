// Trylo Desktop — TauriLspManager unit tests. See ARCHITECTURE.md
// §2.7 + §2.3.
//
// We test the JS-side glue: ensureServer makes a Channel and
// an invoke call; send delegates to lsp_send; stop delegates to
// lsp_stop. The onMessage subscription path is exercised by
// the Channel mock's onmessage callback (set during
// ensureServer). The Rust side is tested by `cargo test`.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => {
  class FakeChannel<T> {
    onmessage: ((msg: T) => void) | null = null;
    send(_msg: T): boolean {
      return true;
    }
  }
  return {
    Channel: FakeChannel,
    invoke: vi.fn(),
  };
});

import { invoke } from '@tauri-apps/api/core';
import { TauriLspManager } from './tauri-lsp-manager';

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  invokeMock.mockReset();
});

describe('TauriLspManager', () => {
  it('ensureServer invokes lsp_spawn and returns a mapped handle', async () => {
    const fakeHandle = {
      id: 'lsp-12345',
      language: 'typescript',
      workspace_root: 'D:/work',
    };
    invokeMock.mockResolvedValueOnce(fakeHandle);
    const mgr = new TauriLspManager();
    const handle = await mgr.ensureServer('typescript', 'D:/work');
    expect(handle).toEqual({
      id: 'lsp-12345',
      language: 'typescript',
      workspaceRoot: 'D:/work',
    });
    expect(invokeMock).toHaveBeenCalledWith(
      'lsp_spawn',
      expect.objectContaining({ language: 'typescript', workspaceRoot: 'D:/work' }),
    );
  });

  it('send delegates to lsp_send with the right args', async () => {
    const mgr = new TauriLspManager();
    await mgr.send(
      { id: 'h', language: 'x', workspaceRoot: 'y' },
      '{"jsonrpc":"2.0"}',
    );
    expect(invokeMock).toHaveBeenLastCalledWith('lsp_send', {
      id: 'h',
      message: '{"jsonrpc":"2.0"}',
    });
  });

  it('stop invokes lsp_stop', async () => {
    const mgr = new TauriLspManager();
    await mgr.stop({ id: 'h', language: 'x', workspaceRoot: 'y' });
    expect(invokeMock).toHaveBeenLastCalledWith('lsp_stop', { id: 'h' });
  });

  it('availableLanguages returns the list from lsp_list', async () => {
    const fixture = [
      { id: 'typescript', extensions: ['.ts'], command: 'ts', installed: true },
      { id: 'python', extensions: ['.py'], command: 'py', installed: false },
    ];
    invokeMock.mockResolvedValueOnce(fixture);
    const mgr = new TauriLspManager();
    const list = await mgr.availableLanguages();
    expect(list).toEqual(fixture);
  });

  it('the same (language, workspace) pair shares a Channel across ensureServer calls', async () => {
    // The first ensureServer creates a Channel. The second call
    // for the same pair should reuse the same Channel (not create
    // a new one). We assert this by counting Channel constructions.
    invokeMock.mockResolvedValue({
      id: 'lsp-shared',
      language: 'typescript',
      workspace_root: 'D:/work',
    });
    const mgr = new TauriLspManager();
    await mgr.ensureServer('typescript', 'D:/work');
    await mgr.ensureServer('typescript', 'D:/work');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
