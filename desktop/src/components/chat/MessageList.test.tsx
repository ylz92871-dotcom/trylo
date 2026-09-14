import { forwardRef, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './types';

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

function user(id: string, text: string, createdAt: number): ChatMessage {
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
    expect(screen.getByLabelText('Trylo Code 思考与行动')).toHaveTextContent('分析中');
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
    expect(screen.getByLabelText('Trylo Code 思考与行动')).toHaveClass('code-reasoning--active');
  });

  it('keeps successive reasoning and tool events in one readable Code transcript', () => {
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

    render(<MessageList surface="code" messages={messages} running />);

    expect(screen.getAllByLabelText('Trylo Code 思考与行动')).toHaveLength(1);
    const transcript = screen.getByLabelText('完整思考过程');
    expect(transcript).toHaveTextContent('读取相关文件并确认状态');
    expect(transcript).toHaveTextContent('读取配置');
    expect(transcript).toHaveTextContent('问题来自缺少默认配置');
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

    const blocks = screen.getAllByLabelText('Trylo Code 思考与行动');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).not.toHaveClass('code-reasoning--active');
    expect(blocks[1]).toHaveClass('code-reasoning--active');
    expect(screen.getByText('已运行 1 次操作')).toBeInTheDocument();
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

    const transcript = screen.getByLabelText('Trylo Code 思考与行动');
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
    expect(live.getByLabelText('Trylo Code 思考与行动')).toHaveClass('code-reasoning--active');
    live.unmount();

    // Once the phase's tool is done the transcript collapses — even while the
    // overall task is still `running`. No spinner left.
    render(<MessageList surface="work" messages={finished} running />);
    expect(screen.getByLabelText('Trylo Code 思考与行动')).not.toHaveClass('code-reasoning--active');
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
    expect(screen.getAllByLabelText('Trylo Code 思考与行动')).toHaveLength(2);
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

    expect(screen.getAllByLabelText('Trylo Code 思考与行动')).toHaveLength(2);
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
    expect(screen.getByLabelText('Trylo Code 思考与行动')).not.toHaveClass('code-reasoning--active');
  });
});
