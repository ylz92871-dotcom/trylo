// Trylo Desktop — EditorBridge concrete impl. See the architecture doc
// §2.5 + §2.3.1.
//
// Phase 1.0: the state machine that used to live inline in
// App.tsx is extracted here. The impl is a pure class — no React
// dependency — so it can be unit-tested with a stub FS. The React
// side wraps it in a thin hook (`use-editor-bridge.ts`).
//
// B (corrected): the bridge owns a `buffer` field — the in-memory
// content the editor is showing for this file. The buffer is
// the source of truth for the editor's value; the load (file
// content) is the source of truth for the on-disk state. `dirty`
// is derived: `load.kind === 'ready' && buffer !== load.content`.
//
// Responsibilities:
//   - Track load (the file's last known content + stat).
//   - Track buffer (what the editor is showing, including the
//     user's edits).
//   - On external change: branch on dirty per arch doc §2.5 —
//     clean → auto-reload, dirty → surface a conflict.
//   - Conflict resolution: `acceptExternal` discards the user's
//     edits and takes the on-disk version; `keepMine` overwrites
//     the disk with the buffer.

import type { EditorBridge, ConflictEvent, ConflictKind } from './editor-bridge';
import type { FileChangeEvent, FilePath, FileStat } from './types';

export type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string; stat: FileStat }
  | { kind: 'deleted' }
  | { kind: 'error'; message: string };

export interface EditorBridgeFs {
  readFile(path: FilePath): Promise<string>;
  writeFile(path: FilePath, content: string): Promise<void>;
  statFile(path: FilePath): Promise<FileStat>;
}

export interface EditorBridgeImplOptions {
  readonly path: FilePath;
  readonly fs: EditorBridgeFs;
}

export class EditorBridgeImpl implements EditorBridge {
  private load: LoadState = { kind: 'loading' };
  /**
   * The buffer the editor is showing for this file. Initialized
   * to '' in the constructor; populated to load.content when the
   * file is loaded. The user edits via `setBuffer()` (wired from
   * MonacoEditor's onDidChangeModelContent via App.tsx).
   */
  private buffer: string = '';
  private readonly dirtyListeners = new Set<(d: boolean) => void>();
  private readonly loadListeners = new Set<(l: LoadState) => void>();
  private readonly bufferListeners = new Set<(b: string) => void>();
  private readonly conflictListeners = new Set<(e: ConflictEvent) => void>();

  constructor(private readonly opts: EditorBridgeImplOptions) {
    void this.loadInitial();
  }

  private async loadInitial(): Promise<void> {
    try {
      const [content, stat] = await Promise.all([
        this.opts.fs.readFile(this.opts.path),
        this.opts.fs.statFile(this.opts.path),
      ]);
      this.setLoad({ kind: 'ready', content, stat });
      this.setBuffer(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setLoad({ kind: 'error', message });
    }
  }

  // ── State accessors ───────────────────────────────────────────

  isDirty(): boolean {
    return this.load.kind === 'ready' && this.buffer !== this.load.content;
  }

  getLoad(): LoadState {
    return this.load;
  }

  getBuffer(): string {
    return this.buffer;
  }

  // ── State mutators (called by the React side) ────────────────

  /** Update the editor's in-memory content. Called by App.tsx
   *  when MonacoEditor's onDidChangeModelContent fires (i.e., the
   *  user typed). */
  setBuffer(value: string): void {
    const wasDirty = this.isDirty();
    this.buffer = value;
    for (const cb of this.bufferListeners) cb(value);
    const isDirtyNow = this.isDirty();
    if (wasDirty !== isDirtyNow) {
      for (const cb of this.dirtyListeners) cb(isDirtyNow);
    }
  }

  /** Replace the load state. When transitioning into `ready`, the
   *  buffer is also set to the loaded content (so the editor
   *  mirrors the new file content on initial load / reload). */
  setLoad(load: LoadState): void {
    const wasDirty = this.isDirty();
    this.load = load;
    if (load.kind === 'ready') {
      this.buffer = load.content;
      for (const cb of this.bufferListeners) cb(this.buffer);
    }
    for (const cb of this.loadListeners) cb(this.load);
    const isDirtyNow = this.isDirty();
    if (wasDirty !== isDirtyNow) {
      for (const cb of this.dirtyListeners) cb(isDirtyNow);
    }
  }

  // ── Event subscription ────────────────────────────────────────

  onDirtyChange(cb: (dirty: boolean) => void): () => void {
    this.dirtyListeners.add(cb);
    return () => {
      this.dirtyListeners.delete(cb);
    };
  }

  onLoadChange(cb: (load: LoadState) => void): () => void {
    this.loadListeners.add(cb);
    return () => {
      this.loadListeners.delete(cb);
    };
  }

  onBufferChange(cb: (buffer: string) => void): () => void {
    this.bufferListeners.add(cb);
    return () => {
      this.bufferListeners.delete(cb);
    };
  }

  onConflict(cb: (event: ConflictEvent) => void): () => void {
    this.conflictListeners.add(cb);
    return () => {
      this.conflictListeners.delete(cb);
    };
  }

  // ── Watcher hook: dispatch an external event ──────────────────

  /**
   * Called by the React side when a `WorkspaceWatcher` event
   * arrives for this bridge's path. Branches on dirty per
   * arch doc §2.5:
   *
   *   clean + modified   → silent auto-reload
   *   dirty + modified   → setConflict('modified', externalContent)
   *   clean + deleted    → setLoad('deleted')
   *   dirty + deleted    → setConflict('deleted')
   */
  async onExternalEvent(event: FileChangeEvent): Promise<void> {
    if (event.kind === 'deleted') {
      this.handleDelete();
      return;
    }
    let content: string;
    let stat: FileStat;
    try {
      [content, stat] = await Promise.all([
        this.opts.fs.readFile(this.opts.path),
        this.opts.fs.statFile(this.opts.path),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setLoad({ kind: 'error', message });
      return;
    }

    if (this.load.kind === 'ready' && content === this.load.content) {
      // No-op change (e.g. a touch). Don't disturb the editor.
      return;
    }

    if (this.isDirty()) {
      this.fireConflict({
        kind: 'modified',
        path: this.opts.path,
        externalContent: content,
      });
    } else {
      this.setLoad({ kind: 'ready', content, stat });
    }
  }

  // ── Conflict resolution (called by the React UI) ─────────────

  async reload(): Promise<void> {
    this.setLoad({ kind: 'loading' });
    try {
      const [content, stat] = await Promise.all([
        this.opts.fs.readFile(this.opts.path),
        this.opts.fs.statFile(this.opts.path),
      ]);
      this.setLoad({ kind: 'ready', content, stat });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setLoad({ kind: 'error', message });
    }
  }

  async acceptExternal(): Promise<void> {
    // The conflict event we emitted earlier carried the external
    // content. The React side should reload via reload() to pull
    // it into the buffer. This method just clears the dirty flag.
    this.setDirtyInternal(false);
  }

  async keepMine(): Promise<void> {
    try {
      await this.opts.fs.writeFile(this.opts.path, this.buffer);
      this.setLoad({ ...this.load, kind: 'ready', content: this.buffer, stat: this.load.kind === 'ready' ? this.load.stat : { path: this.opts.path, size: 0, modified_ms: 0, is_directory: false, is_file: true } } as LoadState);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setLoad({ kind: 'error', message });
      throw err;
    }
  }

  // ── Internals ─────────────────────────────────────────────────

  private handleDelete(): void {
    if (this.isDirty()) {
      this.fireConflict({ kind: 'deleted', path: this.opts.path, externalContent: null });
    } else {
      this.setLoad({ kind: 'deleted' });
    }
  }

  private setDirtyInternal(d: boolean): void {
    const wasDirty = this.isDirty();
    if (d) {
      // Force-dirty by setting buffer to a sentinel? No — we don't
      // have that. The dirty state is derived; acceptExternal is
      // the cleanup path that triggers a reload which clears
      // dirty. We leave this method unused for now; the derived
      // dirty is the source of truth.
    } else if (this.load.kind === 'ready' && this.buffer !== this.load.content) {
      // Force-clean by re-aligning buffer with load.
      this.buffer = this.load.content;
      for (const cb of this.bufferListeners) cb(this.buffer);
    }
    const isDirtyNow = this.isDirty();
    if (wasDirty !== isDirtyNow) {
      for (const cb of this.dirtyListeners) cb(isDirtyNow);
    }
  }

  private fireConflict(event: ConflictEvent): void {
    for (const cb of this.conflictListeners) cb(event);
  }
}

export type { ConflictEvent, ConflictKind };
