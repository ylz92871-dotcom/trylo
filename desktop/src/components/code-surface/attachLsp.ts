// Trylo Desktop — LSP wiring. See ARCHITECTURE.md §2.7.
//
// Spike scope: detect the right language from a file path,
// start the LSP server via the LspManager, and return a
// disposable that the caller can use to tear it down. The
// actual monaco-languageclient connection (custom Tauri
// transport for stdout/stdin framing, didOpen/didChange
// flow, completion) is Phase 1 polish — the spike just
// proves the manager+config pipeline works end-to-end.

import { hostAdapter, type FilePath, type LspManager } from '../../host-adapter';

export interface LspAttachResult {
  /** Stop the LSP server. Safe to call multiple times. */
  readonly dispose: () => Promise<void>;
  /** The language id the file was attached to, for diagnostics. */
  readonly languageId: string;
  /** The handle from `LspManager.ensureServer` (id is opaque to
   *  callers; the manager owns the rest of the lifecycle). */
  readonly handleId: string;
}

/**
 * Map a file path to its language id. Mirrors the Rust
 * `lsp_config::for_path` (single source of truth on the Rust
 * side). We keep the TS copy in sync so the test can exercise
 * the mapping without a Tauri round-trip.
 */
export function languageIdForPath(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.c': 'cpp',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.cxx': 'cpp',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.rs': 'rust',
    '.go': 'go',
  };
  for (const [ext, lang] of Object.entries(map)) {
    if (lower.endsWith(ext)) return lang;
  }
  return null;
}

/**
 * Ensure an LSP server is running for the file's language. The
 * manager is idempotent per (language, workspaceRoot), so this
 * is a cheap call after the first time. Returns a disposable
 * the caller stores; calling `dispose()` stops the server
 * (and, in Phase 1, will also tear down the monaco-languageclient
 * connection).
 */
export async function attachLspToFile(
  filePath: FilePath,
  lspManager: LspManager = hostAdapter.lsp,
  workspaceRoot: string = '',
): Promise<LspAttachResult | null> {
  const languageId = languageIdForPath(filePath);
  if (languageId === null) return null;

  const handle = await lspManager.ensureServer(languageId, workspaceRoot);
  let disposed = false;
  return {
    languageId,
    handleId: handle.id,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await lspManager.stop(handle);
    },
  };
}
