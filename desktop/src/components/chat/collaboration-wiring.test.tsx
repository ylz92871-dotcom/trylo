import { forwardRef, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TryloV1EventAdapter } from '../../host-adapter/trylo-v1-event-adapter';
import { applyEvents } from './events';
import type { ChatMessage, SubagentMessage } from './types';

vi.mock('react-virtuoso', () => ({ Virtuoso: forwardRef(function List(props: {
  data: readonly { id?: string; key?: string }[]; itemContent: (index: number, item: unknown) => ReactNode;
}, _ref) { return <div>{props.data.map((item, index) => <div key={item.id ?? item.key}>{props.itemContent(index, item)}</div>)}</div>; }) }));
import { AgentConversationSurface } from './AgentConversationSurface';
import { SubagentConversation } from './SubagentConversation';
import { agentAvatarIndex } from './AgentAvatar';

afterEach(cleanup);
const user: ChatMessage = { id: 'u', kind: 'text', role: 'user', createdAt: 1, text: '排查连接和滚动' };
const child = (id: string, agentType: string, status: SubagentMessage['status'] = 'running'): SubagentMessage => ({
  id, subagentId: id, kind: 'subagent', role: 'system', turnId: 'u', createdAt: 2, agentType, status,
  prompt: `${agentType}任务全文`, canReceiveInput: true, source: 'trylo-v1',
});
function surface(messages: readonly ChatMessage[], send?: (id: string, text: string) => Promise<void>, running = true) {
  return <AgentConversationSurface surface="code" messages={messages} running={running}
    emptyState={<p>空对话</p>} composer={<p>主输入框</p>} onSubagentInput={send} />;
}

describe('approved collaboration UI uses the production event chain', () => {
  it('keeps parked tasks and resumed executions in one conversation with budget visibility', () => {
    const adapter = new TryloV1EventAdapter();
    let messages: ChatMessage[] = [user];
    const feed = (frame: object) => { messages = applyEvents(messages, adapter.feed(JSON.stringify(frame))); };
    feed({ type: 'subagent', kind: 'spawn', id: 'run-a', taskId: 'task-a', agentType: 'worker', status: 'running', canReceiveInput: true, prompt: '检查文件' });
    feed({ type: 'subagent', kind: 'end', id: 'run-a', taskId: 'task-a', status: 'done', parked: true, canReceiveInput: true,
      result: '第一轮证据', budget: { tokenLimit: 1200, tokensUsed: 30, tokensRemaining: 1170, timeoutMs: 10000, timeRemainingMs: 9000, timeoutMode: 'active' } });
    const view = render(<SubagentConversation agent={messages[1] as SubagentMessage} drafts={new Map()} onClose={() => {}} onSend={vi.fn()} />);
    expect(screen.getByRole('textbox')).toBeVisible();
    expect(screen.getByText(/剩余 1170/)).toBeVisible();
    feed({ type: 'subagent', kind: 'spawn', id: 'run-b', taskId: 'task-a', resumedFrom: 'run-a', status: 'running', agentType: 'worker', canReceiveInput: true, prompt: '继续检查', round: 2 });
    expect(messages.filter(m => m.kind === 'subagent')).toHaveLength(1);
    const resumed = messages[1] as SubagentMessage;
    expect(resumed.subagentId).toBe('run-b');
    expect(resumed.conversation?.[0]?.result).toBe('第一轮证据');
    view.rerender(<SubagentConversation agent={resumed} drafts={new Map()} onClose={() => {}} onSend={vi.fn()} />);
    expect(screen.getByText('第一轮证据')).toBeVisible();
  });

  it('lets the user explicitly stop and restart current work', async () => {
    const send = vi.fn(async () => {});
    render(<SubagentConversation agent={child('a', '执行')} drafts={new Map()} onClose={() => {}} onSend={send} />);
    fireEvent.change(screen.getByRole('combobox', { name: '发送方式' }), { target: { value: 'restart' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '改为检查测试' } });
    fireEvent.click(screen.getByRole('button', { name: '发送给该智能体' }));
    await act(async () => {});
    expect(send).toHaveBeenCalledWith('a', '改为检查测试', 'restart');
  });
  it('keeps identities across the event, member list, answer and stream updates without capping member count', () => {
    const members = Array.from({ length: 15 }, (_, index) => child(`member-${index}`, `成员${index}`));
    const view = render(surface([user, ...members]));
    const event = screen.getByLabelText('成员0参与事件');
    const avatar = event.querySelector('[data-avatar]')!;
    const identity = avatar.getAttribute('data-avatar');
    expect(avatar).toHaveAttribute('width', '24');
    expect(screen.getAllByRole('button', { name: /的参与详情$/ })).toHaveLength(15);
    expect(new Set(Array.from(document.querySelectorAll('.agent-participation [data-avatar]')).slice(0, 12).map(icon => icon.getAttribute('data-avatar'))).size).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: '16 个智能体 1 主控 · 15 协作' }));
    expect(screen.getByRole('button', { name: '查看成员0的会话' }).querySelector('[data-avatar]')).toHaveAttribute('data-avatar', identity);
    fireEvent.click(within(event).getByRole('button'));
    const changed = { ...members[0]!, displayName: '已更名成员', status: 'waiting' as const, result: '完整结果' };
    view.rerender(surface([user, changed, ...members.slice(1)]));
    expect(screen.getByLabelText('已更名成员参与事件').querySelector('[data-avatar]')).toHaveAttribute('data-avatar', identity);
    const panel = screen.getByRole('complementary', { name: '已更名成员的会话' });
    expect(panel.querySelectorAll('[data-avatar]')).toHaveLength(2);
    panel.querySelectorAll('[data-avatar]').forEach(icon => expect(icon).toHaveAttribute('data-avatar', identity));
    expect(within(panel).getByText('完整结果')).toBeVisible();
    expect(agentAvatarIndex({ id: 'different-ui-row', subagentId: 'member-0' })).toBe(Number(identity));
    expect(new Set(members.map(agentAvatarIndex)).size).toBeGreaterThan(3);
  });
  it('replaces successful orchestration cards but retains failed calls and the original messages', () => {
    const messages: ChatMessage[] = [user,
      { id: 'spawn-tool', kind: 'tool', role: 'assistant', turnId: 'u', createdAt: 2, tool: 'spawn_agent', toolCallId: 'spawn', status: 'done', summary: 'spawn' },
      child('a', 'worker'),
      { id: 'failed-send', kind: 'tool', role: 'assistant', turnId: 'u', createdAt: 3, tool: 'send_input', toolCallId: 'send', status: 'error', summary: 'failed', outputError: 'agent_closed' },
    ];
    render(surface(messages));
    expect(document.querySelectorAll('.code-reasoning')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /2 个智能体/ })).toHaveAttribute('aria-expanded', 'false');
    expect(messages).toHaveLength(4);
  });

  it('pauses member following for manual reading and restores it only on request', () => {
    const first = { ...child('a', '连接排查'), result: '第一轮答复' };
    const view = render(<SubagentConversation agent={first} drafts={new Map()} onClose={() => {}} />);
    const body = screen.getByLabelText('成员会话内容');
    Object.defineProperties(body, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    view.rerender(<SubagentConversation agent={{ ...first, result: '第一轮完整答复' }} drafts={new Map()} onClose={() => {}} />);
    // Native scrollbar dragging emits scroll without a wheel event.
    body.scrollTop = 400; fireEvent.scroll(body);
    expect(screen.getByRole('button', { name: '回到最新 ↓' })).toBeVisible();
    view.rerender(<SubagentConversation agent={{ ...first, result: '第二轮答复' }} drafts={new Map()} onClose={() => {}} />);
    expect(body.scrollTop).toBe(400);
    fireEvent.click(screen.getByRole('button', { name: '回到最新 ↓' }));
    expect(body.scrollTop).toBe(800);
    expect(screen.queryByRole('button', { name: '回到最新 ↓' })).toBeNull();
  });
  it('counts actual children once, stays collapsed on updates and opens the selected full answer', () => {
    const adapter = new TryloV1EventAdapter();
    let messages: ChatMessage[] = [user];
    const feed = (frame: object) => { messages = applyEvents(messages, adapter.feed(JSON.stringify(frame))); };
    for (const [id, agentType] of [['a', '连接排查'], ['b', '滚动修复'], ['c', '验证']]) {
      feed({ type: 'subagent', kind: 'spawn', id, agentType, status: 'running', prompt: `${agentType}任务全文`, canReceiveInput: true });
    }
    const view = render(surface(messages));
    const toggle = screen.getByRole('button', { name: '4 个智能体 1 主控 · 3 协作' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    feed({ type: 'subagent', kind: 'update', id: 'a', status: 'waiting', round: 1, result: '完整排查答复\n\n包括第二段。' });
    view.rerender(surface(messages));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getAllByRole('button', { name: /的会话$/ })).toHaveLength(3);
    expect(within(screen.getByLabelText('连接排查参与事件')).getByText('已答复')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看连接排查的会话' }));
    const panel = screen.getByRole('complementary', { name: '连接排查的会话' });
    expect(within(panel).getByText('连接排查任务全文')).toBeVisible();
    expect(within(panel).getByText('包括第二段。')).toBeVisible();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
    feed({ type: 'subagent', kind: 'spawn', id: 'a', agentType: '连接排查', status: 'running' });
    view.rerender(surface(messages));
    expect(screen.getByRole('button', { name: '4 个智能体 1 主控 · 3 协作' })).toBeVisible();
  });

  it('keeps member drafts separate and waits for delivery acknowledgement', async () => {
    const messages = [user, child('a', '连接排查'), child('b', '滚动修复')];
    let rejectSend: (error: Error) => void = () => {};
    const send = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    render(surface(messages, send));
    fireEvent.click(screen.getByRole('button', { name: /3 个智能体/ }));
    fireEvent.click(screen.getByRole('button', { name: '查看连接排查的会话' }));
    fireEvent.change(screen.getByRole('textbox', { name: '向连接排查补充要求' }), { target: { value: '保留失败记录' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭成员会话' }));
    fireEvent.click(screen.getByRole('button', { name: '查看滚动修复的会话' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '关闭成员会话' }));
    fireEvent.click(screen.getByRole('button', { name: '查看连接排查的会话' }));
    expect(screen.getByRole('textbox')).toHaveValue('保留失败记录');
    fireEvent.click(screen.getByRole('button', { name: '发送给该智能体' }));
    expect(send).toHaveBeenCalledWith('a', '保留失败记录');
    expect(screen.getByRole('textbox')).toHaveValue('保留失败记录');
    expect(screen.getByRole('button', { name: '发送给该智能体' })).toBeDisabled();
    await act(async () => rejectSend(new Error('通道关闭')));
    expect(screen.getByRole('alert')).toHaveTextContent('通道关闭');
    expect(screen.getByRole('textbox')).toHaveValue('保留失败记录');
  });

  it('does not offer sending to a member of a previous user turn', () => {
    render(surface([user, child('old', '旧协作'), { ...user, id: 'new', text: '下一轮' }], vi.fn()));
    fireEvent.click(screen.getByRole('button', { name: /2 个智能体/ }));
    fireEvent.click(screen.getByRole('button', { name: '查看旧协作的会话' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('retains completed text while marking a lost child stream as failed', () => {
    const adapter = new TryloV1EventAdapter();
    let messages: ChatMessage[] = [user];
    for (const frame of [
      { type: 'subagent', kind: 'spawn', id: 'a', status: 'running', agentType: 'worker', prompt: '完整任务', canReceiveInput: true },
      { type: 'subagent', kind: 'update', id: 'a', status: 'waiting', round: 1, result: '第一轮真实答复' },
      { type: 'subagent', kind: 'update', id: 'a', status: 'running', round: 2, prompt: '第二轮要求' },
    ]) messages = applyEvents(messages, adapter.feed(JSON.stringify(frame)));
    messages = applyEvents(messages, adapter.finalizeExit({ exitCode: 1, stderr: [], cancelled: false }));
    const agent = messages.find(message => message.kind === 'subagent') as SubagentMessage;
    expect(agent.status).toBe('failed');
    expect(agent.result).toBe('第一轮真实答复');
    expect(agent.conversation).toEqual([{ round: 1, prompt: '完整任务', result: '第一轮真实答复' }, { round: 2, prompt: '第二轮要求' }]);
    expect(agent.canReceiveInput).toBe(false);
    expect(adapter.feed(JSON.stringify({ type: 'subagent', kind: 'end', id: 'a', status: 'done', result: 'late' }))).toEqual([]);
  });
});
