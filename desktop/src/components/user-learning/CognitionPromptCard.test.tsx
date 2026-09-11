import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CognitionPromptCard } from './CognitionPromptCard';
import type { CognitionPromptMessage } from '../chat/types';

afterEach(() => cleanup());

function message(over: Partial<CognitionPromptMessage> = {}): CognitionPromptMessage {
  return {
    id: 'cognition:s1',
    kind: 'cognition_prompt',
    role: 'system',
    createdAt: 1,
    sessionId: 's1',
    prompt: '普通功能直接做，还是核心路径先计划？',
    options: ['小功能直接做，核心模块先计划', '都直接做'],
    dimension: 'planning_direct_execution',
    status: 'pending',
    ...over,
  };
}

describe('CognitionPromptCard', () => {
  it('pending renders the prompt, options, and save action', () => {
    render(<CognitionPromptCard message={message()} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('普通功能直接做，还是核心路径先计划？')).toBeTruthy();
    expect(screen.getByText('小功能直接做，核心模块先计划')).toBeTruthy();
    expect(screen.getByText('记下')).toBeTruthy();
    expect(screen.getByText('现在不')).toBeTruthy();
  });

  it('choosing an option answers with that text', () => {
    const onAnswer = vi.fn();
    render(<CognitionPromptCard message={message()} onAnswer={onAnswer} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByText('都直接做'));
    expect(onAnswer).toHaveBeenCalledWith('cognition:s1', '都直接做');
  });

  it('without responders the option buttons are disabled', () => {
    render(<CognitionPromptCard message={message()} />);
    expect((screen.getByText('都直接做') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('记下') as HTMLButtonElement).disabled).toBe(true);
  });

  it('answered state hides the actions', () => {
    render(<CognitionPromptCard message={message({ status: 'answered' })} onAnswer={vi.fn()} />);
    expect(screen.getByText('已记下')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '记下' })).toBeNull();
  });
});
