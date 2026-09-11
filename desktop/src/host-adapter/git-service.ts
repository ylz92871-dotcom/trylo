// Trylo Desktop — GitService (P2-1, spec §7.3).
//
// The typed, actually-backed git surface that replaces the narrow and
// misleading `ChangesService.status` and the un-wired `GitCommands`. The
// Code result projector is the only consumer at start/final snapshot time;
// ResultDock / CodeResultContent re-open the current workspace state on
// demand. React components call `hostAdapter.git.*`, never `invoke()`.

import type { FilePath } from './types';

export interface GitSnapshotEntry {
  /** Git repo-relative path, always `/`-separated. */
  readonly path: string;
  /** Original path for rename / copy. */
  readonly oldPath?: string;
  /** Git porcelain X (index / staged) status character. */
  readonly indexStatus: string;
  /** Git porcelain Y (worktree / unstaged) status character. */
  readonly worktreeStatus: string;
  /** Content blob OID of the current worktree file (signature). */
  readonly worktreeOid?: string;
  /** Index OID (signature), absent for untracked / deleted. */
  readonly indexOid?: string;
  /** True when the path is deleted (content no longer present). */
  readonly missing: boolean;
}

export interface GitWorkspaceSnapshot {
  readonly repository: boolean;
  readonly head?: string;
  readonly entries: readonly GitSnapshotEntry[];
  readonly capturedAt: number;
  readonly truncated: boolean;
  /** C-Core (audit P1-5): true when the whole-operation budget was
   *  exhausted — the snapshot is explicitly PARTIAL and any absent OID
   *  past the deadline must not be read as "unchanged". */
  readonly timedOut?: boolean;
  readonly warning?: string;
}

export interface GitFileDiff {
  readonly path: string;
  readonly oldPath?: string;
  readonly original: string;
  readonly modified: string;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly languageHint?: string;
}

/** WP-4: per-file line stats for a HEAD -> worktree diff. Either `binary` is
 *  true, or `additions`/`deletions` carry the real counts. Both may be
 *  absent on a per-path failure — the caller shows `—`, never a fake +0 −0. */
export interface GitDiffStat {
  readonly path: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary: boolean;
}

export interface GitService {
  /** Capture the current workspace Git state (fingerprinted dirty paths). */
  snapshot(root: FilePath): Promise<GitWorkspaceSnapshot>;
  /** HEAD -> current worktree content for one repo-relative path, with
   *  binary / oversized degradation. For a rename, `oldPath` is the rename
   *  SOURCE — the left side reads the old path's HEAD blob while `path`'s
   *  disk content is the right side. */
  fileDiff(root: FilePath, path: string, oldPath?: string): Promise<GitFileDiff>;
  /** WP-4: batched HEAD -> worktree line stats for a bounded set of
   *  repo-relative changed paths. Per-path failures return an "unknown"
   *  entry, never failing the whole call. */
  diffStats(root: FilePath, paths: readonly string[]): Promise<readonly GitDiffStat[]>;
}