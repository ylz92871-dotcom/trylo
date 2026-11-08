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
  it('uses neutral change headings for historical records and preserves rename diff identity', () => {
    const onOpenDiff = vi.fn();
    render(<CodeResultContent historical result={result({
      changes: [{ path: 'new.ts', oldPath: 'old.ts', kind: 'renamed', staged: true, unstaged: false, untracked: false }],
      changeCountTotal: 1,
    })} onOpenDiff={onOpenDiff} onOpenFile={vi.fn()} />);
    expect(screen.getByRole('region', { name: '变更记录' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '本轮变更' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看差异 new.ts' }));
    expect(onOpenDiff).toHaveBeenCalledWith('new.ts', 'old.ts');
  });

  it('does not describe an empty historical snapshot as the current turn', () => {
    render(<CodeResultContent historical result={result({})} onOpenDiff={vi.fn()} onOpenFile={vi.fn()} />);
    expect(screen.getByText('未记录到文件变更或检查结果。')).toBeTruthy();
    expect(screen.queryByText('本轮未记录到文件变更或检查结果。')).toBeNull();
  });

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
    expect(screen.getByRole('heading', { name: '本轮变更' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '检查结果' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看差异 src/a.ts' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '查看差异 a.ts' }));
    expect(onOpenDiff).toHaveBeenCalledWith('a.ts', undefined);
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '打开文件 a.ts' }));
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
    fireEvent.click(screen.getByRole('button', { name: '查看差异 new.ts' }));
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
    const diff = screen.getByRole('button', { name: '查看差异 gone.ts' }) as HTMLButtonElement;
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
    expect(screen.getAllByText('失败').length).toBe(1);
    expect(screen.getAllByText('通过').length).toBe(1);
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
    expect(screen.getByRole('heading', { name: '工作区变更' })).toBeTruthy();
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
