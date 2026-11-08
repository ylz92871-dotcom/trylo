import { forwardRef, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, TextMessage } from './types';

// Adversarial hook: lets tests assert on the raw Virtuoso props — notably
// `computeItemKey` output, which must stay UNIQUE (React keys) even when a
// turn contains two non-contiguous runs of the same phaseId.
const virtuoso = vi.hoisted(() => ({ captured: [] as Record<string, unknown>[] }));

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function Virtuoso(props: Record<string, unknown>, _ref) {
    virtuoso.captured.push(props);
    const { data, itemContent } = props as {
      data: readonly ChatMessage[];
      itemContent: (index: number, item: ChatMessage) => ReactNode;
    };
    return <div>{data.map((item, index) => itemContent(index, item))}</div>;
  }),
}));

vi.mock('./Message', () => ({
  Message: ({
    message,
    isTurnActive,
  }: {
    message: ChatMessage;
    isTurnActive: boolean;
  }) => (
    <div data-testid={`message-${message.id}`} data-turn-active={String(isTurnActive)}>
      {message.kind === 'text' ? message.text : message.kind}
    </div>
  ),
}));

import { MessageList } from './MessageList';
import type { ListItem } from './MessageList';
import { normalizeMessageIds } from './message-identity';
import { ConversationPresentation } from './ConversationPresentation';

function user(id: string, text: string, createdAt: number): TextMessage {
  return {
    id,
    kind: 'text',
    role: 'user',
    createdAt,
    text,
    turnStartedAt: createdAt,
  };
}

describe('MessageList turn projection', () => {
  it.each(['code', 'work'] as const)('%s excludes a hosted approval row without losing its waiting-for-input state', surface => {
    const messages: ChatMessage[] = [user('approval-user', 'write', 1), {
      id: 'approval-row', kind: 'approval', role: 'system', createdAt: 2,
      authority: 'code', approvalId: 'request-1', status: 'pending', type: 'write_file', description: '写入文件',
      pendingRequest: { requestId: 'request-1', projectKey: 'p', conversationId: 'c',
        processId: 'process', toolName: 'write_file', input: { path: 'report.md' } },
    }];
    const view = render(<ConversationPresentation.Provider value={{ embedded: true,
      hostedApprovals: [{ messageId: 'approval-row', approvalId: 'request-1', authority: 'code' }] }}>
      <MessageList surface={surface} running messages={messages} />
    </ConversationPresentation.Provider>);
    const props = virtuoso.captured.at(-1)!;
    expect((props.data as readonly ListItem[]).some(item => item.kind === 'approval')).toBe(false);
    expect(props.context).toMatchObject({ viewState: 'awaiting_input' });
    expect(messages[1]).toMatchObject({ status: 'pending', approvalId: 'request-1' });
    view.unmount();
  });

  it.each(['code', 'work'] as const)('%s settles a completed tool phase while the run awaits its next response', surface => {
    const view = render(<MessageList surface={surface} running messages={[
      user('done-user', 'check', 1000),
      { id: 'done-tool', kind: 'tool', role: 'assistant', createdAt: 1010,
        tool: 'Read', status: 'done', summary: 'report.md', turnId: 'done-user' },
    ]} />);
    expect(view.getByLabelText('执行过程')).not.toHaveClass('code-reasoning--active');
    view.unmount();
  });

  it.each([
    ['code', 'running'], ['work', 'running'], ['code', 'pending'], ['work', 'pending'],
  ] as const)('%s keeps a %s tool active when a later assistant comment arrives', (surface, status) => {
    const view = render(<MessageList surface={surface} running messages={[
      user('live-user', 'check', 1000),
      { id: 'live-tool', kind: 'tool', role: 'assistant', createdAt: 1010,
        tool: 'Read', status, summary: 'report.md', turnId: 'live-user' },
      { id: 'live-comment', kind: 'text', role: 'assistant', createdAt: 1020,
        text: '这项操作仍在进行。', turnId: 'live-user' },
    ]} />);
    expect(view.getByLabelText('执行过程')).toHaveClass('code-reasoning--active');
    expect(view.getByLabelText('执行过程').textContent).not.toContain('操作尚未完成');
    view.unmount();
  });

  it('keeps live Work reasoning open before any tool call exists', () => {
    const view = render(<MessageList surface="work" running messages={[
      user('reasoning-user', 'continue', 1000),
      { id: 'reasoning', kind: 'thinking', role: 'assistant', createdAt: 1010,
        summary: '分析', preview: '正在逐步分析任务', fullLength: 8, partial: true, turn: 1 },
    ]} />);
    expect(view.container.querySelector('.code-reasoning__head')?.getAttribute('aria-expanded')).toBe('true');
    view.unmount();
  });
  it('places each completed duration after its answer, without a live user counter', () => {
    const messages: ChatMessage[] = [
      { ...user('timed', 'question', 1000), turnTiming: { elapsedMs: 90000, outcome: 'completed' } },
      { id: 'final-answer', kind: 'text', role: 'assistant', text: 'final answer', createdAt: 91000 },
    ];
    for (const surface of ['code', 'work'] as const) {
      const view = render(<MessageList messages={messages} surface={surface} />);
      const answer = screen.getByText('final answer');
      const duration = screen.getByText('本轮用时 1:30');
      expect(answer.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      view.rerender(<MessageList messages={messages} running surface={surface} />);
      expect(screen.queryByText('本轮用时 1:30')).toBeNull();
      view.unmount();
    }
  });
  it('keeps context measurements out of visible rows on Code and Work', () => {
    const messages: ChatMessage[] = [user('context-user', 'continue', 1),
      { id: 'context-only', kind: 'notice', role: 'system', text: '', createdAt: 2, contextTokens: 6000 },
      { id: 'context-warning', kind: 'notice', role: 'system', text: '连接已恢复', createdAt: 3 }];
    for (const surface of ['code', 'work'] as const) {
      const view = render(<MessageList messages={messages} surface={surface} />);
      const rows = virtuoso.captured.at(-1)!.data as readonly ListItem[];
      expect(rows.some(row => 'id' in row && row.id === 'context-only')).toBe(false);
      expect(screen.getByTestId('message-context-warning')).toBeInTheDocument();
      view.unmount();
    }
    expect(messages[1]).toMatchObject({ contextTokens: 6000 });
  });

  it('shows one row per invocation on both surfaces while retaining real repeated commands', () => {
    const first: ChatMessage = {id:'tool-a',kind:'tool',role:'assistant',createdAt:101,
      toolCallId:'call-a',tool:'Bash',status:'running',summary:'same command',input:{command:'same command'}};
    const messages: ChatMessage[] = [user('replay-turn','check',100),first,
      {...first,id:'receipt-a',status:'done'},
      {...first,id:'tool-b',toolCallId:'call-b',status:'done'}];
    for (const surface of ['code','work'] as const) {
      const view=render(<MessageList messages={messages} surface={surface}/>);
      expect(view.container.querySelectorAll('.tool--event')).toHaveLength(0);
      fireEvent.click(view.container.querySelector('.code-reasoning__head')!);
      expect(view.container.querySelectorAll('.tool--event')).toHaveLength(2);
      view.unmount();
    }
    expect(messages).toHaveLength(4);
  });

  it('keeps Code and Work virtual rows unique and stable after restoring collided history', () => {
    const legacy: ChatMessage[] = [user('u1', 'first', 100),
      { id: 'warn-7', role: 'system', kind: 'notice', text: 'checkpoint', createdAt: 101 },
      { id: 'text-1', role: 'assistant', kind: 'text', text: 'answer one', createdAt: 102 },
      user('u2', 'second', 200),
      { id: 'warn-7', role: 'system', kind: 'notice', text: 'denied', createdAt: 201 },
      { id: 'text-1', role: 'assistant', kind: 'text', text: 'answer two', createdAt: 202 },
    ];
    const messages = normalizeMessageIds(legacy);
    const capturedKeys = () => {
      const props = virtuoso.captured.at(-1)!;
      const keyFor = props.computeItemKey as (index: number, item: ListItem) => string;
      return (props.data as readonly ListItem[]).map((item, index) => keyFor(index, item));
    };
    for (const surface of ['code', 'work'] as const) {
      const view = render(<MessageList surface={surface} messages={messages} />);
      const first = capturedKeys();
      expect(new Set(first).size).toBe(first.length);
      view.rerender(<MessageList surface={surface} messages={normalizeMessageIds([...messages])} />);
      expect(capturedKeys()).toEqual(first);
      view.unmount();
    }
    expect(messages).toHaveLength(legacy.length);
  });
  it('keeps the user row and metadata before the first thinking event', () => {
    const messages: ChatMessage[] = [
      user('u1', 'question', 100),
      {
        id: 'turn-1',
        kind: 'turn',
        role: 'assistant',
        createdAt: 105,
        turn: 1,
        depth: 0,
        agentId: null,
        status: 'done',
        turnId: 'u1',
      },
      {
        id: 'thinking-1',
        kind: 'thinking',
        role: 'assistant',
        createdAt: 110,
        summary: '分析',
        preview: '分析中',
        fullLength: 3,
        partial: true,
        turn: 1,
        turnId: 'u1',
      },
      {
        id: 'a1',
        kind: 'text',
        role: 'assistant',
        createdAt: 120,
        text: 'answer',
        turnId: 'u1',
      },
    ];

    render(<MessageList messages={messages} running />);

    expect(screen.getByTestId('message-u1')).toHaveTextContent('question');
    expect(screen.getByTestId('message-turn-1')).toBeInTheDocument();
    const process = screen.getByLabelText('执行过程');
    expect(process).toHaveTextContent('分析');
    fireEvent.click(process.querySelector('.code-reasoning__head')!);
    expect(process).toHaveTextContent('分析中');
    expect(screen.getByTestId('message-a1')).toHaveTextContent('answer');
  });

  it('marks only the newest user turn active', () => {
    const messages: ChatMessage[] = [
      user('u1', 'first', 100),
      { id: 'a1', kind: 'text', role: 'assistant', createdAt: 110, text: 'one', turnId: 'u1' },
      user('u2', 'second', 200),
      {
        id: 'thinking-2',
        kind: 'thinking',
        role: 'assistant',
        createdAt: 210,
        summary: 'thinking',
        preview: '',
        fullLength: 0,
        partial: true,
        turn: 2,
        turnId: 'u2',
      },
    ];

    render(<MessageList messages={messages} running />);

    expect(screen.getByTestId('message-a1')).toHaveAttribute('data-turn-active', 'false');
    expect(screen.getByLabelText('执行过程')).toHaveClass('code-reasoning--active');
  });

  it.each(['code', 'work'] as const)('keeps successive reasoning and tool events readable after a completed %s phase is reopened', surface => {
    const messages: ChatMessage[] = [
      user('u1', 'fix it', 100),
      {
        id: 'thinking-1', kind: 'thinking', role: 'assistant', createdAt: 110,
        summary: '先定位问题', preview: '读取相关文件并确认状态。', fullLength: 12,
        partial: false, turn: 1, turnId: 'u1',
      },
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 120,
        tool: 'Read', status: 'done', summary: '读取配置', turnId: 'u1',
      },
      {
        id: 'thinking-2', kind: 'thinking', role: 'assistant', createdAt: 130,
        summary: '开始修复', preview: '问题来自缺少默认配置。', fullLength: 11,
        partial: false, turn: 1, turnId: 'u1',
      },
    ];

    const view = render(<MessageList surface={surface} messages={messages} running />);

    expect(screen.getAllByLabelText('执行过程')).toHaveLength(1);
    expect(screen.getByLabelText('执行过程')).not.toHaveClass('code-reasoning--active');
    fireEvent.click(view.container.querySelector('.code-reasoning__head')!);
    const transcript = screen.getByLabelText('按时间顺序的执行过程');
    expect(transcript).toHaveTextContent('读取相关文件并确认状态');
    expect(transcript).toHaveTextContent('读取配置');
    expect(transcript).toHaveTextContent('问题来自缺少默认配置');
    view.unmount();
  });

  it('renders explicit Code phases as separate independently settling blocks', () => {
    const messages: ChatMessage[] = [
      user('u1', 'build it', 100),
      {
        id: 'thinking-1', kind: 'thinking', role: 'assistant', createdAt: 110,
        summary: 'inspect', preview: '先检查现状。', fullLength: 6, partial: false,
        turn: 1, turnId: 'u1', phaseId: 'phase-inspect',
      },
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 120,
        tool: 'Read', status: 'done', summary: 'src/app.ts', turnId: 'u1',
        phaseId: 'phase-inspect',
      },
      {
        id: 'thinking-2', kind: 'thinking', role: 'assistant', createdAt: 130,
        summary: 'implement', preview: '开始构建产物。', fullLength: 7, partial: true,
        turn: 1, turnId: 'u1', phaseId: 'phase-build',
      },
    ];

    render(<MessageList surface="code" messages={messages} running />);

    const blocks = screen.getAllByLabelText('执行过程');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).not.toHaveClass('code-reasoning--active');
    expect(blocks[1]).toHaveClass('code-reasoning--active');
    expect(blocks[0]?.querySelector('.code-reasoning__head')).toHaveTextContent('读取完成 · app.ts');
    expect(blocks[0]?.querySelector('.code-reasoning__meta')).toHaveTextContent('1 次操作');
  });

  it('keeps history-revived Work narration rows visible in the turn projection', () => {
    // 2026-09-10: the WorkTaskBoard aggregation path was removed with the
    // work_activity_group cleanup. Persisted work_rail/work_narration rows
    // from old sessions must stay VISIBLE as pass-through rows (rendering
    // itself is Message's safety-net branch; this file mocks Message), never
    // swallowed by the turn projection.
    const messages: ChatMessage[] = [
      user('u1', '制作演示文稿', 100),
      {
        id: 'narration:r1:understand', kind: 'work_narration', role: 'assistant',
        createdAt: 120, turnId: 'u1', runId: 'r1', phaseId: 'understand',
        text: '已确认受众和内容范围。',
      },
    ];

    render(<MessageList surface="work" messages={messages} running />);

    expect(screen.getByTestId('message-narration:r1:understand')).toBeInTheDocument();
    expect(screen.getByTestId('message-narration:r1:understand')).toHaveTextContent('work_narration');
  });

  it('places the Work tool/thinking transcript chronologically, not at the bottom (2026-09-04)', () => {
    const messages: ChatMessage[] = [
      user('u1', '修复工具', 100),
      {
        id: 'thinking-1', kind: 'thinking', role: 'assistant', createdAt: 110,
        summary: '排查', preview: '先定位问题。', fullLength: 6, partial: false,
        turn: 1, turnId: 'u1',
      },
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 120,
        tool: 'DisplayInventory', status: 'done', summary: '枚举窗口', turnId: 'u1',
      },
      { id: 'a1', kind: 'text', role: 'assistant', createdAt: 130, text: '检查完成', turnId: 'u1' },
    ];

    render(<MessageList surface="work" messages={messages} running />);

    const transcript = screen.getByLabelText('执行过程');
    const answer = screen.getByTestId('message-a1');
    // The transcript must appear BEFORE the assistant's final text — never a
    // block dumped at the very bottom of the output.
    expect(transcript.compareDocumentPosition(answer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('collapses the Work tool/thinking transcript once the phase tool finishes (2026-09-04)', () => {
    const finished: ChatMessage[] = [
      user('u1', '修复工具', 100),
      {
        id: 'thinking-1', kind: 'thinking', role: 'assistant', createdAt: 110,
        summary: '排查', preview: '先定位问题。', fullLength: 6, partial: false,
        turn: 1, turnId: 'u1',
      },
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 120,
        tool: 'DisplayInventory', status: 'done', summary: '枚举窗口', turnId: 'u1',
      },
      { id: 'a1', kind: 'text', role: 'assistant', createdAt: 130, text: '检查完成', turnId: 'u1' },
    ];

    // A phase with a RUNNING tool stays active (streaming, open).
    const runningMsgs: ChatMessage[] = [
      user('u1', '修复工具', 100),
      {
        id: 'thinking-1', kind: 'thinking', role: 'assistant', createdAt: 110,
        summary: '排查', preview: '先定位问题。', fullLength: 6, partial: false,
        turn: 1, turnId: 'u1',
      },
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 120,
        tool: 'DisplayInventory', status: 'running', summary: '枚举窗口', turnId: 'u1',
      },
      { id: 'a1', kind: 'text', role: 'assistant', createdAt: 130, text: '检查完成', turnId: 'u1' },
    ];
    const live = render(<MessageList surface="work" messages={runningMsgs} running />);
    expect(live.getByLabelText('执行过程')).toHaveClass('code-reasoning--active');
    live.unmount();

    // Once the phase's tool is done the transcript collapses — even while the
    // overall task is still `running`. No spinner left.
    render(<MessageList surface="work" messages={finished} running />);
    expect(screen.getByLabelText('执行过程')).not.toHaveClass('code-reasoning--active');
  });

  // ── Adversarial: projection invariants the scroll-performance work relies on ──

  it('keeps Virtuoso item keys unique when one phaseId reappears as two runs (Code)', () => {
    const messages: ChatMessage[] = [
      user('u1', 'multi-step', 100),
      {
        id: 'thinking-1', kind: 'thinking', role: 'assistant', createdAt: 110,
        summary: 'step a', preview: '先做 a。', fullLength: 6, partial: false,
        turn: 1, turnId: 'u1', phaseId: 'phase-a',
      },
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 120,
        tool: 'Read', status: 'done', summary: 'src/a.ts', turnId: 'u1', phaseId: 'phase-a',
      },
      { id: 'a1', kind: 'text', role: 'assistant', createdAt: 130, text: '中间结论', turnId: 'u1' },
      {
        id: 'thinking-2', kind: 'thinking', role: 'assistant', createdAt: 140,
        summary: 'step a again', preview: '继续 a。', fullLength: 6, partial: false,
        turn: 1, turnId: 'u1', phaseId: 'phase-a',
      },
    ];

    render(<MessageList surface="code" messages={messages} running />);

    // Both runs survive the projection as separate blocks…
    expect(screen.getAllByLabelText('执行过程')).toHaveLength(2);
    // …and every item key stays unique — duplicate React keys would corrupt
    // Virtuoso reconciliation the moment the list grows.
    const props = virtuoso.captured.at(-1)!;
    const keys = (props.data as readonly { id?: string; key?: string }[]).map(
      (item) => item.key ?? item.id,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps Virtuoso item keys unique when narration splits a Work phase', () => {
    const messages: ChatMessage[] = [
      user('u1', '制作报告', 100),
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 110,
        tool: 'Write', status: 'done', summary: '草稿', turnId: 'u1', phaseId: 'draft',
      },
      {
        id: 'narration:1', kind: 'work_narration', role: 'assistant',
        createdAt: 120, turnId: 'u1', runId: 'r1', phaseId: 'draft',
        text: '草稿完成。',
      },
      {
        id: 'tool-2', kind: 'tool', role: 'assistant', createdAt: 130,
        tool: 'Read', status: 'running', summary: '复查草稿', turnId: 'u1', phaseId: 'draft',
      },
    ];

    render(<MessageList surface="work" messages={messages} running />);

    expect(screen.getAllByLabelText('执行过程')).toHaveLength(2);
    const props = virtuoso.captured.at(-1)!;
    const keys = (props.data as readonly { id?: string; key?: string }[]).map(
      (item) => item.key ?? item.id,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not mark a trailing Code phase active once assistant output follows it', () => {
    const messages: ChatMessage[] = [
      user('u1', 'build it', 100),
      {
        id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 110,
        tool: 'Read', status: 'done', summary: 'src/app.ts', turnId: 'u1', phaseId: 'phase-a',
      },
      { id: 'a1', kind: 'text', role: 'assistant', createdAt: 120, text: '全部完成', turnId: 'u1' },
    ];

    render(<MessageList surface="code" messages={messages} running />);

    // The reverse suffix walk must agree with the old per-phase scan: an
    // assistant answer AFTER the phase means the block is not "current",
    // even while the turn is still running.
    expect(screen.getByLabelText('执行过程')).not.toHaveClass('code-reasoning--active');
  });
});
