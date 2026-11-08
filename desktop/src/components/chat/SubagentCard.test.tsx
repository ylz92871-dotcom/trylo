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
    agentType: 'worker',
    ...overrides,
  };
}

describe('SubagentCard', () => {
  it('marks a historical managed-work spawn as retired before it had a session id', () => {
    render(<SubagentCard message={makeMessage({ agentType: 'managed-work' })} />);
    expect(screen.getByText('历史任务')).toBeInTheDocument();
    expect(screen.queryByText('运行中')).not.toBeInTheDocument();
  });

  it('shows agent type, status label and the delegate prompt', () => {
    render(<SubagentCard message={makeMessage({ prompt: 'Produce a report' })} />);
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('Produce a report')).toBeInTheDocument();
  });

  it('keeps retired managed-work history readable without claiming it is running', () => {
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-abc123', prompt: 'do work' })}
      />,
    );
    expect(screen.getByText(/CoWork 执行器已退役/)).toBeInTheDocument();
    expect(screen.queryByText('运行中')).not.toBeInTheDocument();
    expect(screen.getByText('#sess-abc')).toBeInTheDocument();
  });

  it('does not show the background hint once the session is terminal', () => {
    render(
      <SubagentCard
        message={makeMessage({ managedSessionId: 'sess-x', status: 'done', result: 'done' })}
      />,
    );
    expect(screen.queryByText(/在后台继续/)).not.toBeInTheDocument();
    expect(screen.getByText('历史任务')).toBeInTheDocument();
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

  it('never offers execution actions for a retired managed session', () => {
    render(<SubagentCard message={makeMessage({ managedSessionId: 'sess-1', status: 'running' })} />);
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });
});
