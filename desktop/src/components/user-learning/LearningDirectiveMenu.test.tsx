import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningDirectiveMenu } from './LearningDirectiveMenu';

afterEach(() => cleanup());

describe('LearningDirectiveMenu', () => {
  it('exposes the three one-shot choices and returns the selected directive', () => {
    const onChange = vi.fn();
    render(<LearningDirectiveMenu onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '设置下一条消息的学习选项' }));
    expect(screen.getByText('本次不使用个人偏好')).toBeTruthy();
    expect(screen.getByText('本次不学习')).toBeTruthy();
    fireEvent.click(screen.getByText('无痕任务'));
    expect(onChange).toHaveBeenCalledWith({
      applyExistingPreferences: false,
      collectNewLearning: false,
      retention: 'session_only',
      reason: 'user_requested_private',
    });
  });

  it('renders a visible chip and lets the user cancel it', () => {
    const onChange = vi.fn();
    render(
      <LearningDirectiveMenu
        value={{ applyExistingPreferences: true, collectNewLearning: false, retention: 'normal' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('本次不学习')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消本次不学习' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('closes on Escape and restores focus to the trigger', () => {
    render(<LearningDirectiveMenu onChange={() => undefined} />);
    const trigger = screen.getByRole('button', { name: '设置下一条消息的学习选项' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: '下一条消息的学习选项' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '下一条消息的学习选项' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
