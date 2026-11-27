// Trylo Desktop — ApprovalCard (M4-E, P3).
//
// Inline permission request. Pins:
//   - pending renders the safe summary + 批准并继续 / 拒绝;
//   - approved / denied / expired render a read-only state (no buttons);
//   - without a responder the buttons are disabled;
//   - clicking the card body / "查看变更" calls onOpenPreview, never
//     onRespond (P3, spec §3.3: opening a diff is NOT approving).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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
    // Current Code and Work runs both use the CLI permission registry.
    authority: 'code',
    ...over,
  };
}

describe('ApprovalCard (M4-E + P3)', () => {
  it('turns a stale click into an expired record, without telling the user to retry a dead request', async () => {
    const onRespond = vi.fn(async () => 'expired' as const);
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })));
    expect(screen.getByText('已失效')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批准并继续' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a stopped request expired when an earlier submit finishes late', async () => {
    let complete!: (value: boolean) => void;
    const onRespond = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const view = render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }));
    view.rerender(<ApprovalCard message={approvalMessage({ status: 'expired' })} onRespond={onRespond} />);
    await act(async () => complete(true));
    expect(screen.getByText('已失效')).toBeTruthy();
    expect(screen.queryByText('已批准')).toBeNull();
    expect(screen.queryByRole('button', { name: '批准并继续' })).toBeNull();
  });

  it('waits for delivery and prevents repeated clicks before showing the decision', async () => {
    let finish!: (accepted: boolean) => void;
    const onRespond = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }));
    const submitting = screen.getByRole('button', { name: /正在提交/ }) as HTMLButtonElement;
    expect(submitting.disabled).toBe(true);
    fireEvent.click(submitting);
    expect(onRespond).toHaveBeenCalledOnce();
    expect(screen.queryByText('已批准')).toBeNull();
    await act(async () => finish(true));
    expect(screen.getByText('已批准')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '批准并继续' })).toBeNull();
  });

  it.each(['false', 'reject'] as const)('keeps a failed %s delivery visible and allows retry', async failure => {
    const onRespond = vi.fn().mockImplementationOnce(() => failure === 'false'
      ? Promise.resolve(false) : Promise.reject(new Error('pipe closed'))).mockResolvedValue(true);
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })));
    expect(screen.getByRole('alert').textContent).toMatch(/未送达|提交失败/);
    expect(screen.getByText('等待确认')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '批准并继续' })));
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(screen.getByText('已批准')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['work', 'managed'] as const)('keeps retired %s approvals read-only without changing their stored state', (authority) => {
    const onRespond = vi.fn();
    const message = approvalMessage({ authority });
    render(<ApprovalCard message={message} onRespond={onRespond} />);
    expect(screen.getByText('执行器已退役')).toBeTruthy();
    expect(screen.getByText('Run shell command: git push')).toBeTruthy();
    expect(screen.queryByText('批准并继续')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
    expect(message.status).toBe('pending');
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('shows every shell step in an expanded review surface without granting approval', () => {
    const command = 'node report.js\n\n后续命令 1：\nnode cleanup.js\n\n成功后保存标准输出：report.json';
    const onRespond = vi.fn();
    render(<ApprovalCard message={approvalMessage({ preview: { kind: 'command', title: '运行命令', command, cwd: 'D:/project' } })} onRespond={onRespond} />);
    const summary = screen.getByText('完整命令与执行选项');
    const details = summary.closest('details');
    expect(details?.open).toBe(true);
    expect(details?.querySelector('pre')?.textContent).toBe(command);
    fireEvent.click(summary);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('pending renders the request copy and 批准并继续 / 拒绝', () => {
    render(<ApprovalCard message={approvalMessage()} />);
    expect(screen.getByText('Run shell command: git push')).toBeTruthy();
    expect(screen.getByText('批准并继续')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.getByText('等待确认')).toBeTruthy();
  });

  it('clicking 批准并继续 responds with approved=true', async () => {
    const onRespond = vi.fn();
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    await act(async () => fireEvent.click(screen.getByText('批准并继续')));
    expect(onRespond).toHaveBeenCalledWith('ap-1', true);
  });

  it('clicking 拒绝 responds with approved=false', async () => {
    const onRespond = vi.fn();
    render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
    await act(async () => fireEvent.click(screen.getByText('拒绝')));
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
    expect(screen.getByText('已批准')).toBeTruthy();
    expect(screen.queryByText('批准并继续')).toBeNull();
    expect(screen.queryByText('拒绝')).toBeNull();
  });

  it('denied renders a read-only state', () => {
    render(<ApprovalCard message={approvalMessage({ status: 'denied' })} />);
    expect(screen.getByText('已拒绝')).toBeTruthy();
    expect(screen.queryByText('批准并继续')).toBeNull();
  });

  it('expired renders a read-only state without the action buttons', () => {
    render(<ApprovalCard message={approvalMessage({ status: 'expired' })} />);
    expect(screen.getByText('已失效')).toBeTruthy();
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

  it('does not show an unavailable diff action for a non-diff request', () => {
    const onOpenPreview = vi.fn();
    render(
      <ApprovalCard
        message={approvalMessage({ preview: { kind: 'unavailable', title: '权限请求' } })}
        onOpenPreview={onOpenPreview}
      />,
    );
    expect(screen.queryByRole('button', { name: '查看变更' })).toBeNull();
    expect(onOpenPreview).not.toHaveBeenCalled();
  });
});

it('shows full command, directory and execution options without the duplicate generated caption', () => {
  const command = 'node first.js\n\n管道接收命令：\nnode receiver.js\n\n后续命令 1：\nnode last.js';
  const reason = '后台运行；成功后保存标准输出：report.json；超时：120000 毫秒';
  const message = approvalMessage({ type: 'run_shell', description: 'run_shell 请求审批', preview: {
    kind: 'command', title: '运行命令', command, cwd: 'D:/含空格与中文/审核项目', reason,
  } });
  const respond = vi.fn();
  const view = render(<ApprovalCard message={message} onRespond={respond} />);
  expect(view.container.querySelectorAll('pre code')).toHaveLength(1);
  expect(view.container.querySelector('pre code')?.textContent).toBe(command);
  expect(screen.getByRole('group', { name: '工作目录' }).textContent).toContain('D:/含空格与中文/审核项目');
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.queryByText('run_shell 请求审批')).toBeNull();
  expect(message.description).toBe('run_shell 请求审批');
  expect(respond).not.toHaveBeenCalled();
});

it('keeps settled history compact with its complete review facts and no decision actions', () => {
  const command = 'node review.js --all';
  const view = render(<ApprovalCard message={approvalMessage({ status: 'approved', preview: { kind: 'command', title: '运行命令', command } })} onRespond={vi.fn()} />);
  const history = view.container.querySelector('details.approval-card');
  expect((history as HTMLDetailsElement).open).toBe(false);
  expect(history?.querySelector('pre code')?.textContent).toBe(command);
  expect(screen.getByText('已批准')).toBeTruthy();
  expect(view.container.querySelectorAll('button')).toHaveLength(0);
});

it('distinguishes an automatic approval receipt from an explicit user decision', () => {
  render(<ApprovalCard message={approvalMessage({ status: 'approved', autoApproved: true })} />);
  expect(screen.getByText('已自动批准')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '批准并继续' })).toBeNull();
});

it('retains the request caption when an incomplete command preview has no command text', () => {
  render(<ApprovalCard message={approvalMessage({ type: 'run_shell', description: 'run_shell 请求审批', preview: { kind: 'command', title: '运行命令' } })} />);
  expect(screen.getByText('run_shell 请求审批')).toBeTruthy();
});

it('tracks press-slide-cancel visual state without submitting on slide-out and marks newly resolved cards', async () => {
  const onRespond = vi.fn(async () => true);
  const { container, rerender } = render(<ApprovalCard message={approvalMessage()} onRespond={onRespond} />);
  const approve = screen.getByRole('button', { name: '批准并继续' });
  Object.defineProperty(approve, 'getBoundingClientRect', {
    value: () => ({ left: 100, right: 200, top: 100, bottom: 132, width: 100, height: 32 }),
  });

  fireEvent.pointerDown(approve, { button: 0, clientX: 150, clientY: 116 });
  expect(approve.getAttribute('data-pressed')).toBe('true');

  // Slide outside button bounds cancels pressed appearance without calling onRespond.
  fireEvent.pointerMove(approve, { clientX: 250, clientY: 116 });
  expect(approve.getAttribute('data-pressed')).toBeNull();
  expect(onRespond).not.toHaveBeenCalled();

  rerender(<ApprovalCard message={approvalMessage({ status: 'approved' })} onRespond={onRespond} />);
  const settled = container.querySelector('.approval-card');
  expect(settled?.getAttribute('data-just-resolved')).toBe('true');
});
