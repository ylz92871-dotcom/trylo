// Trylo Desktop — HostAdapter channels. See the architecture doc §2.2.
//
// Streaming surface. Tauri 2 Channel<T> for sustained streams (PTY bytes,
// LSP frames, file watcher events, agent output). One-shot events use
// @tauri-apps/api/event's emit/listen and live in events.ts (not this
// file).

import type { FileChangeEvent, FilePath, LspHandle, LspMessage, PtyId } from './types';

export interface WatchSubscription {
  /** Stop receiving events for this subscription. */
  unsubscribe(): void;
}

export interface WatchChannel {
  /**
   * Subscribe to file-change events under `root`. Returns the subscription
   * handle; the implementation must debounce identical events per
   * WatchOptions.debounceMs (default 50ms).
   */
  subscribe(
    root: FilePath,
    cb: (events: readonly FileChangeEvent[]) => void,
  ): Promise<WatchSubscription>;
}

export interface LspChannel {
  /** Subscribe to all messages coming back from the server for this handle. */
  onMessage(handle: LspHandle, cb: (msg: LspMessage) => void): WatchSubscription;
}

export interface PtyChannel {
  /** Subscribe to bytes emitted by the PTY (Tauri → JS). */
  onData(handle: PtyId, cb: (data: Uint8Array) => void): WatchSubscription;
}

export interface StreamBackend {
  readonly watch: WatchChannel;
  readonly lsp: LspChannel;
  readonly pty: PtyChannel;
}
