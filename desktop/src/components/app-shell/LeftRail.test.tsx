import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { FilePath } from '../../host-adapter/types';
import type { LearningPort } from '../../learning/learning-port';
import type { ActivityItem } from '../activity/BackgroundActivityCenter';
import { LeftRail } from './LeftRail';
import { ToastHost } from '../feedback/ToastHost';
import { clearToasts } from '../feedback/toast-store';

vi.mock('./WorkspaceTree', () => ({
  WorkspaceTree: () => <div data-testid="workspace-tree" />,
}));

// The profile store never resolves in these wiring tests: the row
// renders its closed-state labels from the hook's initial state,
// and no async setState lands outside act(). The store itself is
// covered by user-profile/profile-store.test.ts.
vi.mock('../../user-profile/profile-store', () => ({
  userProfileStore: {
    load: () => new Promise<never>(() => undefined),
    save: () => new Promise<never>(() => undefined),
    importAvatar: () => new Promise<never>(() => undefined),
    pickImage: () => new Promise<never>(() => undefined),
  },
}));

function mockPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  };
}

let restorePlatform: (() => void) | undefined;

afterEach(() => {
  window.localStorage.clear();
  clearToasts();
  cleanup();
  restorePlatform?.();
  restorePlatform = undefined;
});

function session(
  id: string,
  kind: 'code' | 'work',
  updatedAt: number,
  archivedAt?: number,
  title?: string,
): ConversationSession {
  return {
    id,
    kind,
    title: title ?? (kind === 'code' ? 'Fix persistence' : 'Draft report'),
    mode: kind === 'code' ? 'agent' : 'office',
    ...(kind === 'code' ? { codeMode: 'agent' as const } : {}),
    createdAt: updatedAt - 10,
    updatedAt,
    turnCount: 2,
    ...(archivedAt !== undefined ? { archivedAt } : {}),
  };
}

describe('LeftRail project conversations', () => {
  it('shows Code and Work rows in the same workspace session list with their kind icons', () => {
    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100), session('work-1', 'work', 200)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    // 2026-09-06: the C / W letter tile is gone — the row's kind is
    // marked with a lucide icon inside `data-kind` container. There
    // is one row per kind and both titles render together.
    const rows = screen.getAllByRole('listitem');
    const kinds = rows
      .filter((row) => row.getAttribute('data-kind') === 'code' || row.getAttribute('data-kind') === 'work')
      .map((row) => row.getAttribute('data-kind'));
    expect(kinds).toEqual(expect.arrayContaining(['code', 'work']));
    expect(screen.getByText('Fix persistence')).toBeInTheDocument();
    expect(screen.getByText('Draft report')).toBeInTheDocument();
  });

  it('selects the clicked conversation regardless of kind', () => {
    const onSelectSession = vi.fn();
    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100), session('work-1', 'work', 200)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={onSelectSession}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Draft report'));
    expect(onSelectSession).toHaveBeenCalledWith('work-1');
  });

  it('hides archived conversations behind a disclosure with a count badge', () => {
    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[
          session('code-1', 'code', 100, undefined, 'Fix persistence'),
          session('work-1', 'work', 200, undefined, 'Draft report'),
          session('code-2', 'code', 50, 1, 'Old draft'),
        ]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    // Live rows render in the active list immediately.
    expect(screen.getByText('Fix persistence')).toBeInTheDocument();
    expect(screen.getByText('Draft report')).toBeInTheDocument();
    // The archived row hides its title by default and only shows up
    // under the disclosure toggle (initially collapsed).
    expect(screen.queryByText('Old draft')).toBeNull();
    const toggle = screen.getByRole('button', { name: /已归档/ });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('LeftRail profile dock controls', () => {
  function setupRail(): { onOpenSettings: Mock; container: HTMLElement } {
    const onOpenSettings = vi.fn();
    const { container } = render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );
    return { onOpenSettings, container };
  }

  it('places compact avatar and settings buttons inside the far-left icon dock', () => {
    const { container } = setupRail();
    const dock = container.querySelector('.left-rail__dock');
    expect(dock).not.toBeNull();
    expect(dock).toContainElement(screen.getByRole('button', { name: '用户资料' }));
    expect(dock).toContainElement(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByRole('dialog', { name: '用户资料' })).toBeNull();
  });

  it('opens the profile card when the avatar icon is clicked', () => {
    const { onOpenSettings } = setupRail();
    fireEvent.click(screen.getByRole('button', { name: '用户资料' }));
    expect(screen.getByRole('dialog', { name: '用户资料' })).toBeInTheDocument();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('opens settings directly from the dock settings button without opening the card', () => {
    const { onOpenSettings } = setupRail();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: '用户资料' })).toBeNull();
  });

  it('toggles the card closed when the avatar icon is clicked again', () => {
    setupRail();
    fireEvent.click(screen.getByRole('button', { name: '用户资料' }));
    expect(screen.getByRole('dialog', { name: '用户资料' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用户资料' }));
    expect(screen.queryByRole('dialog', { name: '用户资料' })).toBeNull();
  });
});

describe('LeftRail split icon dock, categories, search & pinning', () => {
  it('renders all 7 icon dock controls, tracks active state, and dispatches handlers', () => {
    const onGoHome = vi.fn();
    const onOpenActivity = vi.fn();
    const onOpenTools = vi.fn();
    const onOpenLearning = vi.fn();
    const onOpenRemote = vi.fn();
    const onOpenSettings = vi.fn();

    const { container, rerender } = render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
        onGoHome={onGoHome}
        onOpenActivity={onOpenActivity}
        activeRuns={3}
        onOpenTools={onOpenTools}
        onOpenLearning={onOpenLearning}
        onOpenRemote={onOpenRemote}
        remoteRunning
        onOpenSettings={onOpenSettings}
      />,
    );

    const dockGroup = container.querySelector('.left-rail__dock-group')!;
    const dockFooter = container.querySelector('.left-rail__dock-footer')!;
    const homeBtn = screen.getByRole('button', { name: '主页' });
    const activityBtn = screen.getByRole('button', { name: '运行中的任务' });
    const toolsBtn = screen.getByRole('button', { name: '工具与技能' });
    const learningBtn = screen.getByRole('button', { name: '学习与偏好' });
    const remoteBtn = screen.getByRole('button', { name: '远程连接' });
    const settingsBtn = screen.getByRole('button', { name: '设置' });
    const profileBtn = screen.getByRole('button', { name: '用户资料' });

    for (const btn of [homeBtn, activityBtn, toolsBtn]) {
      expect(dockGroup).toContainElement(btn);
    }
    for (const btn of [learningBtn, remoteBtn, settingsBtn, profileBtn]) {
      expect(dockFooter).toContainElement(btn);
    }
    expect(learningBtn.compareDocumentPosition(settingsBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(remoteBtn.compareDocumentPosition(settingsBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(homeBtn).toHaveAttribute('aria-current', 'page');
    expect(activityBtn).toHaveTextContent('3');
    expect(remoteBtn.querySelector('.left-rail__online')).not.toBeNull();

    fireEvent.click(homeBtn);
    fireEvent.click(activityBtn);
    fireEvent.click(toolsBtn);
    fireEvent.click(learningBtn);
    fireEvent.click(remoteBtn);
    fireEvent.click(settingsBtn);

    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
    expect(onOpenTools).toHaveBeenCalledTimes(1);
    expect(onOpenLearning).toHaveBeenCalledTimes(1);
    expect(onOpenRemote).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    rerender(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
        onGoHome={onGoHome}
        onOpenActivity={onOpenActivity}
        onOpenTools={onOpenTools}
        toolsOpen
        onOpenLearning={onOpenLearning}
        onOpenRemote={onOpenRemote}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByRole('button', { name: '主页' })).not.toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '工具与技能' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters sessions by category and recovers via 清除筛选', () => {
    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[
          session('code-1', 'code', 100, undefined, 'Fix persistence'),
          session('work-1', 'work', 200, undefined, 'Draft report'),
        ]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>(['code-1'])}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '筛选分类' }));
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));

    expect(screen.queryByText('Fix persistence')).toBeNull();
    expect(screen.getByText('Draft report')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '运行中' }));
    expect(screen.getByText('Fix persistence')).toBeInTheDocument();
    expect(screen.queryByText('Draft report')).toBeNull();

    // Search inside Running filter produces empty filtered state with one-click reset.
    fireEvent.click(screen.getByRole('button', { name: '搜索项目与任务' }));
    const searchInput = screen.getByRole('searchbox', { name: '搜索项目或任务' });
    fireEvent.change(searchInput, { target: { value: 'nonexistent-query' } });
    expect(screen.getByText('没有匹配的项目或对话')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('Fix persistence')).toBeInTheDocument();
    expect(screen.getByText('Draft report')).toBeInTheDocument();
  });

  it('searches sessions, closes on Escape, and resets on 主页 click', () => {
    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[
          session('code-1', 'code', 100, undefined, 'Fix persistence'),
          session('work-1', 'work', 200, undefined, 'Draft report'),
        ]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '搜索项目与任务' }));
    const input = screen.getByRole('searchbox', { name: '搜索项目或任务' });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: 'Draft' } });
    expect(screen.getByText('Draft report')).toBeInTheDocument();
    expect(screen.queryByText('Fix persistence')).toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: '搜索项目或任务' })).toBeNull();
    expect(screen.getByText('Fix persistence')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '搜索项目与任务' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索项目或任务' }), {
      target: { value: 'Fix' },
    });
    expect(screen.queryByText('Draft report')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '主页' }));
    expect(screen.queryByRole('searchbox', { name: '搜索项目或任务' })).toBeNull();
    expect(screen.getByText('Draft report')).toBeInTheDocument();
  });

  it('pins and unpins sessions into 置顶 without duplicating them in the project list', () => {
    const { container } = render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[
          session('code-1', 'code', 100, undefined, 'Fix persistence'),
          session('work-1', 'work', 200, undefined, 'Draft report'),
        ]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.queryByText('置顶')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pin Fix persistence' }));
    expect(screen.getByText('置顶')).toBeInTheDocument();
    expect(screen.getAllByText('Fix persistence')).toHaveLength(1);
    expect(container.querySelector('.left-rail__sessions--pinned')).toHaveTextContent('Fix persistence');

    fireEvent.click(screen.getByRole('button', { name: 'Unpin Fix persistence' }));
    expect(screen.queryByText('置顶')).toBeNull();
    expect(screen.getAllByText('Fix persistence')).toHaveLength(1);
  });

  it('switches the right pane to inline 运行中的任务 and handles jump, stop, and error recovery', async () => {
    const onJump = vi.fn();
    let rejectStop!: (err: Error) => void;
    const onStop = vi.fn(() => new Promise<void>((_res, fail) => {
      rejectStop = fail;
    }));
    const item: ActivityItem = {
      id: 'run-1',
      kind: 'work',
      conversationId: 'work-1',
      workspaceLabel: 'project',
      title: '生成季度总结',
      statusLabel: 'Running',
      startedAt: Date.now() - 12000,
      onJump,
      onStop,
    };

    const { rerender } = render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('work-1', 'work', 200, undefined, '生成季度总结')]}
        activeSessionId="work-1"
        collapsed={false}
        runningSessionIds={new Set<string>(['work-1'])}
        activityItems={[]}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '运行中的任务' }));
    expect(screen.getByText('当前没有运行中的任务')).toBeInTheDocument();

    rerender(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('work-1', 'work', 200, undefined, '生成季度总结')]}
        activeSessionId="work-1"
        collapsed={false}
        runningSessionIds={new Set<string>(['work-1'])}
        activityItems={[item]}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    expect(screen.getByRole('list', { name: '运行任务列表' })).toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '停止任务：生成季度总结' }));
    expect(onStop).toHaveBeenCalledTimes(1);
    rejectStop(new Error('停止超时'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('停止超时'));

    fireEvent.click(screen.getByRole('button', { name: '返回会话：生成季度总结' }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '新任务' })).toBeInTheDocument();
  });

  it('switches the right pane to inline 工具与技能, loads skills, and opens full settings on request', async () => {
    const onOpenToolsSettings = vi.fn();
    const skillsMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        skills: [{ name: 'office-report', category: '办公', description: '生成标准化报告' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        content: '# Office Report\nUse clean tables.',
      });
    const learningPort = {
      skills: skillsMock,
    } as unknown as LearningPort;

    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        learningPort={learningPort}
        onOpenToolsSettings={onOpenToolsSettings}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '工具与技能' }));
    expect(screen.getByRole('list', { name: '工具目录' })).toBeInTheDocument();
    expect(screen.getByText('OfficeCLI')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开完整工具设置' }));
    expect(onOpenToolsSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: /技能/ }));
    await waitFor(() => expect(screen.getByText('office-report')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /office-report/ }));
    await waitFor(() => expect(screen.getByText(/Use clean tables\./)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '主页' }));
    expect(screen.getByRole('button', { name: '新任务' })).toBeInTheDocument();
  });
});

describe('LeftRail macOS unified header & platform isolation', () => {
  it('places the collapse button before the compact 22px brand on macOS with drag regions', () => {
    restorePlatform = mockPlatform('MacIntel');
    const { container } = render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: '/tmp/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100), session('work-1', 'work', 200)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    const header = container.querySelector('.left-rail__header')!;
    const collapseBtn = screen.getByRole('button', { name: 'Collapse rail' });
    const brand = container.querySelector('.left-rail__brand[data-startup-logo]') as HTMLElement;
    const chip = brand.querySelector('.trilo-mark--chip') as HTMLElement;

    expect(header).toHaveAttribute('data-tauri-drag-region', '');
    expect(collapseBtn).toHaveAttribute('data-tauri-drag-region', 'false');
    expect(brand).toHaveAttribute('data-tauri-drag-region', '');
    expect(chip.style.width).toBe('22px');
    expect(header.firstElementChild).toBe(collapseBtn);
    expect(collapseBtn.compareDocumentPosition(brand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Fix persistence')).toBeInTheDocument();
    expect(screen.getByText('Draft report')).toBeInTheDocument();
  });

  it('retains the original brand-first 40px header layout without drag regions on Windows', () => {
    restorePlatform = mockPlatform('Win32');
    const { container } = render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100)]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    const header = container.querySelector('.left-rail__header')!;
    const collapseBtn = screen.getByRole('button', { name: 'Collapse rail' });
    const brand = container.querySelector('.left-rail__brand[data-startup-logo]') as HTMLElement;
    const chip = brand.querySelector('.trilo-mark--chip') as HTMLElement;

    expect(header).not.toHaveAttribute('data-tauri-drag-region');
    expect(collapseBtn).not.toHaveAttribute('data-tauri-drag-region');
    expect(chip.style.width).toBe('40px');
    expect(header.firstElementChild).toBe(brand);
  });
});

describe('LeftRail delete confirmation & archive undo', () => {
  it('requires confirmation before calling onDeleteSession and supports cancel', () => {
    const onDeleteSession = vi.fn();
    render(
      <LeftRail
        workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
        currentWorkspaceId="ws-1"
        sessions={[session('code-1', 'code', 100, undefined, 'Fix persistence')]}
        activeSessionId="code-1"
        collapsed={false}
        runningSessionIds={new Set<string>()}
        onSwitchWorkspace={vi.fn()}
        onOpenFolder={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onRenameSession={vi.fn()}
        onArchiveSession={vi.fn()}
        onUnarchiveSession={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    );

    const row = screen.getByText('Fix persistence').closest('li')!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Fix persistence' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('永久删除对话？');
    expect(onDeleteSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDeleteSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Fix persistence' }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    expect(onDeleteSession).toHaveBeenCalledWith('code-1');
  });

  it('pushes an undo toast on archive and calls onUnarchiveSession when undone', () => {
    const onArchiveSession = vi.fn();
    const onUnarchiveSession = vi.fn();
    render(
      <>
        <LeftRail
          workspaces={[{ id: 'ws-1', root: 'D:/project' as FilePath, name: 'project' }]}
          currentWorkspaceId="ws-1"
          sessions={[session('work-1', 'work', 200, undefined, 'Draft report')]}
          activeSessionId="work-1"
          collapsed={false}
          runningSessionIds={new Set<string>()}
          onSwitchWorkspace={vi.fn()}
          onOpenFolder={vi.fn()}
          onCloseWorkspace={vi.fn()}
          onSelectSession={vi.fn()}
          onNewSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onRenameSession={vi.fn()}
          onArchiveSession={onArchiveSession}
          onUnarchiveSession={onUnarchiveSession}
          onToggleCollapse={vi.fn()}
        />
        <ToastHost />
      </>,
    );

    const row = screen.getByText('Draft report').closest('li')!;
    fireEvent.mouseEnter(row);
    fireEvent.click(screen.getByRole('button', { name: 'Archive Draft report' }));

    expect(onArchiveSession).toHaveBeenCalledWith('work-1');
    expect(screen.getByRole('status')).toHaveTextContent('已归档「Draft report」');

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(onUnarchiveSession).toHaveBeenCalledWith('work-1');
  });
});
