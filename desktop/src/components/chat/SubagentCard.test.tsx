// Trylo Desktop — SubagentCard tests (P3 §8.1).
// Run: npx vitest run src/components/chat/SubagentCard.test.tsx

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { SubagentCard } from './SubagentCard';
import type { SubagentMessage } from './types';

function makeMessage(overrides: Partial<SubagentMessage> = {}): SubagentMessage {
  return {
    id: 'sub-1',
    kind: 'subagent',
    role: 'system',
    createdAt: 1,
    status: 'running',
    agentType: 'managed-work',
    ...overrides,
  };
}

describe('SubagentCard', () => {
  it('shows agent type, status label and the delegate prompt', () => {
    render(<SubagentCard message={makeMessage({ prompt: 'Produce a report' })} />);
    expect(screen.getByText('managed-work')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('Produce a report')).toBeInTheDocument();
  });

  it('shows the background hint for a non-terminal managed-work session', () => {
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-abc123', prompt: 'do work' })}
      />,
    );
    expect(screen.getByText(/在后台继续/)).toBeInTheDocument();
    expect(screen.getByText('#sess-abc')).toBeInTheDocument();
  });

  it('does not show the background hint once the session is terminal', () => {
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-x', status: 'done', result: 'done' })}
      />,
    );
    expect(screen.queryByText(/在后台继续/)).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
  });

  it('expands the detail drawer with session/backing/artifacts', () => {
    render(
      <SubagentCard
        message={makeMessage({
          managedSessionId: 'sess-full',
          backingTaskId: 'task-1',
          summary: 'produced report',
          artifacts: ['.trylo/out/managed/sess-full/report.md'],
          status: 'waiting',
        })}
      />,
    );
    fireEvent.click(screen.getByText('查看交付物 / 详情'));
    expect(screen.getByText('sess-full')).toBeInTheDocument();
    expect(screen.getByText('task-1')).toBeInTheDocument();
    expect(screen.getByText('produced report')).toBeInTheDocument();
    expect(screen.getByText('.trylo/out/managed/sess-full/report.md')).toBeInTheDocument();
    // Collapses again.
    fireEvent.click(screen.getByText('收起详情'));
    expect(screen.queryByText('task-1')).not.toBeInTheDocument();
  });

  it('renders 继续/取消 only for an active managed session with an action handler', () => {
    const onAction = (sessionId: string, action: 'continue' | 'cancel', text?: string) => {
      void sessionId;
      void action;
      void text;
    };
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-1', status: 'running' })}
        onManagedWorkAction={onAction}
      />,
    );
    expect(screen.getByText('继续')).toBeInTheDocument();
    expect(screen.getByText('取消')).toBeInTheDocument();
  });

  it('no action buttons for terminal managed sessions', () => {
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-1', status: 'done' })}
        onManagedWorkAction={() => {}}
      />,
    );
    expect(screen.queryByText('继续')).not.toBeInTheDocument();
    expect(screen.queryByText('取消')).not.toBeInTheDocument();
  });

  it('calls onManagedWorkAction with the SAME session id for cancel', () => {
    const calls: Array<{ sessionId: string; action: 'continue' | 'cancel'; text?: string }> = [];
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-cancel', status: 'running' })}
        onManagedWorkAction={(sessionId, action, text) => calls.push({ sessionId, action, text })}
      />,
    );
    fireEvent.click(screen.getByText('取消'));
    expect(calls).toEqual([{ sessionId: 'sess-cancel', action: 'cancel' }]);
  });

  it('continuing opens an inline input and sends a follow-up to the SAME session', () => {
    const calls: Array<{ sessionId: string; action: 'continue' | 'cancel'; text?: string }> = [];
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-cont', status: 'running' })}
        onManagedWorkAction={(sessionId, action, text) => calls.push({ sessionId, action, text })}
      />,
    );
    fireEvent.click(screen.getByText('继续'));
    const input = screen.getByPlaceholderText('输入后续指令并回车…');
    fireEvent.change(input, { target: { value: 'add risk section' } });
    fireEvent.click(screen.getByText('发送'));
    expect(calls).toEqual([{ sessionId: 'sess-cont', action: 'continue', text: 'add risk section' }]);
  });
});
