// Trylo Desktop — concrete FsCommands impl backed by Tauri IPC. See
// the architecture doc §2.2 (HostAdapter is the only entry point) + §2.3
// (Project State as source of truth).
//
// This file is the ONLY place in the React tree that imports
// `@tauri-apps/api/core`'s `invoke`. Component code goes through
// `hostAdapter.fs.readFile(...)` instead — IPC refactors are a
// one-file change here, not a hunt across 40 components.
//
// Phase 1.0 list_dir workaround: Rust returns a JSON string
// (see list_dir.rs) because Tauri 2's IPC codec hangs on the
// `Vec<DirEntry>` return in our webview build. JS parses the
// string back into the typed array. read_file and stat_file are
// untouched (they return String and FileStat, both simple).
//
// v1.15: in the browser (vite dev WITHOUT `pnpm tauri dev`),
// `invoke` throws because there is no Tauri runtime. We
// detect the absence via `window.__TAURI_INTERNALS__` and
// fall back to the dev server's /__dev_fs/* endpoints (see
// vite-plugins/dev-file-api.ts). Production builds and
// `tauri dev` go through the Tauri path unchanged.

import { invoke } from '@tauri-apps/api/core';
import type { FsCommands, ScanTreeResult } from './commands';
import type { DirEntry, FilePath, FileStat } from './types';
import { isTauri } from './tauri-detect';

interface RawDirEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

function parseDirEntries(json: string): readonly DirEntry[] {
  // The Rust side serializes with `is_directory` (snake_case). The
  // TS interface uses `isDirectory` (camelCase). Normalize here so
  // the FileTree / bridge / types match.
  const raw = JSON.parse(json) as readonly RawDirEntry[];
  return raw.map((r) => ({
    name: r.name,
    path: r.path,
    isDirectory: r.is_directory,
  }));
}

/** True when the page is hosted in a Tauri webview. */
// (Re-exported from ./tauri-detect.)

/**
 * Browser fallback: hit the dev server's local file API.
 * Returns the raw response body as text. Throws on non-2xx.
 */
async function devFetch(op: string, path: string): Promise<string> {
  const res = await fetch(
    `/__dev_fs/${op}?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`dev fs ${op} ${res.status}: ${body}`);
  }
  return res.text();
}

export const tauriFsCommands: FsCommands = {
  readFile: async (path) => {
    if (!isTauri()) return devFetch('read_file', path);
    return invoke<string>('read_file', { path });
  },
  writeFile: async (path, content) => {
    // The browser dev backend doesn't support writes (dev is
    // read-only on the filesystem) — fall through to invoke
    // which will throw with a clear "no Tauri" message.
    if (!isTauri()) {
      throw new Error('writeFile is unavailable in the browser dev backend');
    }
    return invoke<void>('write_file', { path, content });
  },
  statFile: async (path) => {
    if (!isTauri()) {
      const text = await devFetch('stat_file', path);
      return JSON.parse(text) as FileStat;
    }
    return invoke<FileStat>('stat_file', { path });
  },
  listDir: async (path) => {
    if (!isTauri()) {
      const json = await devFetch('list_dir', path);
      return parseDirEntries(json);
    }
    const json = await invoke<string>('list_dir', { path });
    return parseDirEntries(json);
  },
  // v1.16.2.6: binary file read for image previews. The
  // Tauri fs plugin has a separate read_binary_file
  // command that returns a number[] (we Uint8Array.from
  // it). The browser dev backend returns a small
  // placeholder so the test suite can exercise the
  // preview path without a real filesystem.
  readFileBytes: async (path) => {
    if (!isTauri()) {
      const b64 = await devFetch('read_file_bytes', path);
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    const raw = await invoke<number[]>('read_file_bytes', { path });
    return Uint8Array.from(raw);
  },
  // v1.16.x: binary file write for remote (mobile) image attachments. The
  // phone sends a base64 data URL; we decode it in the renderer and hand the
  // raw bytes to the host, which writes them to disk. The browser dev backend
  // is read-only on the filesystem, so we fall through to invoke (throws).
  writeFileBytes: async (path, base64) => {
    if (!isTauri()) {
      throw new Error('writeFileBytes is unavailable in the browser dev backend');
    }
    const comma = base64.indexOf(',');
    const payload = comma >= 0 ? base64.slice(comma + 1) : base64;
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return invoke<void>('write_file_bytes', { path, bytes: Array.from(bytes) });
  },
  // P2-1 (spec §8.4): bounded recursive scan. The Tauri path is a single IPC
  // round trip returning a typed FileStat[]; the browser dev backend composes
  // the same contract from the existing list/stat primitives so the Work
  // scanner works identically in `vite` dev without a Tauri runtime.
  scanTree: async (path, options) => {
    if (!isTauri()) {
      return devScanTree(path, options);
    }
    return invoke<ScanTreeResult>('scan_tree', {
      root: path,
      maxFiles: options?.maxFiles,
      maxDepth: options?.maxDepth,
    });
  },
};

/** Browser-dev fallback for `scanTree`: a small recursive walker over the
 *  existing `listDir` / `statFile` primitives. Same contract (files + stat),
 *  bounded, never follows into symlinked directories (dev only; the Tauri path
 *  is authoritative and uses `symlink_metadata`). */
async function devScanTree(
  root: FilePath,
  options: { maxFiles?: number; maxDepth?: number } | undefined,
): Promise<ScanTreeResult> {
  const maxFiles = Math.min(options?.maxFiles ?? 1000, 10_000);
  const maxDepth = Math.min(options?.maxDepth ?? 12, 32);
  const files: FileStat[] = [];
  const warnings: string[] = [];
  let truncated = false;

  const walk = async (dir: FilePath, depth: number): Promise<void> => {
    if (depth > maxDepth || truncated) return;
    let entries: readonly DirEntry[];
    try {
      entries = await tauriFsCommands.listDir(dir);
    } catch (err) {
      if (warnings.length < 32) warnings.push(`${dir}: ${String(err)}`);
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (entry.isDirectory) {
        await walk(entry.path, depth + 1);
      } else {
        try {
          const stat = await tauriFsCommands.statFile(entry.path);
          files.push(stat);
        } catch (err) {
          if (warnings.length < 32) warnings.push(`${entry.path}: ${String(err)}`);
        }
      }
      if (truncated) return;
    }
  };

  await walk(root, 0);
  return { files, truncated, warnings };
}
