// Trylo Desktop — ApprovalCard (M4-E, P3).
//
// Inline permission request. Pins:
//   - pending renders the safe summary + 批准并继续 / 拒绝;
//   - approved / denied / expired render a read-only state (no buttons);
//   - without a responder the buttons are disabled;
//   - clicking the card body / "查看变更" calls onOpenPreview, never
//     onRespond (P3, spec §3.3: opening a diff is NOT approving).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import type { ApprovalMessage } from './types';
import type { ApprovalPreview } from '../../approval/approval-preview';

afterEach(() => cleanup());

function approvalMessage(over: Partial<ApprovalMessage> = {}): ApprovalMessage {
  return {
    id: 'approval:run:task-1:ap-1',
    kind: 'approval',
    role: 'system',
    createdAt: 1000,
    approvalId: 'ap-1',
    type: 'run_command',
    description: 'Run shell command: git push',
    status: 'pending',
    // P3 (spec §4.5): the card is shared between Code and
    // Work. The default in this fixture is the Work path so
    // existing assertions keep working; the Code branches are
    // exercised in the new P3 preview tests.
    authority: 'work',
    ...over,
  };
}

describe('ApprovalCard (M4-E + P3)', () => {
  it('pending renders the request copy and 批准并继续 / 拒绝', () => {
    render(<ApprovalCard message={approvalMessage()} />);
    expect(screen.getByText('Run shell command: git push')).toBeTruthy();
    expect(screen.getByText('批准并继续')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText('Needs approval')).toBeTruthy();
  });

  it('clicking 批准并继续 responds with approved=true', () => {
    const onRespond = vi.fn();
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('批准并继续'));
    expect(onRespond).toHaveBeenCalledWith('ap-1', true);
  });

  it('clicking 拒绝 responds with approved=false', () => {
    const onRespond = vi.fn();
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    fireEvent.click(screen.getByText('拒绝'));
    expect(onRespond).toHaveBeenCalledWith('ap-1', false);
  });

  it('without a responder the action buttons are disabled', () => {
    render(<ApprovalCard message={approvalMessage()} />);
    const approve = screen.getByText('批准并继续') as HTMLButtonElement;
    const deny = screen.getByText('拒绝') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
  });

  it('approved renders a read-only state with no action buttons', () => {
    render(<ApprovalCard message={approvalMessage({ status: 'approved' })} />);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByText('批准并继续')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
  });

  it('denied renders a read-only state', () => {
    render(<ApprovalCard message={approvalMessage({ status: 'denied' })} />);
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.queryByText('批准并继续')).toBeNull();
  });

  it('expired renders a read-only state without the action buttons', () => {
    render(<ApprovalCard message={approvalMessage({ status: 'expired' })} />);
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.queryByText('批准并继续')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
  });

  it('P3: 查看变更 opens the diff without approving', () => {
    const onRespond = vi.fn();
    const onOpenPreview = vi.fn();
    const preview: ApprovalPreview = {
      kind: 'diff',
      title: '编辑文件',
      target: 'src/foo.ts',
      diff: {
        path: 'src/foo.ts',
        original: 'old\n',
        modified: 'new\n',
        additions: 1,
        deletions: 0,
        truncated: false,
      },
    };
    render(
      <ApprovalCard
        message={approvalMessage({ preview })}
        onRespond={onRespond}
        onOpenPreview={onOpenPreview}
      />,
    );
    fireEvent.click(screen.getByText('查看变更'));
    expect(onOpenPreview).toHaveBeenCalledWith('ap-1');
    // CRITICAL: opening the diff MUST NOT approve. The spec
    // calls this out as the regression that must never return.
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('P3: 查看变更 is disabled when there is no diff preview', () => {
    const onOpenPreview = vi.fn();
    render(
      <ApprovalCard
        message={approvalMessage({ preview: { kind: 'unavailable', title: '权限请求' } })}
        onOpenPreview={onOpenPreview}
      />,
    );
    // The label is rendered inside a span; the surrounding
    // <button> owns the disabled state.
    const btn = screen.getByRole('button', { name: '查看变更' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
