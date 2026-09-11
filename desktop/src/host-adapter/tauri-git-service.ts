// Trylo Desktop — concrete GitService impl backed by Tauri IPC (P2-1, §7.3).
//
// This is the ONLY file that maps the Rust `git_snapshot` / `git_file_diff`
// wire shapes into the renderer's `GitService`. React and the result
// projector import the interface / the adapter barrel, never
// `@tauri-apps/api/core`.

import { invoke } from '@tauri-apps/api/core';
import type {
  GitDiffStat,
  GitFileDiff,
  GitService,
  GitWorkspaceSnapshot,
} from './git-service';
import type { FilePath } from './types';

export const tauriGitService: GitService = {
  snapshot: (root: FilePath) =>
    invoke<GitWorkspaceSnapshot>('git_snapshot', { root }),
  // Tauri 2's serde adapter maps snake_case Rust args → camelCase JS
  // args, so `old_path` on the Rust side MUST be sent as `oldPath`
  // from JS. Sending the snake_case variant gets silently dropped at
  // the deserialization layer and the rename source is lost.
  fileDiff: (root: FilePath, path: string, oldPath?: string) =>
    invoke<GitFileDiff>('git_file_diff', { root, path, ...(oldPath ? { oldPath } : {}) }),
  // WP-4: Rust `git_diff_stats` takes `root` + a `paths` array; the array
  // passes through unchanged (no casing mapping needed).
  diffStats: (root: FilePath, paths: readonly string[]) =>
    invoke<GitDiffStat[]>('git_diff_stats', { root, paths }),
};