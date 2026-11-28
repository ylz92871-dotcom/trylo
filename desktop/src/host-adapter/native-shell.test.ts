import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyTextToNativeClipboard,
  initNativeShellPlatform,
  isInteractiveTitlebarTarget,
  openWorkspaceEntryWithDefaultApp,
  revealWorkspaceDirectory,
  showNativeContextMenu,
  showWorkspaceEntryInFinder,
  subscribeNativeMenuActions,
  subscribeNativeShellState,
  syncNativeDockAttention,
  syncNativeWindowTheme,
  syncNativeWindowTitle,
  toggleNativeWindowZoom,
} from './native-shell';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isFocused: vi.fn(),
  isFullscreen: vi.fn(),
  onFocusChanged: vi.fn(),
  onResized: vi.fn(),
  onThemeChanged: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: mocks.isFocused,
    isFullscreen: mocks.isFullscreen,
    onFocusChanged: mocks.onFocusChanged,
    onResized: mocks.onResized,
    onThemeChanged: mocks.onThemeChanged,
  }),
}));

function setTauriGlobal(enabled: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (enabled) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

function mockNavigator(platform: string, userAgent = ''): () => void {
  const origPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  const origUA = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  return () => {
    if (origPlatform) Object.defineProperty(window.navigator, 'platform', origPlatform);
    else delete (window.navigator as { platform?: string }).platform;
    if (origUA) Object.defineProperty(window.navigator, 'userAgent', origUA);
    else delete (window.navigator as { userAgent?: string }).userAgent;
  };
}

let restoreNav: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  setTauriGlobal(false);
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.tauri;
  delete document.documentElement.dataset.windowFocused;
  delete document.documentElement.dataset.fullscreen;
  delete document.documentElement.dataset.theme;
  localStorage.clear();

  mocks.invoke.mockResolvedValue(undefined);
  mocks.isFocused.mockResolvedValue(true);
  mocks.isFullscreen.mockResolvedValue(false);
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.onFocusChanged.mockResolvedValue(vi.fn());
  mocks.onResized.mockResolvedValue(vi.fn());
  mocks.onThemeChanged.mockResolvedValue(vi.fn());
});

afterEach(() => {
  restoreNav?.();
  restoreNav = undefined;
  setTauriGlobal(false);
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('native-shell bridge', () => {
  it('initializes platform, tauri, focus, and fullscreen datasets synchronously', () => {
    setTauriGlobal(true);
    restoreNav = mockNavigator('MacIntel');
    expect(initNativeShellPlatform()).toBe('macos');
    expect(document.documentElement.dataset.platform).toBe('macos');
    expect(document.documentElement.dataset.tauri).toBe('true');
    expect(document.documentElement.dataset.windowFocused).toBe('true');
    expect(document.documentElement.dataset.fullscreen).toBe('false');

    setTauriGlobal(false);
    expect(initNativeShellPlatform({ platform: 'Win32', userAgent: '' })).toBe('windows');
    expect(document.documentElement.dataset.platform).toBe('windows');
    expect(document.documentElement.dataset.tauri).toBe('false');

    expect(initNativeShellPlatform({ platform: 'Linux x86_64', userAgent: '' })).toBe('other');
    expect(document.documentElement.dataset.platform).toBe('other');
  });

  it('syncs native window theme only in Tauri and handles unavailable commands cleanly', async () => {
    await syncNativeWindowTheme('dark');
    expect(mocks.invoke).not.toHaveBeenCalled();

    setTauriGlobal(true);
    await syncNativeWindowTheme('light');
    await syncNativeWindowTheme('dark');
    await syncNativeWindowTheme('system');

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'set_window_theme', { theme: 'light' });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'set_window_theme', { theme: 'dark' });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'set_window_theme', { theme: null });

    mocks.invoke.mockRejectedValueOnce(new Error('unsupported'));
    await expect(syncNativeWindowTheme('dark')).resolves.toBeUndefined();
  });

  it('returns no-op disposers outside Tauri', () => {
    const disposeState = subscribeNativeShellState({ onSystemThemeChange: vi.fn() });
    const disposeMenus = subscribeNativeMenuActions({ 'app.settings': vi.fn() });

    expect(() => disposeState()).not.toThrow();
    expect(() => disposeMenus()).not.toThrow();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.onFocusChanged).not.toHaveBeenCalled();
  });

  it('tracks focus, fullscreen, resized, and system theme events in Tauri and cleans up listeners', async () => {
    setTauriGlobal(true);
    const unlistenFocus = vi.fn();
    const unlistenResize = vi.fn();
    const unlistenTheme = vi.fn();
    const unlistenFsEvent = vi.fn();

    let focusCb: ((e: { payload: boolean }) => void) | undefined;
    let resizeCb: (() => void) | undefined;
    let themeCb: ((e: { payload: string }) => void) | undefined;
    let fsEventCb: ((e: { payload: unknown }) => void) | undefined;

    mocks.isFocused.mockResolvedValue(false);
    mocks.isFullscreen.mockResolvedValue(true);
    mocks.onFocusChanged.mockImplementation(async (cb) => {
      focusCb = cb;
      return unlistenFocus;
    });
    mocks.onResized.mockImplementation(async (cb) => {
      resizeCb = cb;
      return unlistenResize;
    });
    mocks.onThemeChanged.mockImplementation(async (cb) => {
      themeCb = cb;
      return unlistenTheme;
    });
    mocks.listen.mockImplementation(async (eventName, cb) => {
      if (eventName === 'trylo://window-fullscreen') fsEventCb = cb;
      return unlistenFsEvent;
    });

    const onSystemThemeChange = vi.fn();
    const dispose = subscribeNativeShellState({ onSystemThemeChange });

    await vi.waitFor(() => {
      expect(document.documentElement.dataset.windowFocused).toBe('false');
      expect(document.documentElement.dataset.fullscreen).toBe('true');
      expect(focusCb).toBeDefined();
      expect(resizeCb).toBeDefined();
      expect(themeCb).toBeDefined();
      expect(fsEventCb).toBeDefined();
    });

    focusCb?.({ payload: true });
    expect(document.documentElement.dataset.windowFocused).toBe('true');

    mocks.isFullscreen.mockResolvedValueOnce(false);
    resizeCb?.();
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.fullscreen).toBe('false');
    });

    fsEventCb?.({ payload: true });
    expect(document.documentElement.dataset.fullscreen).toBe('true');

    themeCb?.({ payload: 'dark' });
    expect(onSystemThemeChange).toHaveBeenCalledWith('dark');

    dispose();
    expect(unlistenFocus).toHaveBeenCalledTimes(1);
    expect(unlistenResize).toHaveBeenCalledTimes(1);
    expect(unlistenTheme).toHaveBeenCalledTimes(1);
    expect(unlistenFsEvent).toHaveBeenCalledTimes(1);
  });

  it('disposes async menu listeners safely if unmounted while listen registration is in flight', async () => {
    setTauriGlobal(true);
    const unlistenMenu = vi.fn();
    let resolveListen: ((fn: () => void) => void) | undefined;
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );

    const onSettings = vi.fn();
    const dispose = subscribeNativeMenuActions({ 'app.settings': onSettings });

    await vi.waitFor(() => {
      expect(resolveListen).toBeTypeOf('function');
    });

    dispose();
    resolveListen?.(unlistenMenu);

    await vi.waitFor(() => {
      expect(unlistenMenu).toHaveBeenCalledTimes(1);
    });
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('dispatches valid native menu actions and ignores unknown payloads', async () => {
    setTauriGlobal(true);
    const unlistenMenu = vi.fn();
    let menuCb: ((e: { payload: unknown }) => void) | undefined;
    mocks.listen.mockImplementation(async (eventName, cb) => {
      if (eventName === 'trylo://menu-action') menuCb = cb;
      return unlistenMenu;
    });

    const handlers = {
      'app.settings': vi.fn(),
      'file.new-task': vi.fn(),
      'file.open-folder': vi.fn(),
      'view.command-palette': vi.fn(),
      'view.mode-code': vi.fn(),
      'view.mode-work': vi.fn(),
      'view.toggle-sidebar': vi.fn(),
      'view.toggle-right-rail': vi.fn(),
      'view.toggle-terminal': vi.fn(),
      'view.toggle-browser': vi.fn(),
      'help.shortcuts': vi.fn(),
    };

    const dispose = subscribeNativeMenuActions(handlers);
    await vi.waitFor(() => {
      expect(menuCb).toBeDefined();
    });

    menuCb?.({ payload: 'app.settings' });
    menuCb?.({ payload: 'file.new-task' });
    menuCb?.({ payload: 'file.open-folder' });
    menuCb?.({ payload: 'view.command-palette' });
    menuCb?.({ payload: 'view.mode-code' });
    menuCb?.({ payload: 'view.mode-work' });
    menuCb?.({ payload: 'view.toggle-sidebar' });
    menuCb?.({ payload: 'view.toggle-right-rail' });
    menuCb?.({ payload: 'view.toggle-terminal' });
    menuCb?.({ payload: 'view.toggle-browser' });
    menuCb?.({ payload: 'help.shortcuts' });
    menuCb?.({ payload: 'unknown.action' });
    menuCb?.({ payload: 'toString' });
    menuCb?.({ payload: 42 });

    expect(handlers['app.settings']).toHaveBeenCalledTimes(1);
    expect(handlers['file.new-task']).toHaveBeenCalledTimes(1);
    expect(handlers['file.open-folder']).toHaveBeenCalledTimes(1);
    expect(handlers['view.command-palette']).toHaveBeenCalledTimes(1);
    expect(handlers['view.mode-code']).toHaveBeenCalledTimes(1);
    expect(handlers['view.mode-work']).toHaveBeenCalledTimes(1);
    expect(handlers['view.toggle-sidebar']).toHaveBeenCalledTimes(1);
    expect(handlers['view.toggle-right-rail']).toHaveBeenCalledTimes(1);
    expect(handlers['view.toggle-terminal']).toHaveBeenCalledTimes(1);
    expect(handlers['view.toggle-browser']).toHaveBeenCalledTimes(1);
    expect(handlers['help.shortcuts']).toHaveBeenCalledTimes(1);

    dispose();
    expect(unlistenMenu).toHaveBeenCalledTimes(1);
  });

  it('syncs native window title, zoom, dock attention, context menu, and finder helpers on macOS', async () => {
    setTauriGlobal(true);
    restoreNav = mockNavigator('MacIntel');

    await syncNativeWindowTitle('  Task 1 — Trylo  ');
    await syncNativeWindowTitle('Task 1 — Trylo');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('set_native_window_title', {
      title: 'Task 1 — Trylo',
    });

    await toggleNativeWindowZoom();
    expect(mocks.invoke).toHaveBeenCalledWith('toggle_window_zoom');

    await syncNativeDockAttention({ badgeCount: 2, bounce: true });
    await syncNativeDockAttention({ badgeCount: 2, bounce: false });
    await syncNativeDockAttention({ badgeCount: 0, bounce: false });
    expect(mocks.invoke).toHaveBeenCalledWith('set_dock_attention', {
      badgeCount: 2,
      bounce: true,
    });
    expect(mocks.invoke).toHaveBeenCalledWith('set_dock_attention', {
      badgeCount: null,
      bounce: false,
    });

    mocks.invoke.mockResolvedValueOnce('rename');
    const selected = await showNativeContextMenu([{ id: 'rename', label: '重命名' }]);
    expect(selected).toBe('rename');
    expect(mocks.invoke).toHaveBeenCalledWith('show_native_context_menu', {
      items: [{ id: 'rename', label: '重命名' }],
    });

    await revealWorkspaceDirectory('/repo');
    await showWorkspaceEntryInFinder('/repo/a.ts', '/repo');
    await openWorkspaceEntryWithDefaultApp('/repo/a.ts', '/repo');
    await copyTextToNativeClipboard('/repo/a.ts');
    expect(mocks.invoke).toHaveBeenCalledWith('reveal_workspace_directory', { path: '/repo' });
    expect(mocks.invoke).toHaveBeenCalledWith('work_host_show_in_folder', {
      filePath: '/repo/a.ts',
      allowedRoot: '/repo',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('work_host_open_file', {
      filePath: '/repo/a.ts',
      allowedRoot: '/repo',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('work_host_copy_to_clipboard', {
      text: '/repo/a.ts',
    });
  });

  it('distinguishes empty titlebar areas from interactive controls', () => {
    const header = document.createElement('header');
    const titleSpan = document.createElement('span');
    const btn = document.createElement('button');
    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    btn.appendChild(iconSvg);
    const noDrag = document.createElement('div');
    noDrag.setAttribute('data-tauri-drag-region', 'false');
    header.append(titleSpan, btn, noDrag);

    expect(isInteractiveTitlebarTarget(header)).toBe(false);
    expect(isInteractiveTitlebarTarget(titleSpan)).toBe(false);
    expect(isInteractiveTitlebarTarget(btn)).toBe(true);
    expect(isInteractiveTitlebarTarget(iconSvg)).toBe(true);
    expect(isInteractiveTitlebarTarget(noDrag)).toBe(true);
  });
});

describe('appearance-store macOS default and native theme sync', () => {
  it('defaults to system on macOS, light on Windows, and syncs native window theme on init/set/storage', async () => {
    setTauriGlobal(true);
    restoreNav = mockNavigator('MacIntel');
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    vi.resetModules();
    const macStore = await import('../settings/appearance-store');
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('set_window_theme', { theme: null });
    });
    expect(document.documentElement.dataset.theme).toBe('dark');

    macStore.setAppearance('light');
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('set_window_theme', { theme: 'light' });
    });
    expect(document.documentElement.dataset.theme).toBe('light');

    window.dispatchEvent(new StorageEvent('storage', { key: 'trylo.appearance.v1', newValue: 'system' }));
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenLastCalledWith('set_window_theme', { theme: null });
    });
    expect(document.documentElement.dataset.theme).toBe('dark');

    macStore.refreshSystemAppearance('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    restoreNav();
    restoreNav = mockNavigator('Win32');
    localStorage.clear();
    mocks.invoke.mockClear();
    vi.resetModules();

    await import('../settings/appearance-store');
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('set_window_theme', { theme: 'light' });
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
