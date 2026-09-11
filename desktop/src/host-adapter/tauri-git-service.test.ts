// Trylo Desktop — GitService test (P2-1, §7.3). Verifies the adapter routes
// to the typed Rust command names with the documented arg shape.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { tauriGitService } from './tauri-git-service';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe('tauriGitService', () => {
  it('snapshot issues the typed git_snapshot command', async () => {
    const snapshot = {
      repository: true,
      head: 'abc1234',
      entries: [
        {
          path: 'src/a.ts',
          indexStatus: 'M',
          worktreeStatus: ' ',
          worktreeOid: 'oid1',
          missing: false,
        },
      ],
      capturedAt: 5,
      truncated: false,
    };
    mockInvoke.mockResolvedValue(snapshot);

    const result = await tauriGitService.snapshot('D:/repo');

    expect(mockInvoke).toHaveBeenCalledWith('git_snapshot', { root: 'D:/repo' });
    expect(result).toEqual(snapshot);
  });

  it('fileDiff issues the typed git_file_diff command', async () => {
    mockInvoke.mockResolvedValue({
      path: 'src/a.ts',
      original: 'a',
      modified: 'b',
      binary: false,
      truncated: false,
    });

    const result = await tauriGitService.fileDiff('D:/repo', 'src/a.ts');

    expect(mockInvoke).toHaveBeenCalledWith('git_file_diff', {
      root: 'D:/repo',
      path: 'src/a.ts',
    });
    expect(result.modified).toBe('b');
  });

  it('fileDiff forwards the rename oldPath as camelCase (P2-1 A-Edge, P1-3)', async () => {
    mockInvoke.mockResolvedValue({
      path: 'src/b.ts',
      original: 'old',
      modified: 'new',
      binary: false,
      truncated: false,
    });
    await tauriGitService.fileDiff('D:/repo', 'src/b.ts', 'src/a.ts');
    // Tauri 2's snake_case → camelCase adapter expects the JS arg
    // to be `oldPath` (camelCase). Sending `old_path` is silently
    // dropped at the deserialization layer and the rename source
    // is lost on real IPC.
    expect(mockInvoke).toHaveBeenCalledWith('git_file_diff', {
      root: 'D:/repo',
      path: 'src/b.ts',
      oldPath: 'src/a.ts',
    });
  });

  it('fileDiff omits oldPath when not renaming (P2-1 A-Edge, P1-3)', async () => {
    mockInvoke.mockResolvedValue({
      path: 'src/a.ts',
      original: 'old',
      modified: 'new',
      binary: false,
      truncated: false,
    });
    await tauriGitService.fileDiff('D:/repo', 'src/a.ts');
    expect(mockInvoke).toHaveBeenCalledWith('git_file_diff', {
      root: 'D:/repo',
      path: 'src/a.ts',
    });
    // Sanity: no `oldPath` (and definitely no `old_path`) on the
    // ordinary diff path.
    const call = mockInvoke.mock.calls[0]!;
    const args = call[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('oldPath');
    expect(args).not.toHaveProperty('old_path');
  });

  it('passes binary / truncated degradation through without parsing', async () => {
    mockInvoke.mockResolvedValue({
      path: 'blob.bin',
      original: '',
      modified: '',
      binary: true,
      truncated: true,
    });
    const result = await tauriGitService.fileDiff('D:/repo', 'blob.bin');
    expect(result.binary).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('diffStats issues the typed git_diff_stats command with the path array (WP-4)', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'src/a.ts', additions: 12, deletions: 3, binary: false },
      { path: 'img.bin', binary: true },
    ]);
    const result = await tauriGitService.diffStats('D:/repo', ['src/a.ts', 'img.bin']);
    expect(mockInvoke).toHaveBeenCalledWith('git_diff_stats', {
      root: 'D:/repo',
      paths: ['src/a.ts', 'img.bin'],
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.additions).toBe(12);
  });
});