import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationSession } from '../../host-adapter/conversation-history';
import type { FilePath } from '../../host-adapter/types';
import { LeftRail } from './LeftRail';

vi.mock('./WorkspaceTree', () => ({
  WorkspaceTree: () => <div data-testid="workspace-tree" />,
}));

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
