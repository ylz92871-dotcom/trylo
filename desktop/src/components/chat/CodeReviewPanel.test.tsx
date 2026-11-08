import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RightRail } from '../app-shell/RightRail';
import { ResultDock } from './ResultDock';
import { CodeReviewPanel } from './CodeReviewPanel';
import { codeReviewSummary } from './code-review-summary';
import type { StoredCodeRunResult } from '../../results/conversation-result-types';

vi.mock('../app-shell/WorkspaceTree', () => ({ WorkspaceTree: () => <span>workspace tree</span> }));
afterEach(cleanup);

function result(overrides: Partial<StoredCodeRunResult> = {}): StoredCodeRunResult {
  return {
    meta: { runId: 'run-1', turnId: 'turn-1', startedAt: 0, status: 'completed' },
    attribution: 'run_delta',
    changes: [{ path: 'src/panel.tsx', kind: 'modified', staged: false, unstaged: true, untracked: false }],
    checks: [], changeCountTotal: 1, checkCountTotal: 0, truncated: false, ...overrides,
  };
}

function Harness(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const [file, setFile] = useState<string>();
  return <>
    <ResultDock id="entry" panelId="review-panel" mode="code" title="变更审查" count={1}
      summary="1 个文件" status="ready" open={open && review}
      onOpenChange={next => { setOpen(next); setReview(next); }} />
    <RightRail open={open} root={null} onClose={() => { setOpen(false); setReview(false); }}
      preview={file ? <div>diff: {file}<button onClick={() => setFile(undefined)}>Close preview</button></div> : undefined} previewKey={file ? 'diff:' + file : undefined}
      review={{ id: 'review-panel', open: review, onOpenChange: setReview,
        content: <CodeReviewPanel result={result()} onOpenDiff={setFile} onOpenFile={setFile} /> }} />
  </>;
}

describe('compact Code review flow', () => {
  it('labels historical run records without losing outputs, checks, stats or Git actions', () => {
    const openDiff = vi.fn();
    const openFile = vi.fn();
    render(<CodeReviewPanel currentTurn={false} result={result({
      additionsTotal: 8, deletionsTotal: 2, statsComplete: true,
      checks: [{ id: 'old-check', label: 'retained tests', kind: 'test', status: 'passed' }], checkCountTotal: 1,
      outputs: [{ path: 'report.pdf', change: 'created', signature: { size: 64, modifiedMs: 1 } }],
    })} onOpenDiff={openDiff} onOpenFile={openFile} />);
    expect(screen.getByText('上轮记录')).toBeTruthy();
    expect(screen.queryByText('本轮记录')).toBeNull();
    expect(screen.getByRole('region', { name: '变更记录' })).toBeTruthy();
    expect(screen.getByLabelText('Git HEAD 到工作区的增删行数').textContent).toContain('+8');
    expect(screen.getByText('retained tests')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看差异 src/panel.tsx' }));
    fireEvent.click(screen.getByRole('button', { name: '打开文件 report.pdf' }));
    expect(openDiff).toHaveBeenCalledWith('src/panel.tsx', undefined);
    expect(openFile).toHaveBeenCalledWith('report.pdf');
  });

  it('keeps workspace attribution when the recorded turn is historical', () => {
    render(<CodeReviewPanel currentTurn={false} result={result({ attribution: 'workspace_only' })}
      onOpenDiff={vi.fn()} onOpenFile={vi.fn()} />);
    expect(screen.getByText('工作区记录')).toBeTruthy();
    expect(screen.getByRole('region', { name: '工作区变更' })).toBeTruthy();
    expect(screen.queryByText('上轮记录')).toBeNull();
  });

  it('opens one rail, selects the existing preview, and returns to the change list', () => {
    render(<Harness />);
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '变更审查' }));
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: '变更' }).getAttribute('aria-selected')).toBe('true');
    const file = screen.getByRole('button', { name: '查看差异 src/panel.tsx' });
    file.focus();
    fireEvent.click(file);
    expect(screen.getByRole('tabpanel', { name: '预览' }).textContent).toContain('diff: src/panel.tsx');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '预览' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.getByRole('tab', { name: '变更' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '查看差异 src/panel.tsx' })).toBeTruthy();
  });

  it('supports tab keyboard navigation and Escape returns focus to the entry', () => {
    render(<Harness />);
    const entry = screen.getByRole('button', { name: '变更审查' });
    entry.focus();
    fireEvent.click(entry);
    const review = screen.getByRole('tab', { name: '变更' });
    review.focus();
    fireEvent.keyDown(review, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: '预览' }), { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '变更' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: '变更' }), { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it('does not render one file twice when Git and output observations overlap', () => {
    const value = result({ outputs: [{ path: 'src/panel.tsx', change: 'updated', signature: { size: 1, modifiedMs: 1 } }] });
    render(<CodeReviewPanel result={value} onOpenDiff={vi.fn()} onOpenFile={vi.fn()} />);
    expect(screen.getAllByText('panel.tsx')).toHaveLength(1);
    expect(codeReviewSummary(value).count).toBe(1);
  });

  it('keeps same-name files distinguishable and passes the exact selected path', () => {
    const open = vi.fn();
    const change = result().changes[0]!;
    render(<CodeReviewPanel result={result({ changes: [change, { ...change, path: 'test/panel.tsx' }] })}
      onOpenDiff={open} onOpenFile={vi.fn()} />);
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看差异 test/panel.tsx' }));
    expect(open).toHaveBeenCalledWith('test/panel.tsx', undefined);
  });

  it('does not promote partial stats or cancelled checks to a complete success', () => {
    render(<CodeReviewPanel result={result({ statsComplete: false, additionsTotal: 20, deletionsTotal: 5,
      checks: [{ id: 'c', label: 'build', kind: 'build', status: 'cancelled' }], checkCountTotal: 1 })}
      onOpenDiff={vi.fn()} onOpenFile={vi.fn()} />);
    expect(screen.queryByLabelText('Git HEAD 到工作区的增删行数')).toBeNull();
    expect(screen.getByText('0 项检查通过')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
  });

  it('keeps deleted files reviewable and disables opening their missing contents', () => {
    const open = vi.fn();
    render(<CodeReviewPanel result={result({ changes: [{ ...result().changes[0]!, kind: 'deleted' }] })}
      onOpenDiff={open} onOpenFile={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '查看差异 src/panel.tsx' }));
    expect(open).toHaveBeenCalledWith('src/panel.tsx', undefined);
    expect((screen.getByRole('button', { name: '打开文件 src/panel.tsx' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows scope, degraded collection, and the real check failure', () => {
    render(<CodeReviewPanel result={result({ attribution: 'workspace_only', truncated: true,
      meta: { ...result().meta, status: 'degraded', warning: 'Collection incomplete' },
      checks: [{ id: 'c', label: 'unit tests', kind: 'test', status: 'failed' }], checkCountTotal: 1 })}
      onOpenDiff={vi.fn()} onOpenFile={vi.fn()} />);
    expect(screen.getByText('工作区记录')).toBeTruthy();
    expect(screen.getByText('Collection incomplete').getAttribute('role')).toBe('status');
    expect(screen.getByText('0 项检查通过 · 1 项失败')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '检查结果' })).getByText('失败')).toBeTruthy();
  });
});
