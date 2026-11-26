import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { FilePath } from '../../host-adapter/types';
import { LeftRail } from './LeftRail';

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
    const toggle = screen.getByRole('button', { name: /archived/i });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('LeftRail profile row', () => {
  function setupRail(): { onOpenSettings: Mock } {
    const onOpenSettings = vi.fn();
    render(
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
    return { onOpenSettings };
  }

  it('shows the workspace label and settings hint while closed', () => {
    setupRail();
    expect(screen.getByText('本地工作区')).toBeInTheDocument();
    expect(screen.getByText('设置与连接')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '用户资料' })).toBeNull();
  });

  it('opens the profile card when the row is clicked', () => {
    const { onOpenSettings } = setupRail();
    fireEvent.click(screen.getByRole('button', { name: '用户资料' }));
    expect(screen.getByRole('dialog', { name: '用户资料' })).toBeInTheDocument();
    // The card swaps the row labels to the profile identity.
    expect(screen.getByText('用户资料')).toBeInTheDocument();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('opens settings directly from the gear without opening the card', () => {
    const { onOpenSettings } = setupRail();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: '用户资料' })).toBeNull();
  });

  it('toggles the card closed when the row is clicked again', () => {
    setupRail();
    fireEvent.click(screen.getByRole('button', { name: '用户资料' }));
    expect(screen.getByRole('dialog', { name: '用户资料' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用户资料' }));
    expect(screen.queryByRole('dialog', { name: '用户资料' })).toBeNull();
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
