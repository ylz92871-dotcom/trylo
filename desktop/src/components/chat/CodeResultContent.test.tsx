// Trylo Desktop — CodeResultContent tests (P2-1, spec §12.2).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CodeResultContent } from './CodeResultContent';
import type { StoredCodeRunResult } from '../../results/conversation-result-types';

afterEach(() => cleanup());

function result(partial: Partial<StoredCodeRunResult>): StoredCodeRunResult {
  return {
    meta: {
      runId: 'r1',
      turnId: 't1',
      startedAt: 0,
      status: 'completed',
    },
    attribution: 'run_delta',
    changes: [],
    checks: [],
    changeCountTotal: 0,
    checkCountTotal: 0,
    truncated: false,
    ...partial,
  };
}

describe('CodeResultContent (P2-1)', () => {
  it('renders latest-run changes + checks sections', () => {
    render(
      <CodeResultContent
        result={result({
          changes: [{ path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true, untracked: false }],
          checks: [{ id: 'r1:c', label: 'pnpm test', kind: 'test', status: 'passed' }],
          changeCountTotal: 1,
          checkCountTotal: 1,
        })}
        onOpenDiff={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByText('This run')).toBeTruthy();
    expect(screen.getByText('Checks')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('pnpm test')).toBeTruthy();
  });

  it('calls open-diff and open-file via distinct actions', () => {
    const onOpenDiff = vi.fn();
    const onOpenFile = vi.fn();
    render(
      <CodeResultContent
        result={result({
          changes: [{ path: 'a.ts', kind: 'modified', staged: false, unstaged: true, untracked: false }],
          changeCountTotal: 1,
        })}
        onOpenDiff={onOpenDiff}
        onOpenFile={onOpenFile}
      />,
    );
    fireEvent.click(screen.getByText('Diff'));
    expect(onOpenDiff).toHaveBeenCalledWith('a.ts', undefined);
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Open'));
    expect(onOpenFile).toHaveBeenCalledWith('a.ts');
  });

  it('passes the rename old path to open-diff (M3)', () => {
    const onOpenDiff = vi.fn();
    render(
      <CodeResultContent
        result={result({
          changes: [{ path: 'new.ts', kind: 'renamed', oldPath: 'old.ts', staged: true, unstaged: false, untracked: false }],
          changeCountTotal: 1,
        })}
        onOpenDiff={onOpenDiff}
        onOpenFile={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Diff'));
    expect(onOpenDiff).toHaveBeenCalledWith('new.ts', 'old.ts');
  });

  it('enables diff for a deleted file (M5)', () => {
    const onOpenDiff = vi.fn();
    render(
      <CodeResultContent
        result={result({
          changes: [{ path: 'gone.ts', kind: 'deleted', staged: true, unstaged: false, untracked: false }],
          changeCountTotal: 1,
        })}
        onOpenDiff={onOpenDiff}
        onOpenFile={vi.fn()}
      />,
    );
    const diff = screen.getByText('Diff') as HTMLButtonElement;
    expect(diff.disabled).toBe(false);
  });

  it('shows passed/failed status from the model', () => {
    render(
      <CodeResultContent
        result={result({
          checks: [
            { id: 'a', label: 'pnpm test', kind: 'test', status: 'failed' },
            { id: 'b', label: 'tsc', kind: 'typecheck', status: 'passed' },
          ],
          checkCountTotal: 2,
        })}
        onOpenDiff={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getAllByText('failed').length).toBe(1);
    expect(screen.getAllByText('passed').length).toBe(1);
  });

  it('workspace_only surfaces the "attribution unavailable" copy', () => {
    render(
      <CodeResultContent
        result={result({
          attribution: 'workspace_only',
          changes: [{ path: 'w.ts', kind: 'modified', staged: false, unstaged: true, untracked: false }],
          changeCountTotal: 1,
        })}
        onOpenDiff={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByText('当前目录无法精确归因到本轮，以下展示工作区现有变更。')).toBeTruthy();
    expect(screen.getByText('Workspace changes')).toBeTruthy();
  });

  it('renders per-file +N −N stats (WP-4)', () => {
    render(
      <CodeResultContent
        result={result({
          changes: [
            { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true, untracked: false, additions: 12, deletions: 3 },
          ],
          changeCountTotal: 1,
          additionsTotal: 12,
          deletionsTotal: 3,
          statsComplete: true,
        })}
        onOpenDiff={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('−3')).toBeTruthy();
  });

  it('shows Binary instead of fake +N/−N for binary changes (WP-4)', () => {
    render(
      <CodeResultContent
        result={result({
          changes: [
            { path: 'img.bin', kind: 'added', staged: false, unstaged: false, untracked: true, binary: true },
          ],
          changeCountTotal: 1,
          statsComplete: true,
        })}
        onOpenDiff={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByText('Binary')).toBeTruthy();
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it('renders an em dash, never a fake +0 −0, when stats are missing (WP-4)', () => {
    render(
      <CodeResultContent
        result={result({
          changes: [
            { path: 'missing.ts', kind: 'modified', staged: false, unstaged: true, untracked: false },
          ],
          changeCountTotal: 1,
          statsComplete: false,
        })}
        onOpenDiff={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('+0')).toBeNull();
  });
});
