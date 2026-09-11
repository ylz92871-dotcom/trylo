// Trylo Work — host adapter contract. See README.md.
//
// The renderer components in this package (`ArtifactCard`, future
// viewers, etc.) don't import from `@tauri-apps/*` directly. Instead
// they call into a `HostAdapter` interface, and the host shell
// (Trylo Desktop's Tauri renderer) provides an implementation.
//
// Two reasons for this indirection:
//
// 1. **Standalone portability.** The renderer should be hostable
//    in any React + Vite app, not just Trylo Tauri. A different
//    shell (a web demo, a Storybook, the cowork-os Electron shell)
//    can drop in its own `HostAdapter` and reuse the components.
//
// 2. **Tauri APIs are chunky.** Each `invoke('...')` is a round
//    trip with serialization. Centralizing them in a single
//    adapter means we can add debouncing, batching, or fallbacks
//    in one place.
//
// The Tauri-side implementation lives at
// `desktop/src/components/work/tryloHostAdapter.ts` (built on
// `@tauri-apps/plugin-shell`). When developing the renderer
// against the stub daemon, `noOpHostAdapter` is enough for
// non-fatal actions.

export interface OpenWithApp {
  /** The OS-level app name to target, e.g. "Microsoft Word". */
  readonly name: string;
  /**
   * Platform-specific identifier used to actually launch the app.
   * Tauri 2's `shell.open` takes a path or a desktop-file name on
   * Linux. The adapter translates `name` into whatever the host
   * platform needs. If the adapter doesn't know how to open with
   * this specific app, it should fall back to `openFile`.
   */
  readonly identifier: string;
}

export interface HostAdapter {
  /**
   * Open a file with the OS default handler. Returns when the
   * shell hands off to the OS; the OS app may or may not be
   * already running.
   */
  openFile(filePath: string): Promise<void>;

  /**
   * Open a file with a specific application. The adapter decides
   * how to interpret `app` (Windows: shell-execute by name; macOS:
   * by bundle id; Linux: by .desktop file). If the host can't
   * resolve `app`, it should fall back to `openFile`.
   */
  openFileWithApp(filePath: string, app: OpenWithApp): Promise<void>;

  /**
   * Reveal `filePath` in the system file manager (Explorer /
   * Finder / Nautilus). The file should be selected/highlighted
   * if the platform supports it.
   */
  showInFolder(filePath: string): Promise<void>;

  /**
   * Copy text to the system clipboard. No-op if the host
   * doesn't expose clipboard (e.g. some sandboxed webviews).
   */
  copyToClipboard(text: string): Promise<void>;
}

/**
 * Used during dev against the stub daemon and in tests. Logs
 * every action to `console.debug` so the developer can see what
 * would have happened. Doesn't throw.
 */
export const noOpHostAdapter: HostAdapter = {
  async openFile(filePath) {
    console.debug("[hostAdapter:noOp] openFile", filePath);
  },
  async openFileWithApp(filePath, app) {
    console.debug("[hostAdapter:noOp] openFileWithApp", filePath, app);
  },
  async showInFolder(filePath) {
    console.debug("[hostAdapter:noOp] showInFolder", filePath);
  },
  async copyToClipboard(text) {
    console.debug("[hostAdapter:noOp] copyToClipboard", text);
  },
};
