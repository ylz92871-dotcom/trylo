import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveTurnPill } from './LiveTurnPill';
import type { ChatMessage } from './types';

afterEach(() => cleanup());

function baseMessages(over?: Partial<{ doneTool: boolean; runningTool: boolean; terminal: boolean }>): ChatMessage[] {
  const user: ChatMessage = {
    id: 'u-1',
    kind: 'text',
    role: 'user',
    text: 'Check build',
    createdAt: Date.now() - 5000,
    turnStartedAt: Date.now() - 5000,
    ...(over?.terminal ? { turnTiming: { elapsedMs: 5000, outcome: 'completed' as const } } : {}),
  };
  const out: ChatMessage[] = [user];
  if (over?.doneTool) {
    out.push({
      id: 't-1',
      kind: 'tool',
      role: 'assistant',
      tool: 'Read',
      summary: 'README.md',
      input: { file_path: '/ws/README.md' },
      status: 'done',
      createdAt: Date.now() - 4000,
    });
  }
  if (over?.runningTool) {
    out.push({
      id: 't-2',
      kind: 'tool',
      role: 'assistant',
      tool: 'Bash',
      summary: 'npm test',
      input: { command: 'npm test' },
      status: 'running',
      createdAt: Date.now() - 2000,
    });
  }
  return out;
}

describe('LiveTurnPill (Code & Work shared)', () => {
  it('renders nothing when idle or terminal', () => {
    const { container, rerender } = render(
      <LiveTurnPill viewState="idle" messages={baseMessages({ terminal: true })} running={false} />,
    );
    expect(container.querySelector('.live-turn-pill')).toBeNull();

    rerender(
      <LiveTurnPill viewState="thinking" messages={baseMessages({ terminal: true })} running={false} />,
    );
    expect(container.querySelector('.live-turn-pill')).toBeNull();
  });

  it('shows active tool verb, completed step count, and real stopping state without fake percentages', () => {
    const { rerender } = render(
      <LiveTurnPill
        viewState="tool_running"
        messages={baseMessages({ doneTool: true, runningTool: true })}
        running={true}
      />,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('执行 npm test');
    expect(status).toHaveTextContent('已完成1步');
    expect(status.textContent).not.toMatch(/%/);

    rerender(
      <LiveTurnPill
        viewState="stopping"
        messages={baseMessages({ doneTool: true })}
        running={true}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('正在停止…');
  });
});
