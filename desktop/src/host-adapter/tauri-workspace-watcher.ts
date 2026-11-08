import { Channel, invoke } from '@tauri-apps/api/core';
import type { WatchHandle, WatchOptions, WorkspaceWatcher } from './workspace-watcher';
import type { FileChangeEvent, FilePath } from './types';

interface TauriEventDto { kind: FileChangeEvent['kind']; path: string; old_path?: string }
type Subscriber = { path: string; callback: (events: readonly FileChangeEvent[]) => void };
interface HandleState { subscribers: Set<Subscriber> }
interface RootState { root: string; channel: Channel<TauriEventDto>; handles: Set<HandleState>; ready: Promise<void> }
const normalized = (value: string): string => {
  const path = value.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '');
  return /^[a-z]:/i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
};
const contains = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

/** One native channel per root; closing a subscriber cannot erase another
 * window/run's listeners. Root teardown is serialized with a rapid re-watch. */
export class TauriChannelWorkspaceWatcher implements WorkspaceWatcher {
  private readonly roots = new Map<string, RootState>();
  private closing: Promise<void> = Promise.resolve();
  watch(root: FilePath, _options?: WatchOptions): WatchHandle {
    const key = normalized(root);
    let state = this.roots.get(key);
    if (!state) {
      const channel = new Channel<TauriEventDto>();
      state = { root, channel, handles: new Set(), ready: this.closing.then(() => invoke<void>('watch', { root, onEvent: channel })) };
      const owner = state;
      channel.onmessage = (dto) => {
        const event: FileChangeEvent = { kind: dto.kind, path: dto.path, ...(dto.old_path ? { oldPath: dto.old_path } : {}) };
        for (const handle of owner.handles) for (const subscriber of handle.subscribers) {
          if (event.kind === 'rescan' || contains(subscriber.path, normalized(event.path)) || (event.oldPath && contains(subscriber.path, normalized(event.oldPath)))) {
            try { subscriber.callback([event]); } catch { /* One consumer cannot break the remaining subscribers. */ }
          }
        }
      };
      // Older callers do not await readiness. Keep their errors observed while
      // exposing the rejection to callers that need an established baseline.
      void state.ready.catch(() => {});
      this.roots.set(key, state);
    }
    const owner = state;
    const handle: HandleState = { subscribers: new Set() };
    owner.handles.add(handle);
    let closed = false;
    return {
      ready: owner.ready,
      onDidChangeFile: (path, callback) => {
        if (closed) return () => {};
        const subscriber = { path: normalized(path), callback };
        handle.subscribers.add(subscriber);
        return () => { handle.subscribers.delete(subscriber); };
      },
      close: () => {
        if (closed) return Promise.resolve();
        closed = true; handle.subscribers.clear(); owner.handles.delete(handle);
        if (owner.handles.size) return Promise.resolve();
        owner.ready = owner.ready.catch(() => {}).then(async () => {
          // A replacement handle may have arrived while startup was pending.
          if (owner.handles.size) return;
          try { await invoke('unwatch', { root: owner.root }); } catch { /* Already closed roots are harmless. */ }
          if (owner.handles.size) await invoke<void>('watch', { root: owner.root, onEvent: owner.channel });
          else if (this.roots.get(key) === owner) this.roots.delete(key);
        });
        void owner.ready.catch(() => {});
        return owner.ready;
      },
    };
  }
  close(): Promise<void> {
    const roots = [...this.roots.values()];
    this.roots.clear();
    const previous = this.closing;
    this.closing = previous.then(async () => {
      await Promise.all(roots.map(async (state) => {
        for (const handle of state.handles) handle.subscribers.clear();
        state.handles.clear(); await state.ready.catch(() => {});
        try { await invoke('unwatch', { root: state.root }); } catch { /* Native shutdown owns any surviving handle. */ }
      }));
    });
    return this.closing;
  }
}
