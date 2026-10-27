import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { SeatDetail } from './SeatDetail';
import type { SeatInstance } from './team-types';
vi.mock('react-virtuoso', async () => import('../../test-support/virtuoso'));

afterEach(cleanup);

const member: SeatInstance = { id: 'execution-1', taskId: 'task-1', memberId: 'm1', seat: 'worker', displayName: '文档成员',
  status: 'running', summary: '已答复', canReceiveInput: true, round: 1,
  conversation: [{ round: 1, prompt: '检查导出路径', result: '已读取中文文件 🚀' }] };

describe('team member conversation', () => {
  it('shows a round answer before the member execution has been closed', () => {
    render(<SeatDetail seat={member} onBack={() => {}} drafts={new Map()} onMemberInput={async () => {}} />);
    expect(screen.getByText('已读取中文文件 🚀')).toBeVisible();
    expect(screen.getByText('检查导出路径')).toBeVisible();
  });

  it('sends to stable task identity and clears the draft only after a receipt', async () => {
    let received: (() => void) | undefined;
    const onSend = vi.fn(() => new Promise<void>(resolve => { received = resolve; }));
    const drafts = new Map<string, string>();
    render(<SeatDetail seat={member} conversationKey="run:m1" onBack={() => {}} drafts={drafts} onMemberInput={onSend} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '补充检查中文 🚀' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给该智能体' }));
    expect(onSend).toHaveBeenCalledWith('task-1', '补充检查中文 🚀');
    expect(input).toHaveValue('补充检查中文 🚀');
    expect(screen.getByRole('button', { name: '发送给该智能体' })).toBeDisabled();
    await act(async () => { received?.(); });
    await waitFor(() => expect(input).toHaveValue(''));
    expect(drafts.has('run:m1')).toBe(false);
  });

  it('retains failed input, displays the receipt error, and survives an execution replacement', async () => {
    const onSend = vi.fn(async () => { throw new Error('未收到接收确认，草稿已保留。'); });
    const drafts = new Map<string, string>();
    const view = render(<SeatDetail seat={member} conversationKey="run:m1" onBack={() => {}} drafts={drafts} onMemberInput={onSend} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不要覆盖我的新改动' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给该智能体' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未收到接收确认');
    expect(screen.getByRole('textbox')).toHaveValue('不要覆盖我的新改动');
    view.unmount();
    render(<SeatDetail seat={{ ...member, id: 'execution-2' }} conversationKey="run:m1" onBack={() => {}} drafts={drafts} onMemberInput={onSend} />);
    expect(screen.getByRole('textbox')).toHaveValue('不要覆盖我的新改动');
  });

  it('allows input to a parked member and hides input when the parent channel has closed', () => {
    const parked = { ...member, status: 'completed' as const, parked: true };
    const view = render(<SeatDetail seat={parked} onBack={() => {}} drafts={new Map()} onMemberInput={async () => {}} />);
    expect(screen.getByRole('textbox')).toBeVisible();
    view.rerender(<SeatDetail seat={parked} onBack={() => {}} drafts={new Map()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('此任务当前不接收补充要求，可回到主对话继续指派。')).toBeVisible();
  });
});
