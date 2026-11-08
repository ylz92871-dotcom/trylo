import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMemo, useState } from 'react';
import type { FilePath } from '../../host-adapter/types';
import { RightRail } from './RightRail';
import { ResultDock } from '../chat/ResultDock';
import { useResultReview } from '../../result-dock/use-result-review';
import { resultDockPrefsStore } from '../../result-dock/result-dock-prefs';

afterEach(() => { cleanup(); resultDockPrefsStore.clearProject('rail-parity-test'); });

function ReviewHarness({ mode, conversation = 'one' }: { mode: 'code' | 'work'; conversation?: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const scope = useMemo(() => ({ surface: mode, projectKey: 'rail-parity-test', conversationId: conversation }), [mode, conversation]);
  const review = useResultReview(scope, open, setOpen);
  const title = mode === 'code' ? '变更审查' : '交付物';
  return <>
    <ResultDock id="result-entry" panelId={`review-${mode}-${conversation}`} mode={mode} title={title}
      count={1} status="ready" summary="1 个文件" open={review.open} onOpenChange={review.toggle} />
    <RightRail open={open} root={null} onClose={() => review.toggle(false)}
      review={{ id: `review-${mode}-${conversation}`, label: title, open: review.open,
        onOpenChange: review.select, content: <button onClick={() => setPreview(true)}>预览本轮文件</button> }}
      previewKey={preview ? `file:${mode}:${conversation}` : null}
      preview={preview ? <button onClick={() => setPreview(false)}>关闭当前预览</button> : undefined} />
  </>;
}

vi.mock('./WorkspaceTree', () => ({
  WorkspaceTree: (props: { onSelect?: (path: FilePath, kind: 'file') => void }) =>
    <button onClick={() => props.onSelect?.('project/result.txt' as FilePath, 'file')}>result.txt</button>,
}));

describe('Shared results rail', () => {
  it.each(['code', 'work'] as const)('%s opens the same rail and returns from preview to its result', mode => {
    render(<ReviewHarness mode={mode} />);
    const title = mode === 'code' ? '变更审查' : '交付物';
    const entry = screen.getByRole('button', { name: title });
    entry.focus();
    fireEvent.click(entry);
    expect(screen.getByRole('tab', { name: title }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('complementary', { name: '结果侧栏' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '预览本轮文件' }));
    expect(screen.getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '关闭当前预览' }));
    expect(screen.getByRole('tab', { name: title }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('complementary', { name: '结果侧栏' }), { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it('keeps the same conversation ID independent across modes and other conversations', () => {
    const view = render(<ReviewHarness mode="code" />);
    fireEvent.click(screen.getByRole('button', { name: '变更审查' }));
    view.rerender(<ReviewHarness mode="work" />);
    expect(screen.getByRole('button', { name: '交付物' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '交付物' }));
    view.rerender(<ReviewHarness mode="work" conversation="two" />);
    expect(screen.getByRole('button', { name: '交付物' }).getAttribute('aria-expanded')).toBe('false');
    view.rerender(<ReviewHarness mode="code" />);
    expect(screen.getByRole('button', { name: '变更审查' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the real file selection in Preview and allows returning to Files', () => {
    const select = vi.fn();
    const { rerender } = render(<RightRail open root={'project' as FilePath} onClose={() => {}} onSelectFile={select} />);
    fireEvent.click(screen.getByRole('button', { name: 'result.txt' }));
    expect(select).toHaveBeenCalledWith('project/result.txt', 'file');
    rerender(<RightRail open root={'project' as FilePath} onClose={() => {}} onSelectFile={select}
      preview={<div>Actual preview content</div>} previewKey="file:result.txt" />);
    expect(screen.getByRole('tabpanel', { name: '预览' }).textContent).toContain('Actual preview content');
    expect(screen.queryByRole('tabpanel', { name: '文件' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '文件' }));
    expect(screen.getByRole('button', { name: 'result.txt' })).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: '预览' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'result.txt' }));
    expect(screen.getByRole('tabpanel', { name: '预览' }).textContent).toContain('Actual preview content');
  });
  it('opens a newly requested result while Files is selected without adding another rail', () => {
    const { rerender } = render(<RightRail open root={'project' as FilePath} onClose={() => {}}
      preview={<div>First result</div>} previewKey="diff:first" />);
    fireEvent.click(screen.getByRole('tab', { name: '文件' }));
    rerender(<RightRail open root={'project' as FilePath} onClose={() => {}}
      preview={<div>Second result</div>} previewKey="diff:second" />);
    expect(screen.getByRole('tabpanel', { name: '预览' }).textContent).toContain('Second result');
    expect(screen.getAllByRole('complementary', { name: '结果侧栏' })).toHaveLength(1);
  });
});
