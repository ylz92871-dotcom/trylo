import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { buildPaletteCommands } from './command-registry';
import { invalidateWorkspaceFileIndex } from './workspace-file-index';
import type { FilePath } from '../../host-adapter/types';
import type { WorkspaceEntry } from '../app-shell/LeftRail';

const listDirMock = vi.hoisted(() => vi.fn());

vi.mock('../../host-adapter', () => ({
  hostAdapter: {
    fs: {
      listDir: listDirMock,
    },
  },
}));

const WORKSPACES: readonly WorkspaceEntry[] = [
  { id: 'ws-1', root: '/tmp/proj', name: 'proj' },
  { id: 'ws-2', root: '/tmp/other', name: 'other' },
];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateWorkspaceFileIndex();
  listDirMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('CommandPalette (Trylo Spotlight)', () => {
  it('groups content and action items, shows disabled reasons, and never fires on step entry or highlight', async () => {
    const onSelectPool = vi.fn();
    const onSelectConfigured = vi.fn();
    const onArchiveSession = vi.fn();
    const onClose = vi.fn();

    const commands = buildPaletteCommands({
      topMode: 'code',
      onTopModeChange: vi.fn(),
      workspaces: WORKSPACES,
      currentWorkspaceId: 'ws-1',
      onSwitchWorkspace: vi.fn(),
      onOpenFolder: vi.fn(),
      sessions: [
        {
          id: 's-1',
          kind: 'code',
          title: '修复构建',
          mode: 'agent',
          createdAt: 1,
          updatedAt: 2,
          turnCount: 1,
        },
      ],
      activeSessionId: 's-1',
      runningSessionIds: new Set(['s-1']),
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      onArchiveSession,
      rightRailOpen: false,
      onToggleRightRail: vi.fn(),
      leftRailCollapsed: false,
      onToggleLeftRail: vi.fn(),
      browserOpen: false,
      onToggleBrowser: vi.fn(),
      terminalAvailable: false,
      terminalOpen: false,
      onToggleTerminal: vi.fn(),
      activityCount: 0,
      onOpenSettingsTab: vi.fn(),
      onOpenRemote: vi.fn(),
      appearancePreference: 'light',
      onSetAppearance: vi.fn(),
      host: {
        configuredModel: 'claude-sonnet',
        poolModel: 'gemini-free',
        onSelectConfigured,
        onSelectPool,
      },
    });

    render(<CommandPalette open={true} onClose={onClose} commands={commands} />);

    expect(screen.getByText('内容与文件')).toBeInTheDocument();
    expect(screen.getByText('可执行动作')).toBeInTheDocument();

    // Disabled command shows why and does not execute.
    const archiveOption = screen.getByRole('option', { name: /归档当前会话/ });
    expect(archiveOption).toHaveAttribute('aria-disabled', 'true');
    expect(archiveOption).toHaveTextContent('任务正在运行中，请先停止再归档');
    fireEvent.click(archiveOption);
    expect(onArchiveSession).not.toHaveBeenCalled();

    // Multi-step command enters step 2 without invoking model switch yet.
    fireEvent.click(screen.getByRole('option', { name: /切换当前模型/ }));
    expect(screen.getByText('切换当前模型')).toBeInTheDocument();
    expect(onSelectConfigured).not.toHaveBeenCalled();
    expect(onSelectPool).not.toHaveBeenCalled();

    // Highlight movement with arrows does not execute.
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onSelectConfigured).not.toHaveBeenCalled();
    expect(onSelectPool).not.toHaveBeenCalled();

    // Escape from step 2 returns to root instead of closing.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('内容与文件')).toBeInTheDocument();

    // Re-enter step 2 and confirm an option.
    fireEvent.click(screen.getByRole('option', { name: /切换当前模型/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /claude-sonnet/ }));
    });
    expect(onSelectConfigured).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('protects Chinese IME candidate confirmation from executing commands prematurely', async () => {
    const onNewSession = vi.fn();
    const onClose = vi.fn();
    const commands = buildPaletteCommands({
      topMode: 'work',
      workspaces: WORKSPACES,
      currentWorkspaceId: 'ws-1',
      onSwitchWorkspace: vi.fn(),
      onOpenFolder: vi.fn(),
      sessions: [],
      activeSessionId: null,
      runningSessionIds: new Set(),
      onSelectSession: vi.fn(),
      onNewSession,
      onArchiveSession: vi.fn(),
      rightRailOpen: false,
      onToggleRightRail: vi.fn(),
      leftRailCollapsed: false,
      onToggleLeftRail: vi.fn(),
      browserOpen: false,
      onToggleBrowser: vi.fn(),
      terminalAvailable: false,
      terminalOpen: false,
      onToggleTerminal: vi.fn(),
      activityCount: 0,
      onOpenSettingsTab: vi.fn(),
      onOpenRemote: vi.fn(),
      appearancePreference: 'light',
      onSetAppearance: vi.fn(),
    });

    render(<CommandPalette open={true} onClose={onClose} commands={commands} />);
    const input = screen.getByRole('combobox');

    // Simulate IME composition: Enter during composition or right at compositionend commits text only.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onNewSession).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '新建任务' } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNewSession).not.toHaveBeenCalled();

    // Explicit second Enter confirms the selected command.
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('isolates stale workspace file index responses and restores opener focus on Escape', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Trigger';
    document.body.appendChild(opener);
    opener.focus();

    let resolveSlow!: (entries: { name: string; path: FilePath; isDirectory: boolean }[]) => void;
    listDirMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );

    const onOpenFile = vi.fn();
    const onClose = vi.fn();
    const commands = buildPaletteCommands({
      topMode: 'code',
      workspaces: WORKSPACES,
      currentWorkspaceId: 'ws-1',
      onSwitchWorkspace: vi.fn(),
      onOpenFolder: vi.fn(),
      sessions: [],
      activeSessionId: null,
      runningSessionIds: new Set(),
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      onArchiveSession: vi.fn(),
      rightRailOpen: false,
      onToggleRightRail: vi.fn(),
      leftRailCollapsed: false,
      onToggleLeftRail: vi.fn(),
      browserOpen: false,
      onToggleBrowser: vi.fn(),
      terminalAvailable: false,
      terminalOpen: false,
      onToggleTerminal: vi.fn(),
      activityCount: 0,
      onOpenSettingsTab: vi.fn(),
      onOpenRemote: vi.fn(),
      appearancePreference: 'light',
      onSetAppearance: vi.fn(),
    });

    const view = render(
      <CommandPalette
        open={true}
        onClose={onClose}
        commands={commands}
        workspaceRoot="/tmp/proj"
        onOpenFile={onOpenFile}
      />,
    );

    // Switch workspace root while old scan is still in flight.
    listDirMock.mockResolvedValueOnce([
      { name: 'report.docx', path: '/tmp/other/report.docx' as FilePath, isDirectory: false },
    ]);
    view.rerender(
      <CommandPalette
        open={true}
        onClose={onClose}
        commands={commands}
        workspaceRoot="/tmp/other"
        onOpenFile={onOpenFile}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /report\.docx/ })).toBeInTheDocument();
    });

    // Resolve old scan late: its file must not overwrite the new workspace's list.
    await act(async () => {
      resolveSlow([{ name: 'stale.ts', path: '/tmp/proj/stale.ts' as FilePath, isDirectory: false }]);
    });
    expect(screen.queryByRole('option', { name: /stale\.ts/ })).toBeNull();

    // Closing via Escape calls onClose and restores focus on unmount/close.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <CommandPalette
        open={false}
        onClose={onClose}
        commands={commands}
        workspaceRoot="/tmp/other"
        onOpenFile={onOpenFile}
      />,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('blocks duplicate submission while an async command is in flight and keeps error on failure', async () => {
    let rejectRun!: (err: Error) => void;
    const run = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRun = reject;
        }),
    );
    const onClose = vi.fn();

    render(
      <CommandPalette
        open={true}
        onClose={onClose}
        commands={[
          {
            id: 'async-action',
            group: 'action',
            label: '执行异步动作',
            keywords: ['async'],
            availability: () => ({ enabled: true }),
            run,
          },
        ]}
      />,
    );

    const opt = screen.getByRole('option', { name: /执行异步动作/ });
    fireEvent.click(opt);
    fireEvent.click(opt);
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectRun(new Error('上下文已失效'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('上下文已失效');
    expect(onClose).not.toHaveBeenCalled();
  });
});
