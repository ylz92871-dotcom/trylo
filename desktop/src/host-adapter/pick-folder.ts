// Trylo Desktop — JS wrapper for the official Tauri
// `tauri-plugin-dialog` folder picker.
//
// v1.15.7: this replaces v1.15.5's broken PowerShell
// `Shell.Application.BrowseForFolder` approach. The
// plugin gives us a real native folder picker with
// no extra Rust code, no PowerShell, no COM, no UTF-8
// encoding dance (paths are passed through the Tauri
// IPC layer as UTF-8 strings, so non-ASCII characters
// like `D:\用户\桌面` survive the trip).
//
// Usage from anywhere: `await pickFolder()` — returns
// the selected path or null if the user cancelled.
//
// In `pnpm dev` (no Tauri runtime), we fall back to a
// `window.prompt` so the user can still paste a path
// during browser-side development.

import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauri-detect';

export interface PickFolderResult {
  /** The selected folder's absolute path, or null if the
   *  user cancelled. */
  readonly path: string | null;
  /** Which backend produced the result. */
  readonly source: 'plugin-dialog' | 'prompt';
}

export async function pickFolder(): Promise<PickFolderResult> {
  if (!isTauri()) {
    const path = window.prompt(
      'Open folder (paste absolute path; Tauri not available, using browser fallback):',
    );
    return { path: path?.trim() || null, source: 'prompt' };
  }
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Open folder (workspace)',
  });
  // open() returns string | string[] | null depending on
  // the options. We asked for directory + !multiple,
  // so the runtime type is string | null.
  if (selected === null) {
    return { path: null, source: 'plugin-dialog' };
  }
  const path = Array.isArray(selected) ? (selected[0] ?? null) : selected;
  return { path, source: 'plugin-dialog' };
}
