import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  DEFAULT_LEFT_RAIL_WIDTH,
  DEFAULT_RIGHT_RAIL_WIDTH,
  DEFAULT_RIGHT_RAIL_WIDE_WIDTH,
} from './AppShell';
import type { RightRailReview } from './RightRail';
import { settingsDefaults } from '../../settings/settings-store';
import { CollaborationSwitch } from '../../surfaces/CollaborationSwitch';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { TopLevelMode } from '../../host-adapter/types';
import { ServiceManager } from '../../services-host/service-manager';
import { createToolingFacade } from '../../tooling/tooling-facade';
import type { CollaborationSurface } from '../../surfaces/types';

const shellMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: shellMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('../../monaco-init', () => ({ initMonaco: async () => undefined }));
vi.mock('./SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('./RemotePairingModal', () => ({ RemotePairingModal: () => null }));
vi.mock('./RightRail', () => ({ RightRail: () => null }));
vi.mock('./WorkspaceTree', () => ({ WorkspaceTree: () => <div data-testid="workspace-tree" /> }));
vi.mock('../../user-profile/profile-store', () => ({
  userProfileStore: {
    load: () => new Promise<never>(() => undefined),
    save: () => new Promise<never>(() => undefined),
    importAvatar: () => new Promise<never>(() => undefined),
    pickImage: () => new Promise<never>(() => undefined),
  },
}));

const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function mockPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  };
}

function setTauriGlobal(enabled: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (enabled) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

let restorePlatform: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  shellMocks.invoke.mockResolvedValue(undefined);
  setTauriGlobal(false);
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  setTauriGlobal(false);
  restorePlatform?.();
  restorePlatform = undefined;
  globalThis.ResizeObserver = originalResizeObserver;
});

interface RenderShellOptions {
  readonly topMode: TopLevelMode;
  readonly leftRailCollapsed?: boolean;
  readonly sessions?: readonly ConversationSession[];
  readonly onTopModeChange?: (mode: TopLevelMode) => void;
  readonly onToggleLeftRail?: () => void;
  readonly onArchiveSession?: (id: string) => void;
  readonly shellActionsRef?: {
    current: { readonly toggleTerminal: () => void; readonly toggleBrowserSidebar: () => void } | null;
  };
  readonly rightRailOpen?: boolean;
  readonly rightWidth?: number;
  readonly resultReview?: RightRailReview;
  readonly peekFile?: { readonly path: string; readonly content: string } | null;
  readonly collaborationSurface?: CollaborationSurface;
  readonly onCollaborationChange?: (surface: CollaborationSurface) => void;
  readonly settingsOpen?: boolean;
  readonly toolingFacade?: ReturnType<typeof createToolingFacade>;
  readonly serviceManager?: ServiceManager;
  readonly onSettingsOpenChange?: (open: boolean) => void;
}

function renderShell(options: RenderShellOptions) {
  return render(
    <AppShell
      workspaces={[{ id: 'ws-1', name: 'Trylo', root: '/tmp/trylo' }]}
      currentWorkspaceId="ws-1"
      sessions={options.sessions ?? []}
      activeSessionId={options.sessions?.[0]?.id ?? null}
      runningSessionIds={new Set()}
      leftRailCollapsed={options.leftRailCollapsed ?? true}
      onToggleLeftRail={options.onToggleLeftRail ?? vi.fn()}
      onSwitchWorkspace={vi.fn()}
      onOpenFolder={vi.fn()}
      onCloseWorkspace={vi.fn()}
      onSelectSession={vi.fn()}
      onNewSession={vi.fn()}
      onDeleteSession={vi.fn()}
      onRenameSession={vi.fn()}
      toolingFacade={options.toolingFacade}
      serviceManager={options.serviceManager}
      onArchiveSession={options.onArchiveSession ?? vi.fn()}
      onUnarchiveSession={vi.fn()}
      topMode={options.topMode}
      onTopModeChange={options.onTopModeChange}
      shellActionsRef={options.shellActionsRef}
      topBarCollaborationSwitch={
        options.onCollaborationChange ? (
          <CollaborationSwitch
            value={options.collaborationSurface ?? 'person'}
            onChange={options.onCollaborationChange}
            onCompose={vi.fn()}
          />
        ) : undefined
      }
      settings={settingsDefaults}
      fileTreeRoot="/tmp/trylo"
      rightRailOpen={options.rightRailOpen ?? false}
      onToggleRightRail={vi.fn()}
      leftWidth={DEFAULT_LEFT_RAIL_WIDTH}
      onLeftWidthChange={vi.fn()}
      rightWidth={options.rightWidth ?? DEFAULT_RIGHT_RAIL_WIDTH}
      onRightWidthChange={vi.fn()}
      resultReview={options.resultReview}
      peekFile={options.peekFile}
      onClosePeek={options.peekFile ? vi.fn() : undefined}
      settingsOpen={options.settingsOpen ?? false}
      onSettingsOpenChange={options.onSettingsOpenChange ?? vi.fn()}
      onSettingsSave={vi.fn()}
      remotePairingOpen={false}
      onRemotePairingOpenChange={vi.fn()}
    >
      <div>body</div>
    </AppShell>,
  );
}

describe('AppShell macOS capability parity (Code & Work)', () => {
  it.each(['code', 'work'] as const)('opens the manual live-window picker from %s', async mode => {
    restorePlatform = mockPlatform('MacIntel');
    setTauriGlobal(true);
    const manager = new ServiceManager({ invoke: shellMocks.invoke, listen: async () => () => {} });
    const ensureReady = vi.fn().mockResolvedValue(undefined);
    renderShell({
      topMode: mode, serviceManager: manager,
      toolingFacade: createToolingFacade(manager.client, { ensureReady }),
      sessions: [{ id: `${mode}-preview`, kind: mode, title: 'Preview fixture',
        mode: mode === 'code' ? 'agent' : 'office', createdAt: 100, updatedAt: 200, turnCount: 0 }],
    });
    expect(shellMocks.invoke).not.toHaveBeenCalledWith('computer_preview_open', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '实时窗口预览' }));
    await waitFor(() => expect(shellMocks.invoke).toHaveBeenCalledWith('computer_preview_open', { automatic: false }));
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });

  it.each(['code', 'work'] as const)(
    'hides Windows-only 软件工作区 and 电脑悬浮窗 on macOS in %s mode while keeping 浏览器侧栏',
    (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      renderShell({ topMode: mode });
      expect(screen.queryByRole('button', { name: '软件工作区' })).toBeNull();
      expect(screen.queryByRole('button', { name: /电脑悬浮窗/ })).toBeNull();
      expect(screen.getByRole('button', { name: '浏览器侧栏' })).toBeVisible();
    },
  );

  it.each(['code', 'work'] as const)(
    'retains 软件工作区 and 电脑悬浮窗 on Windows in %s mode without macOS drag attributes',
    (mode) => {
      restorePlatform = mockPlatform('Win32');
      const { container } = renderShell({
        topMode: mode,
        leftRailCollapsed: false,
        onTopModeChange: vi.fn(),
        onCollaborationChange: vi.fn(),
      });
      expect(screen.getByRole('button', { name: '软件工作区' })).toBeVisible();
      expect(screen.getByRole('button', { name: '电脑悬浮窗' })).toBeVisible();
      expect(screen.getByRole('button', { name: '浏览器侧栏' })).toBeVisible();

      expect(container.querySelector('.left-rail__header')).not.toHaveAttribute('data-tauri-drag-region');
      expect(container.querySelector('.top-bar')).not.toHaveAttribute('data-tauri-drag-region');
      expect(container.querySelector('.left-rail__brand .trilo-mark--chip')).toHaveStyle({ width: '40px' });
    },
  );

  it.each(['code', 'work'] as const)(
    'keeps fixed toggle slot, drag regions, and Code | Work switcher synchronized in %s mode on macOS',
    (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      const onTopModeChange = vi.fn();
      const onToggleLeftRail = vi.fn();

      const expanded = renderShell({
        topMode: mode,
        leftRailCollapsed: false,
        onTopModeChange,
        onToggleLeftRail,
      });

      const railHeader = expanded.container.querySelector('.left-rail__header')!;
      const collapseBtn = screen.getByRole('button', { name: 'Collapse rail' });
      const brand = expanded.container.querySelector('.left-rail__brand[data-startup-logo]') as HTMLElement;
      expect(railHeader).toHaveAttribute('data-tauri-drag-region', '');
      expect(railHeader.firstElementChild).toBe(collapseBtn);
      expect(collapseBtn).toHaveAttribute('data-tauri-drag-region', 'false');
      expect(brand.querySelector('.trilo-mark--chip')).toHaveStyle({ width: '22px' });

      const expandedTopBar = expanded.container.querySelector('.top-bar')!;
      expect(expandedTopBar).toHaveAttribute('data-tauri-drag-region', '');
      expect(expandedTopBar).toHaveAttribute('data-rail-collapsed', 'false');

      const switcher = screen.getByRole('group', { name: '工作模式' });
      expect(switcher).toBeVisible();
      const codeBtn = screen.getByRole('button', { name: 'Code' });
      const workBtn = screen.getByRole('button', { name: 'Work' });
      expect(codeBtn).toHaveAttribute('aria-pressed', mode === 'code' ? 'true' : 'false');
      expect(workBtn).toHaveAttribute('aria-pressed', mode === 'work' ? 'true' : 'false');
      expect(codeBtn).toHaveAttribute('data-tauri-drag-region', 'false');
      expect(workBtn).toHaveAttribute('data-tauri-drag-region', 'false');
      expect(screen.getByRole('button', { name: '浏览器侧栏' })).toHaveAttribute('data-tauri-drag-region', 'false');

      fireEvent.click(mode === 'code' ? workBtn : codeBtn);
      expect(onTopModeChange).toHaveBeenCalledWith(mode === 'code' ? 'work' : 'code');

      expanded.rerender(
        <AppShell
          workspaces={[{ id: 'ws-1', name: 'Trylo', root: '/tmp/trylo' }]}
          currentWorkspaceId="ws-1"
          sessions={[]}
          activeSessionId={null}
          runningSessionIds={new Set()}
          leftRailCollapsed
          onToggleLeftRail={onToggleLeftRail}
          onSwitchWorkspace={vi.fn()}
          onOpenFolder={vi.fn()}
          onCloseWorkspace={vi.fn()}
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onRenameSession={vi.fn()}
          onArchiveSession={vi.fn()}
          onUnarchiveSession={vi.fn()}
          topMode={mode}
          onTopModeChange={onTopModeChange}
          settings={settingsDefaults}
          fileTreeRoot="/tmp/trylo"
          rightRailOpen={false}
          onToggleRightRail={vi.fn()}
          leftWidth={256}
          onLeftWidthChange={vi.fn()}
          rightWidth={480}
          onRightWidthChange={vi.fn()}
          settingsOpen={false}
          onSettingsOpenChange={vi.fn()}
          onSettingsSave={vi.fn()}
          remotePairingOpen={false}
          onRemotePairingOpenChange={vi.fn()}
        >
          <div>body</div>
        </AppShell>,
      );

      expect(screen.queryByRole('button', { name: 'Collapse rail' })).toBeNull();
      const leftSlot = expanded.container.querySelector('.left-rail-slot')!;
      expect(leftSlot).toHaveAttribute('data-collapsed', 'true');
      expect(leftSlot).toHaveAttribute('aria-hidden', 'true');
      expect(leftSlot).toHaveAttribute('inert', '');
      const collapsedTopBar = expanded.container.querySelector('.top-bar')!;
      expect(collapsedTopBar).toHaveAttribute('data-rail-collapsed', 'true');
      const expandBtn = screen.getByRole('button', { name: 'Expand rail' });
      expect(expandBtn).toHaveAttribute('data-tauri-drag-region', 'false');
      fireEvent.click(expandBtn);
      expect(onToggleLeftRail).toHaveBeenCalledOnce();
    },
  );

  it.each(['code', 'work'] as const)(
    'toggles data-resizing on AppShell during RailResizer drag in %s mode',
    (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      const { container } = renderShell({ topMode: mode, leftRailCollapsed: false });
      const shell = container.querySelector('.app-shell')!;
      const resizer = screen.getByRole('separator', { name: 'Resize sidebar' });

      expect(shell).not.toHaveAttribute('data-resizing');
      fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientX: 256 });
      expect(shell).toHaveAttribute('data-resizing', 'true');
      expect(resizer).toHaveClass('rail-resizer--dragging');

      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(shell).not.toHaveAttribute('data-resizing');
      expect(resizer).not.toHaveClass('rail-resizer--dragging');
    },
  );

  it.each(['code', 'work'] as const)(
    'supports ArrowUp/ArrowDown/Home/End/Escape navigation on CollaborationSwitch in %s mode',
    (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      const onCollaborationChange = vi.fn();
      renderShell({
        topMode: mode,
        collaborationSurface: 'person',
        onCollaborationChange,
      });

      const trigger = screen.getByRole('button', { name: '协作方式' });
      expect(trigger).toHaveAttribute('data-tauri-drag-region', 'false');

      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      const menu = screen.getByRole('menu', { name: '协作方式' });
      expect(menu).toHaveAttribute('data-tauri-drag-region', 'false');

      const personItem = screen.getByRole('menuitemradio', { name: '个人对话' });
      const teamItem = screen.getByRole('menuitemradio', { name: '团队协作' });
      const composeItem = screen.getByRole('menuitem', { name: '用团队做这件事' });
      expect(personItem).toHaveFocus();

      fireEvent.keyDown(personItem, { key: 'ArrowDown' });
      expect(teamItem).toHaveFocus();

      fireEvent.keyDown(teamItem, { key: 'End' });
      expect(composeItem).toHaveFocus();

      fireEvent.keyDown(composeItem, { key: 'ArrowDown' });
      expect(personItem).toHaveFocus();

      fireEvent.keyDown(personItem, { key: 'ArrowUp' });
      expect(composeItem).toHaveFocus();

      fireEvent.keyDown(composeItem, { key: 'Home' });
      expect(personItem).toHaveFocus();

      fireEvent.keyDown(personItem, { key: 'ArrowDown' });
      fireEvent.click(teamItem);
      expect(onCollaborationChange).toHaveBeenCalledWith('team');
      expect(screen.queryByRole('menu', { name: '协作方式' })).toBeNull();
      expect(trigger).toHaveFocus();

      fireEvent.keyDown(trigger, { key: 'ArrowUp' });
      expect(screen.getByRole('menuitem', { name: '用团队做这件事' })).toHaveFocus();
      fireEvent.keyDown(screen.getByRole('menu', { name: '协作方式' }), { key: 'Escape' });
      expect(screen.queryByRole('menu', { name: '协作方式' })).toBeNull();
      expect(trigger).toHaveFocus();
    },
  );

  it.each(['code', 'work'] as const)(
    'supports titlebar double-click zoom, shortcut tooltips, and session context menu in %s mode on macOS',
    async (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      setTauriGlobal(true);
      const onArchiveSession = vi.fn();
      const shellActionsRef = { current: null as { toggleTerminal: () => void; toggleBrowserSidebar: () => void } | null };

      const sessions: ConversationSession[] = [
        {
          id: `${mode}-1`,
          kind: mode,
          title: `${mode} session`,
          mode: mode === 'code' ? 'agent' : 'office',
          ...(mode === 'code' ? { codeMode: 'agent' as const } : {}),
          createdAt: 100,
          updatedAt: 200,
          turnCount: 1,
        },
      ];

      const { container } = renderShell({
        topMode: mode,
        leftRailCollapsed: false,
        sessions,
        onArchiveSession,
        shellActionsRef,
      });

      expect(screen.getByRole('button', { name: 'Collapse rail' })).toHaveAttribute('title', '收起侧栏 ⌘B');
      expect(screen.getByRole('button', { name: '新任务' })).toHaveAttribute('title', '新任务 ⌘N');
      expect(screen.getByRole('button', { name: '打开项目' })).toHaveAttribute('title', '打开项目 ⌘O');
      expect(screen.getByRole('button', { name: '设置' })).toHaveAttribute('title', '设置 ⌘,');
      expect(screen.getByRole('button', { name: '集成终端' })).toHaveAttribute('title', '集成终端 ⌃`');
      expect(screen.getByRole('button', { name: '浏览器侧栏' })).toHaveAttribute('title', '浏览器侧栏 ⌥⌘B');

      const topBar = container.querySelector('.top-bar') as HTMLElement;
      fireEvent.doubleClick(topBar);
      await vi.waitFor(() => {
        expect(shellMocks.invoke).toHaveBeenCalledWith('toggle_window_zoom');
      });

      shellMocks.invoke.mockClear();
      fireEvent.doubleClick(screen.getByRole('button', { name: '浏览器侧栏' }));
      expect(shellMocks.invoke).not.toHaveBeenCalledWith('toggle_window_zoom');

      shellMocks.invoke.mockResolvedValueOnce('archive');
      const sessionRow = container.querySelector('.session-row') as HTMLElement;
      expect(sessionRow).toHaveTextContent(`${mode} session`);
      fireEvent.contextMenu(sessionRow);
      await vi.waitFor(() => {
        expect(shellMocks.invoke).toHaveBeenCalledWith('show_native_context_menu', {
          items: [
            { id: 'rename', label: '重命名', enabled: true },
            { id: 'archive', label: '归档', enabled: true },
            { id: 'sep-1', label: '', separator: true },
            { id: 'delete', label: '删除', enabled: true },
          ],
        });
        expect(onArchiveSession).toHaveBeenCalledWith(`${mode}-1`);
      });

      expect(shellActionsRef.current).not.toBeNull();
    },
  );

  it.each(['code', 'work'] as const)(
    'applies balanced 240/320 rail defaults and expands right rail to 480px for preview or review in %s mode',
    (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      const originalInnerWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });

      try {
        expect(DEFAULT_LEFT_RAIL_WIDTH).toBe(240);
        expect(DEFAULT_RIGHT_RAIL_WIDTH).toBe(320);
        expect(DEFAULT_RIGHT_RAIL_WIDE_WIDTH).toBe(480);

        const filesView = renderShell({
          topMode: mode,
          leftRailCollapsed: false,
          rightRailOpen: true,
        });
        const filesShell = filesView.container.querySelector('.app-shell') as HTMLElement;
        const filesSlot = filesView.container.querySelector('.right-rail-slot') as HTMLElement;
        expect(filesShell.style.getPropertyValue('--rail-left-w')).toBe('240px');
        expect(filesShell.style.getPropertyValue('--rail-right-w')).toBe('320px');
        expect(filesSlot).toHaveAttribute('data-wide', 'false');
        filesView.unmount();

        const wideView = renderShell({
          topMode: mode,
          leftRailCollapsed: false,
          rightRailOpen: true,
          resultReview: {
            id: `${mode}-review`,
            open: true,
            content: <div>review</div>,
            onOpenChange: vi.fn(),
          },
        });
        const wideShell = wideView.container.querySelector('.app-shell') as HTMLElement;
        const wideSlot = wideView.container.querySelector('.right-rail-slot') as HTMLElement;
        expect(wideShell.style.getPropertyValue('--rail-right-w')).toBe('480px');
        expect(wideSlot).toHaveAttribute('data-wide', 'true');
      } finally {
        Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
      }
    },
  );

  it.each(['code', 'work'] as const)(
    'propagates data-settings-open and opens settings from the left rail identically in %s mode on macOS',
    (mode) => {
      restorePlatform = mockPlatform('MacIntel');
      const onSettingsOpenChange = vi.fn();
      const closedView = renderShell({
        topMode: mode,
        leftRailCollapsed: false,
        settingsOpen: false,
        onSettingsOpenChange,
      });

      const closedShell = closedView.container.querySelector('.app-shell') as HTMLElement;
      expect(closedShell).not.toHaveAttribute('data-settings-open');
      fireEvent.click(screen.getByRole('button', { name: '设置' }));
      expect(onSettingsOpenChange).toHaveBeenCalledWith(true);
      closedView.unmount();

      const openView = renderShell({
        topMode: mode,
        settingsOpen: true,
        onSettingsOpenChange,
      });
      const openShell = openView.container.querySelector('.app-shell') as HTMLElement;
      expect(openShell).toHaveAttribute('data-settings-open', 'true');
    },
  );
});
