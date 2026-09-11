// Trylo Desktop — HostAdapter shared types. See the architecture doc §2.2.
//
// The HostAdapter is the ONLY entry point to Tauri IPC. All request/reply
// and stream types live here so component code never imports @tauri-apps/api
// directly.

// ── File system ────────────────────────────────────────────────────────────

export type FilePath = string;

/** The two top-level modes in the top bar. v1.5. */
export type TopLevelMode = 'code' | 'work';

/**
 * Sub-modes of the Code top-level mode. Work (= Office) has
 * no sub-modes; the Office panel itself is the surface.
 */
export type CodeMode = 'chat' | 'plan' | 'agent' | 'cognition';

export interface FileStat {
  readonly path: FilePath;
  readonly size: number;
  readonly modifiedMs: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  /**
   * True when the entry is a symbolic link or Windows reparse point.
   * Rust uses `symlink_metadata` so the entry is reported honestly —
   * `isFile` and `isDirectory` are both false on a symlink. Consumers
   * that only accept regular files MUST check `isSymlink` (or equivalently
   * require `isFile === true`) before treating the entry as content.
   */
  readonly isSymlink: boolean;
}

export interface DirEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly isDirectory: boolean;
}

// ── File watcher ───────────────────────────────────────────────────────────

export type FileChangeKind = 'created' | 'modified' | 'deleted' | 'renamed';

export interface FileChangeEvent {
  readonly kind: FileChangeKind;
  readonly path: FilePath;
  /** Set when kind === 'renamed' and the old path is known. */
  readonly oldPath?: FilePath;
}

// ── LSP ────────────────────────────────────────────────────────────────────

export type LanguageId = 'typescript' | 'python' | 'cpp' | 'rust' | 'go' | string;

export interface LspHandle {
  readonly id: string;
  readonly language: LanguageId;
  readonly workspaceRoot: FilePath;
}

/** A single JSON-RPC frame per the LSP spec. */
export interface LspMessage {
  // We keep the raw shape — the LSP wire format is JSON-RPC 2.0 and
  // different methods add fields. Validating the inner shape is the
  // responsibility of the message handler, not the transport.
  readonly json: string;
}

// ── Process ────────────────────────────────────────────────────────────────

export type ProcessId = string;

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: FilePath;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcessInfo {
  readonly id: ProcessId;
  readonly pid: number;
  readonly command: string;
  readonly args: readonly string[];
}

// ── PTY ────────────────────────────────────────────────────────────────────

export type PtyId = string;

export interface PtyStartRequest {
  readonly shell: 'bash' | 'pwsh' | 'zsh' | 'sh';
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: FilePath;
}
