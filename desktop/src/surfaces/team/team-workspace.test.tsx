import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentConversationSurface } from '../../components/chat/AgentConversationSurface';
import { TeamRunView } from './run/TeamRunView';
import { FIXTURE_TEAM_RUN } from './team-fixture';
import { selectSeat } from './team-store';
import type { TeamRun } from './team-types';
import type { ChatMessage } from '../../components/chat/types';

vi.mock('react-virtuoso', async () => import('../../test-support/virtuoso'));
const live: TeamRun = { ...FIXTURE_TEAM_RUN, reports: [{ id: 'report-1', seatId: 'worker', kind: 'progress',
  text: '已定位到重复编码，正在修正。', at: FIXTURE_TEAM_RUN.createdAt + 1 }], seats: [
  { id: 'worker', taskId: 'task-worker', memberId: 'member-worker', seat: 'worker', displayName: '代码实现', status: 'running', summary: '修复重复编码',
    canReceiveInput: true, round: 1, conversation: [{ round: 1, prompt: '修复导出文件名' }], activity: [{ id: 'read-1', kind: 'tool', at: 3, label: '读 filename.ts' }] },
  { id: 'queued-review', seat: 'reviewer', displayName: '独立审查', status: 'queued', summary: '等待实现', prompt: '独立检查修改范围' },
] };
const messages: ChatMessage[] = [{ id: 'person-note', kind: 'text', role: 'assistant', createdAt: live.createdAt + 2, text: '我会跟进剩余验证。' }];
function Person(): JSX.Element {
  const [text, setText] = useState('');
  return <AgentConversationSurface surface="code" messages={messages} running={false} emptyState={<div>空态</div>}
    composer={<form><label>Person 草稿<textarea value={text} onChange={event => setText(event.target.value)} /></label></form>} />;
}
function Harness({ send }: { readonly send?: (id: string, text: string) => Promise<void> }): JSX.Element {
  const [run, setRun] = useState(live);
  return <TeamRunView run={run} personView={<Person />} onMemberInput={send} onSelectSeat={id => setRun(current => selectSeat(current, id))} />;
}
afterEach(() => { cleanup(); localStorage.clear(); });

describe('connected dual-view workspace', () => {
  it('keeps a single member menu and view tabs without repeating the app title', () => {
    const select = vi.fn(); const stop = vi.fn(); const openPerson = vi.fn();
    const { container } = render(<TeamRunView run={live} onSelectSeat={select} onStopRun={stop} onOpenPerson={openPerson} />);
    const header = container.querySelector('.team-run__head')!;
    expect(header.querySelector('h1,h2')).toBeNull();
    expect(header.querySelectorAll('details')).toHaveLength(1);
    expect(header.querySelectorAll('[role=tab]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '停止' }).closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByLabelText('查看所有成员及当前任务'));
    fireEvent.click(screen.getByRole('button', { name: '打开完整 Person 对话' }));
    expect(openPerson).toHaveBeenCalledTimes(1);
    expect(header.querySelector('details')?.open).toBe(false);
    fireEvent.click(screen.getByLabelText('查看所有成员及当前任务'));
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('keeps internal prompts and raw round answers out of the user report feed', () => {
    render(<TeamRunView run={{ ...live, reports: [
      { id: 'assignment', seatId: 'worker', kind: 'assignment', text: '你是团队 worker，必须逐字报告内部模板' },
      { id: 'raw', seatId: 'worker', kind: 'report', text: '## Intent 内部原始答复' },
      { id: 'progress', seatId: 'worker', kind: 'progress', text: '已定位重复编码，正在核对覆盖写入。' },
    ] }} onSelectSeat={() => undefined} />);
    expect(screen.getByText('已定位重复编码，正在核对覆盖写入。')).toBeTruthy();
    expect(screen.queryByText(/必须逐字报告内部模板|内部原始答复/)).toBeNull();
  });
  it('reuses the real Person surface and preserves its draft through members and both views', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Person 草稿' }), { target: { value: '不要丢失主对话草稿' } });
    expect(screen.getByText('已定位到重复编码，正在修正。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看代码实现的执行过程' }));
    expect((screen.getByRole('textbox', { name: 'Person 草稿' }) as HTMLTextAreaElement).value).toBe('不要丢失主对话草稿');
    expect(screen.getByText('读 filename.ts')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '团队架构' }));
    expect(document.querySelector('.team-workspace__person .message-list')?.textContent).toContain('我会跟进剩余验证。');
    expect((screen.getByRole('textbox', { name: 'Person 草稿' }) as HTMLTextAreaElement).value).toBe('不要丢失主对话草稿');
    fireEvent.click(screen.getByRole('button', { name: '返回团队视图' }));
    expect(screen.getByRole('button', { name: '独立审查 排队' })).toBeTruthy();
  });

  it('sends member input through the existing task channel and retains text until the actual receipt', async () => {
    let receive: (() => void) | undefined;
    const send = vi.fn(() => new Promise<void>(resolve => { receive = resolve; }));
    render(<Harness send={send} />);
    fireEvent.click(screen.getByRole('button', { name: '查看代码实现的执行过程' }));
    const input = screen.getByRole('textbox', { name: '向代码实现补充要求' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '补充空格路径用例' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给该智能体' }));
    expect(send).toHaveBeenCalledWith('task-worker', '补充空格路径用例');
    expect(input.value).toBe('补充空格路径用例');
    expect(document.querySelector('.team-feed')?.textContent).not.toContain('补充空格路径用例');
    await act(async () => receive?.());
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('opens queued members from the real roster without enabling an unavailable send channel', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('查看所有成员及当前任务'));
    const roster = document.querySelector('.team-menu__popup')!;
    const member = [...roster.querySelectorAll('button')].find(button => button.textContent?.includes('独立审查'))!;
    fireEvent.click(member);
    expect(document.querySelector('.team-member-fallback')?.textContent).toContain('独立检查修改范围');
    expect(screen.queryByRole('textbox', { name: /向独立审查/ })).toBeNull();
  });

  it('keeps actionable personal questions and errors in the feed with their original responder', async () => {
    const respond = vi.fn(async () => true);
    const actionable: ChatMessage[] = [
      { kind: 'input_request', id: 'question', role: 'system', createdAt: live.createdAt + 3, requestId: 'request-1', status: 'pending',
        questions: [{ id: 'scope', header: '修复范围', question: '是否保留覆盖写入？', options: [{ label: '保留', description: '保持原有行为' }] }] },
      { kind: 'error', id: 'error', role: 'system', createdAt: live.createdAt + 4, userMessage: '投递暂时中断，草稿已保留。', diagnosticId: 'trace-1' },
    ];
    render(<TeamRunView run={live} onSelectSeat={() => undefined} personView={<AgentConversationSurface surface="code"
      messages={actionable} running={false} emptyState={null} composer={null} onRespondInputRequest={respond} />} />);
    expect(screen.getByText('投递暂时中断，草稿已保留。')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^保留/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith('request-1', 'submitted', { scope: { optionLabel: '保留' } }));
  });
});
