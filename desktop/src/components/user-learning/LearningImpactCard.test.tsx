import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LearningImpactCard } from './LearningImpactCard';
import type { LearningImpactMessage } from '../chat/types';

afterEach(() => cleanup());

function message(over: Partial<LearningImpactMessage> = {}): LearningImpactMessage {
  return {
    id: 'impact:d1',
    kind: 'learning_impact',
    role: 'system',
    createdAt: 1,
    reason: 'personalized policy would change a high-impact engineering control',
    baseline: ['先计划再改', '保留最终验证'],
    personalized: ['低风险直接执行'],
    status: 'pending',
    ...over,
  };
}

describe('LearningImpactCard', () => {
  it('pending compares baseline vs personalized and asks for a choice', () => {
    render(<LearningImpactCard message={message()} onResolve={vi.fn()} />);
    expect(screen.getByText('先计划再改')).toBeTruthy();
    expect(screen.getByText('低风险直接执行')).toBeTruthy();
    expect(screen.getByRole('button', { name: '保留工程基线' })).toBeTruthy();
    expect(screen.getByText('按我的偏好')).toBeTruthy();
  });

  it('keeping the baseline resolves with acceptPersonalization=false', () => {
    const onResolve = vi.fn();
    render(<LearningImpactCard message={message()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: '保留工程基线' }));
    expect(onResolve).toHaveBeenCalledWith('impact:d1', false);
  });

  it('without a resolver the buttons are disabled', () => {
    render(<LearningImpactCard message={message()} />);
    expect((screen.getByText('按我的偏好') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resolved cards hide the actions', () => {
    render(<LearningImpactCard message={message({ status: 'kept_baseline' })} onResolve={vi.fn()} />);
    expect(screen.getByText('保留工程底线')).toBeTruthy();
    expect(screen.queryByText('按我的偏好')).toBeNull();
  });
});
