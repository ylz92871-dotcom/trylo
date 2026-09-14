// Trylo Desktop — TauriChannelWorkspaceWatcher. See ARCHITECTURE.md
// §2.6 (WorkspaceWatcher is an interface).
//
// Production impl for the spike / Phase 1. The actual OS-level
// watching happens in Rust (`notify` crate, see
// src-tauri/src/commands/watch.rs); this TS class wraps the Tauri
// Channel that streams events back and exposes them via the
// WorkspaceWatcher interface.
//
// Day 5 fix: the Channel and the per-path subscribers map live on
// the instance, not inside watch(). The previous design created the
// channel inside the first watch() call and stored it in a per-root
// `this.handles` map; when App.tsx's useEffect re-ran (because
// `dirty` is a dep), it called `handle.close()` which deleted the
// handle from the map. The second watch() then saw an empty map and
// created a fresh state + channel; the Rust `watch` command is
// idempotent and kept the original Channel registered for events.
// Result: events fired into a Channel whose onmessage closure
// referenced a stale, empty subscribers map.
//
// Now: the Channel is created on the first watch() call, then
// cached on the instance. Subsequent watch() calls return a fresh
// WatchHandle that operates on the same channel and the same
// subscribers map.
//
// Phase 1.0: per-handle refcount. The first `watch()` increments
// the count, opens the Channel, and starts the Rust notify
// watcher. Each `close()` decrements; when the count hits zero,
// we `invoke('unwatch', { root })` to release the OS-level
// notify handle. A subsequent `watch()` re-opens it via Rust's
// `watch` command (which is idempotent at the JS level: it
// returns "already watching" if the map still has the entry
// — but we cleared it on close, so the second `watch` actually
// starts a fresh notify watcher).

import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  WatchHandle,
  WatchOptions,
  WorkspaceWatcher,
} from './workspace-watcher';
import type { FileChangeEvent, FilePath } from './types';

interface TauriEventDto {
  kind: string;
  path: string;
  old_path?: string;
}

function fromDto(dto: TauriEventDto): FileChangeEvent {
  return {
    kind: dto.kind as FileChangeEvent['kind'],
    path: dto.path,
    ...(dto.old_path !== undefined ? { oldPath: dto.old_path } : {}),
  };
}

type Subscriber = (events: readonly FileChangeEvent[]) => void;

export class TauriChannelWorkspaceWatcher implements WorkspaceWatcher {
  private channel: Channel<TauriEventDto> | null = null;
  private watchedRoot: FilePath | null = null;
  /** Active handle count. When 0, we `unwatch` on the Rust side
   *  to release the OS handle. Re-incrementing triggers a fresh
   *  `watch`. */
  private handleCount = 0;
  private readonly subscribers = new Map<FilePath, Set<Subscriber>>();

  private ensureChannel(root: FilePath): Channel<TauriEventDto> {
    if (this.channel === null) {
      this.channel = new Channel<TauriEventDto>();
      this.watchedRoot = root;
      this.channel.onmessage = (dto) => {
        const event = fromDto(dto);
        for (const cbs of this.subscribers.values()) {
          for (const cb of cbs) {
            cb([event]);
          }
        }
      };
      void invoke('watch', { root, onEvent: this.channel });
    }
    return this.channel;
  }

  watch(root: FilePath, _options?: WatchOptions): WatchHandle {
    this.ensureChannel(root);
    this.handleCount += 1;
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        // Phase 1.0: clear per-handle subscribers. The shared
        // subscribers map and the Channel live across handles.
        this.subscribers.clear();
        this.handleCount -= 1;
        if (this.handleCount <= 0 && this.watchedRoot !== null) {
          // Last handle closed. Tell Rust to release the
          // OS-level notify handle. We also drop the JS-side
          // channel + state so a subsequent watch() starts
          // fresh.
          const root = this.watchedRoot;
          this.watchedRoot = null;
          this.channel = null;
          try {
            await invoke('unwatch', { root });
          } catch {
            // Best-effort. If unwatch fails (e.g. Rust side
            // already gone), the OS handle will be released
            // on app shutdown anyway.
          }
        }
      },
      onDidChangeFile: (path, cb) => {
        let cbs = this.subscribers.get(path);
        if (cbs === undefined) {
          cbs = new Set();
          this.subscribers.set(path, cbs);
        }
        cbs.add(cb);
        return () => {
          cbs!.delete(cb);
          if (cbs!.size === 0) this.subscribers.delete(path);
        };
      },
    };
  }

  async close(): Promise<void> {
    // Force-release everything.
    this.subscribers.clear();
    this.handleCount = 0;
    if (this.watchedRoot !== null) {
      const root = this.watchedRoot;
      this.watchedRoot = null;
      this.channel = null;
      try {
        await invoke('unwatch', { root });
      } catch {
        // Best-effort.
      }
    }
  }
}
