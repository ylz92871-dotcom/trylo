// Trylo Desktop — ProjectState unit tests. See ARCHITECTURE.md
// §2.3 + §3 Phase 2 task #2.5+#2.6 (round-trip proof).
//
// The round-trip invariant: a file change on disk (caused by
// any actor — the user, the agent, an external editor) must
// reach every subscriber. We don't test the file *read* path
// here (that's the bridge); we test the *event delivery* path
// from the watcher through the bus to the subscribers.

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  FileChangeEvent,
  FilePath,
  WatchHandle,
  WorkspaceWatcher,
} from '../host-adapter';
import { useProjectState } from './use-project-state';

function makeFakeWatcher(): {
  watcher: WorkspaceWatcher;
  emit: (events: readonly FileChangeEvent[]) => void;
  watched: { root: FilePath; cb: (events: readonly FileChangeEvent[]) => void }[];
} {
  const watched: { root: FilePath; cb: (events: readonly FileChangeEvent[]) => void }[] = [];
  const handle: WatchHandle = {
    close: async () => undefined,
    onDidChangeFile: (root, cb) => {
      watched.push({ root, cb });
      return () => {
        const idx = watched.findIndex((w) => w.root === root && w.cb === cb);
        if (idx >= 0) watched.splice(idx, 1);
      };
    },
  };
  const watcher: WorkspaceWatcher = {
    watch: (_root: FilePath) => handle,
    close: async () => undefined,
  };
  return { watcher, watched, emit: (events) => watched.forEach((w) => w.cb(events)) };
}

describe('useProjectState', () => {
  it('subscribers receive the bus events from the watcher', () => {
    const { watcher, emit } = makeFakeWatcher();
    const { result } = renderHook(() =>
      useProjectState({ watcher, workspaceRoot: 'D:/x' as FilePath }),
    );
    const received: FileChangeEvent[][] = [];
    const unsub = result.current.subscribe((events) => received.push([...events]));
    const evts: FileChangeEvent[] = [
      { kind: 'modified', path: 'D:/x/foo.txt' as FilePath },
      { kind: 'created', path: 'D:/x/bar.txt' as FilePath },
    ];
    emit(evts);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(evts);
    unsub();
    // After unsubscribe, no more events.
    emit([{ kind: 'deleted', path: 'D:/x/baz.txt' as FilePath }]);
    expect(received).toHaveLength(1);
  });

  it('does not start a watcher when watch=false', () => {
    const { watcher, watched } = makeFakeWatcher();
    renderHook(() =>
      useProjectState({
        watcher,
        workspaceRoot: 'D:/x' as FilePath,
        watch: false,
      }),
    );
    expect(watched).toHaveLength(0);
  });

  it('closes the handle on unmount', async () => {
    const closeSpy = vi.fn(async () => undefined);
    const handle: WatchHandle = {
      close: closeSpy,
      onDidChangeFile: () => () => undefined,
    };
    const watcher: WorkspaceWatcher = {
      watch: () => handle,
      close: async () => undefined,
    };
    const { unmount } = renderHook(() =>
      useProjectState({ watcher, workspaceRoot: 'D:/x' as FilePath }),
    );
    unmount();
    // Effect cleanup is synchronous on close; allow microtask.
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalled();
  });
});
