// Trylo Desktop — Folder picker.
//
// v1.10.1: reverts the v1.10 rfd-based Rust command. Tauri 2
// has `dialogs: true` by default on the webview, so a
// `window.prompt(...)` call shows the OS-native prompt.
// Same code path runs in:
//   - Browser dev (Vite):  shows a regular browser prompt.
//   - Tauri webview:      shows a native prompt (Tauri
//                          intercepts window.prompt and routes
//                          it through the OS dialog API).
//
// Phase 3 housekeeping: once the network can reach
// crates.io, add `tauri-plugin-dialog` (or `rfd = "0.14"`)
// and call its native folder picker from here.

import type { FilePath } from './types';

export async function pickFolder(): Promise<FilePath | null> {
  const picked = window.prompt(
    'Open folder — enter an absolute path:',
    'C:/work/demo-ws',
  );
  return picked && picked.trim() !== '' ? (picked.trim() as FilePath) : null;
}
