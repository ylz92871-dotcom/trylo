// Trylo Desktop — ProjectState module. See the architecture doc §2.3
// + §3 Phase 2 task #2.5+#2.6.
//
// Project State is the source of truth. The agent does not own
// Monaco, Monaco does not own the agent. Both read from and
// write to the filesystem through a unified Workspace model.
// The IDE auto-detects external changes through a
// WorkspaceWatcher.
//
// This module is the React side of that contract. The shape is
// intentionally narrow: it owns the active workspace root, the
// set of watched paths, and a pub/sub channel for change events.
// Consumers (useEditorBridges, useSettings, ...) subscribe to
// the events and re-read from disk on demand.
//
// The `project-state.ts` types-only file holds the canonical
// shapes (Workspace, ChangeSet, ...). This file wires them
// together with a React hook + a Channel for changes.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileChangeEvent,
  FilePath,
  WatchHandle,
  WorkspaceWatcher,
} from '../host-adapter';

// ── Pub/Sub ───────────────────────────────────────────────────────────────

export type ProjectStateListener = (events: readonly FileChangeEvent[]) => void;

class ProjectStateBus {
  private readonly listeners = new Set<ProjectStateListener>();
  subscribe(fn: ProjectStateListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(events: readonly FileChangeEvent[]): void {
    for (const l of this.listeners) l(events);
  }
  size(): number {
    return this.listeners.size;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────

export interface UseProjectStateOptions {
  /** The watcher implementation. Production: hostAdapter.watcher. */
  readonly watcher: WorkspaceWatcher;
  /** Initial workspace root. */
  readonly workspaceRoot: FilePath;
  /**
   * Whether to actually start the watcher. False in tests to avoid
   * Tauri dependency. The default `true` matches production.
   */
  readonly watch?: boolean;
}

export interface UseProjectStateResult {
  /** The bus consumers subscribe to. */
  readonly subscribe: (fn: ProjectStateListener) => () => void;
  /** The current workspace root (the user may switch later). */
  readonly workspaceRoot: FilePath;
  /** For testing. */
  readonly _bus: ProjectStateBus;
}

/**
 * Initialize Project State. Starts a single watcher on the
 * workspace root, routes events to the bus, and returns the
 * subscribe function. Components that need to react to file
 * changes (e.g. the editor bridges) call `subscribe` and
 * re-read from disk on every batch.
 */
export function useProjectState(opts: UseProjectStateOptions): UseProjectStateResult {
  const bus = useMemo(() => new ProjectStateBus(), []);
  const handleRef = useRef<WatchHandle | null>(null);
  const [workspaceRoot] = useState<FilePath>(opts.workspaceRoot);

  useEffect(() => {
    if (opts.watch === false) return undefined;
    const handle = opts.watcher.watch(workspaceRoot);
    handleRef.current = handle;
    const unsub = handle.onDidChangeFile(workspaceRoot, (events) => {
      bus.emit(events);
    });
    return () => {
      unsub();
      void handle.close();
      handleRef.current = null;
    };
  }, [opts.watcher, opts.watch, workspaceRoot, bus]);

  const subscribe = useMemo(
    () => (fn: ProjectStateListener) => bus.subscribe(fn),
    [bus],
  );

  return { subscribe, workspaceRoot, _bus: bus };
}
