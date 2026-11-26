// Trylo Desktop — native OS shell bridge.
//
// Owns DOM platform/focus/fullscreen attributes, native window theme/title/zoom sync,
// native Dock attention badges, native NSMenu context menus, and native application
// menu action subscriptions. Uses dynamic imports behind `isTauri()` so browser mode
// and Vitest stay decoupled from `@tauri-apps/api`.

import { isTauri } from './tauri-detect';
import { isMacPlatform, isWindowsPlatform, type NavigatorLike } from '../utils/platform';

export type NativePlatform = 'macos' | 'windows' | 'other';
export type AppearancePreference = 'light' | 'dark' | 'system';

export type NativeMenuActionId =
  | 'app.settings'
  | 'file.new-task'
  | 'file.open-folder'
  | 'view.command-palette'
  | 'view.mode-code'
  | 'view.mode-work'
  | 'view.toggle-sidebar'
  | 'view.toggle-right-rail'
  | 'view.toggle-terminal'
  | 'view.toggle-browser'
  | 'help.shortcuts';

export type NativeMenuActionHandlers = Partial<Record<NativeMenuActionId, () => void>>;

export interface NativeShellStateOptions {
  readonly onSystemThemeChange?: (theme?: 'light' | 'dark') => void;
  readonly onWindowFocusChange?: (focused: boolean) => void;
}

export interface NativeContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly separator?: boolean;
}

export interface NativeDockAttentionOptions {
  readonly badgeCount: number;
  readonly bounce?: boolean;
}

const VALID_MENU_ACTIONS: ReadonlySet<NativeMenuActionId> = new Set([
  'app.settings',
  'file.new-task',
  'file.open-folder',
  'view.command-palette',
  'view.mode-code',
  'view.mode-work',
  'view.toggle-sidebar',
  'view.toggle-right-rail',
  'view.toggle-terminal',
  'view.toggle-browser',
  'help.shortcuts',
]);

let lastSyncedWindowTitle: string | null = null;
let lastSyncedDockBadge: number | null = null;

function isNativeMenuActionId(value: unknown): value is NativeMenuActionId {
  return typeof value === 'string' && VALID_MENU_ACTIONS.has(value as NativeMenuActionId);
}

function setDocumentDataset(key: 'platform' | 'tauri' | 'windowFocused' | 'fullscreen', value: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset[key] = value;
}

export function detectNativePlatform(nav?: NavigatorLike): NativePlatform {
  if (isMacPlatform(nav)) return 'macos';
  if (isWindowsPlatform(nav)) return 'windows';
  return 'other';
}

/**
 * Ignore interactive chrome elements (buttons, inputs, role=button, explicit
 * no-drag regions) so double-clicking empty overlay titlebar chrome safely
 * toggles window zoom without hijacking control clicks.
 */
export function isInteractiveTitlebarTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, input, textarea, select, a, [role="button"], [role="switch"], [contenteditable="true"], [data-tauri-drag-region="false"]',
    ),
  );
}

/**
 * Synchronously mark the root element before first paint so platform-scoped
 * CSS (overlay titlebar insets, vibrancy, overlay scrollbars) applies immediately.
 */
export function initNativeShellPlatform(nav?: NavigatorLike): NativePlatform {
  const platform = detectNativePlatform(nav);
  setDocumentDataset('platform', platform);
  setDocumentDataset('tauri', isTauri() ? 'true' : 'false');
  setDocumentDataset('windowFocused', 'true');
  setDocumentDataset('fullscreen', 'false');
  return platform;
}

export async function syncNativeWindowTheme(preference: AppearancePreference): Promise<void> {
  if (!isTauri()) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_window_theme', {
      theme: preference === 'system' ? null : preference,
    });
  } catch {
    // Non-fatal fallback: mocked webviews or older hosts may not expose set_window_theme.
  }
}

export async function syncNativeWindowTitle(title: string): Promise<void> {
  const normalized = title.trim();
  if (!normalized || !isTauri()) return;
  if (lastSyncedWindowTitle === normalized) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_native_window_title', { title: normalized });
    lastSyncedWindowTitle = normalized;
  } catch {
    // Non-fatal fallback when mocked webviews lack set_native_window_title.
  }
}

export async function toggleNativeWindowZoom(): Promise<void> {
  if (!isTauri() || !isMacPlatform()) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('toggle_window_zoom');
  } catch {
    // Non-fatal fallback when host window lacks zoom support.
  }
}

export async function syncNativeDockAttention(options: NativeDockAttentionOptions): Promise<void> {
  if (!isTauri() || !isMacPlatform()) return;
  const count = Number.isFinite(options.badgeCount) && options.badgeCount > 0
    ? Math.trunc(options.badgeCount)
    : 0;
  const bounce = Boolean(options.bounce);
  if (!bounce && lastSyncedDockBadge === count) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_dock_attention', {
      badgeCount: count > 0 ? count : null,
      bounce,
    });
    lastSyncedDockBadge = count;
  } catch {
    // Non-fatal fallback when host does not expose set_dock_attention.
  }
}

export async function showNativeContextMenu(
  items: readonly NativeContextMenuItem[],
): Promise<string | null> {
  if (!isTauri() || !isMacPlatform() || items.length === 0) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const selected = await invoke<unknown>('show_native_context_menu', { items });
    return typeof selected === 'string' && selected.length > 0 ? selected : null;
  } catch {
    return null;
  }
}

export async function revealWorkspaceDirectory(path: string): Promise<boolean> {
  if (!isTauri() || !path.trim()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('reveal_workspace_directory', { path });
    return true;
  } catch {
    return false;
  }
}

export async function showWorkspaceEntryInFinder(filePath: string, allowedRoot: string): Promise<boolean> {
  if (!isTauri() || !filePath.trim() || !allowedRoot.trim()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('work_host_show_in_folder', { filePath, allowedRoot });
    return true;
  } catch {
    return false;
  }
}

export async function openWorkspaceEntryWithDefaultApp(filePath: string, allowedRoot: string): Promise<boolean> {
  if (!isTauri() || !filePath.trim() || !allowedRoot.trim()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('work_host_open_file', { filePath, allowedRoot });
    return true;
  } catch {
    return false;
  }
}

export async function copyTextToNativeClipboard(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('work_host_copy_to_clipboard', { text });
      return true;
    } catch {
      return false;
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function subscribeNativeShellState(options?: NativeShellStateOptions): () => void {
  if (!isTauri() || typeof document === 'undefined') {
    return () => {};
  }

  let disposed = false;
  const unlisteners: Array<() => void> = [];

  const register = (promise: Promise<() => void>): void => {
    void promise
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      })
      .catch(() => {
        // Non-fatal fallback when Tauri window/event listeners are unavailable in mocks.
      });
  };

  void (async () => {
    try {
      const [{ getCurrentWindow }, { listen }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/event'),
      ]);
      if (disposed) return;

      const currentWindow = getCurrentWindow();

      void currentWindow
        .isFocused()
        .then((focused) => {
          if (!disposed) {
            setDocumentDataset('windowFocused', focused ? 'true' : 'false');
            options?.onWindowFocusChange?.(focused);
          }
        })
        .catch(() => {
          // Keep initial windowFocused assumption if focus state query is unavailable.
        });

      void currentWindow
        .isFullscreen()
        .then((fullscreen) => {
          if (!disposed) setDocumentDataset('fullscreen', fullscreen ? 'true' : 'false');
        })
        .catch(() => {
          // Keep initial fullscreen assumption if fullscreen state query is unavailable.
        });

      register(
        currentWindow.onFocusChanged(({ payload }) => {
          if (!disposed) {
            setDocumentDataset('windowFocused', payload ? 'true' : 'false');
            options?.onWindowFocusChange?.(payload);
          }
        }),
      );

      register(
        currentWindow.onResized(() => {
          void currentWindow
            .isFullscreen()
            .then((fullscreen) => {
              if (!disposed) setDocumentDataset('fullscreen', fullscreen ? 'true' : 'false');
            })
            .catch(() => {
              // Ignore transient fullscreen query failures during resize or teardown.
            });
        }),
      );

      register(
        listen<unknown>('trylo://window-fullscreen', (event) => {
          if (!disposed && typeof event.payload === 'boolean') {
            setDocumentDataset('fullscreen', event.payload ? 'true' : 'false');
          }
        }),
      );

      register(
        currentWindow.onThemeChanged(({ payload }) => {
          if (!disposed) {
            const themeHint = payload === 'light' || payload === 'dark' ? payload : undefined;
            options?.onSystemThemeChange?.(themeHint);
          }
        }),
      );
    } catch {
      // Non-fatal fallback when @tauri-apps/api window/event modules cannot load.
    }
  })();

  return () => {
    disposed = true;
    while (unlisteners.length > 0) {
      const unlisten = unlisteners.pop();
      try {
        unlisten?.();
      } catch {
        // Ignore teardown errors from already-closed webview listeners.
      }
    }
  };
}

export function subscribeNativeMenuActions(handlers: NativeMenuActionHandlers): () => void {
  if (!isTauri()) {
    return () => {};
  }

  let disposed = false;
  let unlistenMenu: (() => void) | null = null;

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      if (disposed) return;

      const unlisten = await listen<unknown>('trylo://menu-action', (event) => {
        if (disposed || !isNativeMenuActionId(event.payload)) return;
        const handler = handlers[event.payload];
        handler?.();
      });

      if (disposed) {
        unlisten();
        return;
      }
      unlistenMenu = unlisten;
    } catch {
      // Non-fatal fallback when native menu event bridge is unavailable.
    }
  })();

  return () => {
    disposed = true;
    if (unlistenMenu) {
      try {
        unlistenMenu();
      } catch {
        // Ignore teardown errors when listener was already unregistered.
      }
      unlistenMenu = null;
    }
  };
}
