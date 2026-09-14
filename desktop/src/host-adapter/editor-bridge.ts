// Trylo Desktop — EditorBridge interface. See ARCHITECTURE.md §2.5.
//
// The EditorBridge is the module that owns the dirty-buffer + external-
// change rules. It is the only place that knows about both Monaco's
// dirty-tracking and the filesystem's on-disk state. Per §2.5:
//
// | State of buffer | External change arrives | What we do               |
// |-----------------|------------------------|--------------------------|
// | Clean           | changed on disk        | Auto-reload             |
// | Dirty           | changed on disk        | Show conflict UI        |
// | Clean           | deleted on disk        | Show "deleted" banner   |
// | Dirty           | deleted on disk        | Show conflict UI        |
//
// B (corrected): the bridge owns the in-memory `buffer`. The
// React side drives user edits via `setBuffer()`. Save writes the
// bridge's buffer. Conflict resolution re-aligns buffer and load
// on `acceptExternal` or re-writes the disk from buffer on
// `keepMine`.

import type { FilePath } from './types';

export type ConflictKind = 'modified' | 'deleted';

export interface ConflictEvent {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  /** The new on-disk content, populated for `kind: 'modified'`.
   *  For `kind: 'deleted'` this is `null` (the file is gone). */
  readonly externalContent: string | null;
}

export interface EditorBridge {
  /** True when the buffer has user edits not yet saved to disk. */
  isDirty(): boolean;
  /** Get the current load state. */
  getLoad(): import('./editor-bridge-impl').LoadState;
  /** Get the current buffer content (what the editor is showing). */
  getBuffer(): string;
  /** Update the editor's in-memory content. Called from the
   *  React side on user typing. */
  setBuffer(value: string): void;
  /** Replace the load state. The bridge re-aligns buffer with
   *  load.content on a `ready` transition. */
  setLoad(load: import('./editor-bridge-impl').LoadState): void;
  /** Subscribe to dirty-state transitions. */
  onDirtyChange(cb: (dirty: boolean) => void): () => void;
  /** Subscribe to load-state transitions. */
  onLoadChange(cb: (load: import('./editor-bridge-impl').LoadState) => void): () => void;
  /** Subscribe to buffer changes. */
  onBufferChange(cb: (buffer: string) => void): () => void;
  /** Subscribe to conflict events. */
  onConflict(cb: (event: ConflictEvent) => void): () => void;
  /** Re-read the file from disk and replace the buffer. */
  reload(): Promise<void>;
  /** Resolve a conflict in favor of "external": discard the
   *  user's edits and take the on-disk version. The React
   *  side calls `reload()` afterwards to pull the new
   *  content into the buffer. */
  acceptExternal(): Promise<void>;
  /** Resolve a conflict in favor of "local": write the
   *  current buffer to disk. */
  keepMine(): Promise<void>;
}
