import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CognitionSurface } from './CognitionSurface';
import { emptySnapshot } from '../../user-learning/store';
import type { CognitionSession } from '../../user-learning/types';

afterEach(() => cleanup());

function session(over: Partial<CognitionSession> = {}): CognitionSession {
  return {
    id: 'cog_1',
    userId: 'local-user',
    trigger: 'user_opened',
    dimension: 'agent_autonomy',
    questions: [],
    answers: [],
    messages: [
      { id: 'm1', role: 'assistant', text: '这轮只聊你怎么跟我干活，不写代码。', at: 1 },
    ],
    status: 'open',
    evidenceIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('CognitionSurface chat', () => {
  it('renders a conversation composer, not a save-as-evidence form', () => {
    render(
      <CognitionSurface
        session={session()}
        snapshot={emptySnapshot(1)}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onOpenSession={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('了解你怎么工作')).toBeTruthy();
    expect(screen.getByText('这轮只聊你怎么跟我干活，不写代码。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.queryByText('保存为 Evidence')).toBeNull();
    expect(screen.queryByText(/可选/)).toBeNull();
  });

  it('sends free text on 发送', () => {
    const onSend = vi.fn();
    render(
      <CognitionSurface
        session={session()}
        snapshot={emptySnapshot(1)}
        onSend={onSend}
        onStop={vi.fn()}
        onOpenSession={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '做 PPT 先出一版再改' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('做 PPT 先出一版再改');
  });
});
