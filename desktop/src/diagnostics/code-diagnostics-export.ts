// Trylo Desktop — dev-only diagnostics export (C-Edge P2-5).
//
// In dev mode, the ring buffer is exposed on `window.__trylo_diagnostics`
// so engineers can read the recent transition history without
// rebuilding. In production this is a no-op — the buffer still
// runs in memory (consumers can attach via `subscribe` and the future
// Tauri export command), but it is NOT attached to the window.

import type { CodeDiagnosticsBuffer, CodeDiagnosticsSnapshot } from './code-diagnostics-buffer';

declare global {
  interface Window {
    __trylo_diagnostics?: DevtoolsDiagnostics;
  }
}

export interface DevtoolsDiagnostics {
  readonly snapshot: () => CodeDiagnosticsSnapshot;
  readonly exportJson: () => string;
  readonly clear: () => void;
  readonly limit: number;
}

export function buildDevtoolsDiagnostics(
  buffer: CodeDiagnosticsBuffer,
): DevtoolsDiagnostics {
  return {
    snapshot: () => buffer.snapshot(),
    exportJson: () => buffer.exportJson(),
    clear: () => buffer.clear(),
    limit: buffer.snapshot().events.length === 0 ? 0 : buffer.snapshot().events.length,
  };
}

/** Install (or no-op) the dev-only window surface. Safe to call in
 *  production — the gate is `import.meta.env.DEV`. */
export function installDiagnosticsDevtools(
  buffer: CodeDiagnosticsBuffer,
): void {
  if (typeof window === 'undefined') return;
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  if (env?.DEV !== true) return;
  const surface = buildDevtoolsDiagnostics(buffer);
  try {
    Object.defineProperty(window, '__trylo_diagnostics', {
      value: surface,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Some hosts lock the global. The buffer still works; the
    // surface is best-effort.
  }
}
