// Trylo Desktop — attachLsp tests. See the architecture doc §2.7.

import { describe, expect, it, vi } from 'vitest';
import {
  attachLspToFile,
  languageIdForPath,
} from './attachLsp';
import type { FilePath, LspManager } from '../../host-adapter';

describe('languageIdForPath', () => {
  it('maps common extensions to language ids', () => {
    expect(languageIdForPath('/x/y/foo.ts')).toBe('typescript');
    expect(languageIdForPath('/x/y/foo.tsx')).toBe('typescript');
    expect(languageIdForPath('/x/y/foo.js')).toBe('javascript');
    expect(languageIdForPath('/x/y/foo.py')).toBe('python');
    expect(languageIdForPath('/x/y/foo.rs')).toBe('rust');
    expect(languageIdForPath('/x/y/foo.go')).toBe('go');
    expect(languageIdForPath('/x/y/foo.cpp')).toBe('cpp');
    expect(languageIdForPath('/x/y/foo.c')).toBe('cpp');
  });

  it('is case-insensitive', () => {
    expect(languageIdForPath('/x/y/FOO.TS')).toBe('typescript');
    expect(languageIdForPath('/x/y/Bar.PY')).toBe('python');
  });

  it('returns null for unknown extensions', () => {
    expect(languageIdForPath('/x/y/foo.xyz')).toBeNull();
    expect(languageIdForPath('/x/y/foo')).toBeNull();
    expect(languageIdForPath('/x/y/.md')).toBeNull();
  });
});

describe('attachLspToFile', () => {
  function makeDeps() {
    const ensureServer = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn();
    const lspManager: LspManager = {
      ensureServer,
      send,
      stop,
      onMessage,
      availableLanguages: vi.fn().mockResolvedValue([]),
    };
    return { lspManager, ensureServer, send, stop, onMessage };
  }

  it('returns null for a file with no registered language', async () => {
    const deps = makeDeps();
    const result = await attachLspToFile(
      '/x/y/foo.txt' as FilePath,
      deps.lspManager,
    );
    expect(result).toBeNull();
    expect(deps.ensureServer).not.toHaveBeenCalled();
  });

  it('starts the server and returns a disposable for a registered language', async () => {
    const deps = makeDeps();
    deps.ensureServer.mockResolvedValue({
      id: 'lsp-99',
      language: 'typescript',
      workspaceRoot: '',
    });
    const result = await attachLspToFile(
      '/x/y/foo.ts' as FilePath,
      deps.lspManager,
    );
    expect(result).not.toBeNull();
    expect(result?.languageId).toBe('typescript');
    expect(result?.handleId).toBe('lsp-99');
    expect(deps.ensureServer).toHaveBeenCalledWith('typescript', '');
    // dispose calls stop.
    await result!.dispose();
    expect(deps.stop).toHaveBeenCalledWith({
      id: 'lsp-99',
      language: 'typescript',
      workspaceRoot: '',
    });
  });

  it('dispose is idempotent', async () => {
    const deps = makeDeps();
    deps.ensureServer.mockResolvedValue({
      id: 'lsp-77',
      language: 'python',
      workspaceRoot: '',
    });
    const result = await attachLspToFile(
      '/x/y/foo.py' as FilePath,
      deps.lspManager,
    );
    await result!.dispose();
    await result!.dispose();
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });
});
