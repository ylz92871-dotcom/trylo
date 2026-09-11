// Trylo Desktop — Tauri detection probe. Single source of
// truth for "are we inside a Tauri webview?". Used by the
// browser-fallback branches throughout the host-adapter
// layer so the rest of the code can do `isTauri()` without
// caring about Tauri 2's global key churn.

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(
    w['__TAURI_INTERNALS__'] ??
      w['__TAURI__'] ??
      w['__TAURI_IPC__'],
  );
}
