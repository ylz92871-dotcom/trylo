import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { CognitionBadge } from './CognitionBadge';

afterEach(() => cleanup());

interface Overrides {
  readonly sendTick?: number;
  readonly onAnswer?: (text: string) => void;
  readonly onDismiss?: (kind: 'not_now' | 'snooze' | 'dont_ask_similar') => void;
}

function renderProps(over: Overrides = {}) {
  return (
    <CognitionBadge
      dimension="verification_audit"
      label="有 1 个偏好问题待确认"
      prompt="低风险修改还要额外审核吗？"
      options={['直接做就行', '再加一轮独立审核']}
      onAnswer={over.onAnswer ?? vi.fn()}
      onDismiss={over.onDismiss ?? vi.fn()}
      sendTick={over.sendTick ?? 0}
    />
  );
}

describe('CognitionBadge', () => {
  it('renders the pill with label and dimension, closed by default', () => {
    render(renderProps());
    expect(screen.getByText('有 1 个偏好问题待确认')).toBeTruthy();
    expect(screen.getByText('验证与审核')).toBeTruthy();
    // popover is closed by default
    expect(screen.queryByText('低风险修改还要额外审核吗？')).toBeNull();
  });

  it('clicking opens the popover with prompt + options', () => {
    render(renderProps());
    fireEvent.click(screen.getByRole('button', { name: /有 1 个偏好问题/ }));
    expect(screen.getByText('低风险修改还要额外审核吗？')).toBeTruthy();
    expect(screen.getByText('直接做就行')).toBeTruthy();
  });

  it('choosing an option answers with that text', () => {
    const onAnswer = vi.fn();
    render(renderProps({ onAnswer }));
    fireEvent.click(screen.getByRole('button', { name: /有 1 个偏好问题/ }));
    fireEvent.click(screen.getByText('再加一轮独立审核'));
    expect(onAnswer).toHaveBeenCalledWith('再加一轮独立审核');
  });

  it('the mini action row dismisses with the mapped kinds', () => {
    const onDismiss = vi.fn();
    render(renderProps({ onDismiss }));
    fireEvent.click(screen.getByRole('button', { name: /有 1 个偏好问题/ }));
    fireEvent.click(screen.getByText('稍后'));
    expect(onDismiss).toHaveBeenCalledWith('snooze');
  });

  it('sendTick change closes the popover but keeps the badge', () => {
    const { rerender } = render(renderProps());
    fireEvent.click(screen.getByRole('button', { name: /有 1 个偏好问题/ }));
    expect(screen.getByText('低风险修改还要额外审核吗？')).toBeTruthy();
    // next user message bumps sendTick
    act(() => { rerender(renderProps({ sendTick: 1 })); });
    expect(screen.queryByText('低风险修改还要额外审核吗？')).toBeNull();
    expect(screen.getByText('有 1 个偏好问题待确认')).toBeTruthy();
  });

  it('Escape closes the popover', () => {
    render(renderProps());
    fireEvent.click(screen.getByRole('button', { name: /有 1 个偏好问题/ }));
    expect(screen.getByText('直接做就行')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('直接做就行')).toBeNull();
  });
});