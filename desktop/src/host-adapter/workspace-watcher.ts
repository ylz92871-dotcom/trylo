// Trylo Desktop — WorkspaceWatcher interface. See ARCHITECTURE.md §2.6.
//
// We do NOT hardcode chokidar or notify — the interface is the contract.
// Today's implementation: ChokidarWorkspaceWatcher (in chokidar-watcher.ts).
// Tomorrow's implementation: RustNotifyWorkspaceWatcher (Phase 4 swap, see
// ARCHITECTURE.md §4.5 — the swap is a one-file change because the
// business logic only depends on this interface).

import type { FileChangeEvent, FilePath } from './types';

export interface WatchOptions {
  /** Files/dirs to ignore. Default: node_modules, .git, dist, target, .next, .trylo. */
  readonly ignore?: readonly string[];
  /** Debounce identical events arriving within this window. Default 50ms. */
  readonly debounceMs?: number;
  /** Recursive watch. Default true. */
  readonly recursive?: boolean;
}

export interface WatchHandle {
  /** Stop watching this specific root; releases native resources. */
  close(): Promise<void>;
  /**
   * Subscribe to a single file's change events. Returns an unsubscribe
   * function. Multiple subscribers per handle are allowed.
   */
  onDidChangeFile(path: FilePath, cb: (events: readonly FileChangeEvent[]) => void): () => void;
}

export interface WorkspaceWatcher {
  /** Begin watching a directory tree. */
  watch(root: FilePath, options?: WatchOptions): WatchHandle;
  /** Stop watching; the watcher's native resources are released. */
  close(): Promise<void>;
}
