// Trylo Desktop — HostAdapter commands. See the architecture doc §2.2.
//
// Request/response surface. Each method here maps to one Tauri command on
// the Rust side (see src-tauri/src/commands/*.rs). Components call
// adapter.fs.readFile(...), never @tauri-apps/api/core's invoke().

import type { DirEntry, FilePath, FileStat } from './types';

/** Bounded recursive directory scan (P2-1, spec §8.4). Returns all files with
 *  their stat metadata in ONE IPC call so the Work `.trylo/out` scan does not
 *  fire hundreds of per-file WebView invocations. */
export interface ScanTreeResult {
  readonly files: readonly FileStat[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export interface FsCommands {
  readFile(path: FilePath): Promise<string>;
  writeFile(path: FilePath, content: string): Promise<void>;
  statFile(path: FilePath): Promise<FileStat>;
  listDir(path: FilePath): Promise<readonly DirEntry[]>;
  // v1.16.2.6: read binary file as a Uint8Array. Used by
  // the attachment flow to build data URLs for image
  // previews. The Tauri side uses the @tauri-apps/plugin-fs
  // `readBinaryFile` command; the browser dev backend
  // returns a base64-encoded string (so the test suite
  // doesn't need a real FS).
  readFileBytes(path: FilePath): Promise<Uint8Array>;
  /** Write raw bytes to `path` from a base64 string (e.g. a remote image
   *  attachment). The Tauri command decodes the base64 on the host; the
   *  browser dev backend is read-only and throws. */
  writeFileBytes(path: FilePath, base64: string): Promise<void>;
  /** P2-1 (spec §8.4): bounded recursive scan of `path` (a directory),
   *  clamped to `maxFiles` / `maxDepth` on the host. Missing root → empty. */
  scanTree(path: FilePath, options?: ScanTreeOptions): Promise<ScanTreeResult>;
}

export interface ScanTreeOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

// P2-1 (spec §7.3): the legacy `GitCommands` shape is fully replaced by the
// typed `GitService` (see ./git-service.ts) and has been removed. Components
// and projectors use `hostAdapter.git`.
export interface FsCommandsBackend {
  readonly fs: FsCommands;
}
