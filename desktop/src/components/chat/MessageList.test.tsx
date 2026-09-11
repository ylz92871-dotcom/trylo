import { forwardRef, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './types';

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function Virtuoso(
    {
      data,
      itemContent,
    }: {
      data: readonly ChatMessage[];
      itemContent: (index: number, item: ChatMessage) => ReactNode;
    },
    _ref,
  ) {
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

  it('projects Work phase and narration messages into one task board', () => {
    const messages: ChatMessage[] = [
      user('u1', '制作演示文稿', 100),
      {
        id: 'rail:r1', kind: 'work_rail', role: 'assistant', createdAt: 110,
        turnId: 'u1', runId: 'r1',
        projection: {
          identity: {
            taskId: 't1', runId: 'r1', turnId: 'u1',
            conversationId: 'c1', intent: 'task',
          },
          state: 'executing',
          phases: [
            { phase: 'understand', status: 'completed', label: '理解', activityCount: 1 },
            { phase: 'execute', status: 'active', label: '制作', activityCount: 1 },
          ],
          narrations: [], activities: [], blockers: [],
        },
      },
      {
        id: 'narration:r1:understand', kind: 'work_narration', role: 'assistant',
        createdAt: 120, turnId: 'u1', runId: 'r1', phaseId: 'understand',
        text: '已确认受众和内容范围。',
      },
      {
        id: 'narration:r1:execute', kind: 'work_narration', role: 'assistant',
        createdAt: 130, turnId: 'u1', runId: 'r1', phaseId: 'execute',
        text: '正在生成页面并统一视觉样式。',
      },
    ];

    render(<MessageList surface="work" messages={messages} running />);

    expect(screen.getAllByLabelText(/Trylo Work/)).toHaveLength(1);
    expect(screen.getByLabelText(/Trylo Work/)).toHaveTextContent('制作演示文稿');
    expect(screen.getByLabelText(/Trylo Work/)).toHaveTextContent('正在生成页面并统一视觉样式');
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
});
