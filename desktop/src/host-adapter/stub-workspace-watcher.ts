// Trylo Desktop — StubWorkspaceWatcher. See the architecture doc §2.6
// (WorkspaceWatcher is an interface) + §3 Phase 0 Day 4 (GO f: two
// impls).
//
// In-memory WorkspaceWatcher. No real file watching. Useful for
// unit tests and for the spike's manual-trigger path. Production
// traffic goes through TauriChannelWorkspaceWatcher.
//
// The stub also exposes `triggerEvent` so tests / a dev-only UI
// button can push events through the same dispatch path the real
// watcher uses, proving the interface wiring end-to-end without
// touching the filesystem.

import type {
  WatchHandle,
  WatchOptions,
  WorkspaceWatcher,
} from './workspace-watcher';
import type { FileChangeEvent, FilePath } from './types';

interface StubHandleState {
  readonly subscribers: Map<FilePath, Set<(events: readonly FileChangeEvent[]) => void>>;
}

interface StubHandle extends WatchHandle {
  /** Manually push an event through this handle's subscribers. */
  triggerEvent(event: FileChangeEvent): void;
}

function makeStubHandle(state: StubHandleState): StubHandle {
  return {
    close: async () => {
      state.subscribers.clear();
    },
    onDidChangeFile: (path, cb) => {
      let cbs = state.subscribers.get(path);
      if (cbs === undefined) {
        cbs = new Set();
        state.subscribers.set(path, cbs);
      }
      cbs.add(cb);
      return () => {
        cbs!.delete(cb);
      };
    },
    triggerEvent: (event) => {
      for (const cbs of state.subscribers.values()) {
        for (const cb of cbs) {
          cb([event]);
        }
      }
    },
  };
}

export class StubWorkspaceWatcher implements WorkspaceWatcher {
  private readonly handles = new Map<FilePath, StubHandleState>();

  watch(_root: FilePath, _options?: WatchOptions): WatchHandle {
    let state = this.handles.get(_root);
    if (state === undefined) {
      state = { subscribers: new Map() };
      this.handles.set(_root, state);
    }
    return makeStubHandle(state);
  }

  async close(): Promise<void> {
    this.handles.clear();
  }

  /**
   * Push an event into every active stub handle. Test-only /
   * dev-only API. Returns the number of handles that received it.
   */
  triggerEvent(event: FileChangeEvent): number {
    let n = 0;
    for (const state of this.handles.values()) {
      for (const cbs of state.subscribers.values()) {
        for (const cb of cbs) {
          cb([event]);
        }
      }
      n += 1;
    }
    return n;
  }
}
