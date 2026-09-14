import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearningReceipt } from '../../user-learning/types';
import { LearningReceiptPill } from './LearningReceiptPill';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const receipt: LearningReceipt = {
  id: 'receipt-1', commitmentId: 'bc-1', commitmentVersion: 1,
  dedupeKey: 'bc-1::1::created', reason: 'created', product: 'code',
  conversationId: 'conversation-1', message: '已记录，尚未用于执行：先给结论',
  sourceSummary: '以后汇报先说结论', scopeLabel: 'Code · 当前项目',
  effectiveFrom: 1, state: 'pending',
  actions: ['this_time_only', 'change_scope', 'pause', 'retract'],
  createdAt: 1, updatedAt: 1,
};

function subject(overrides: Partial<Parameters<typeof LearningReceiptPill>[0]> = {}) {
  return <LearningReceiptPill
    receipt={receipt}
    canActivate
    onAcknowledge={vi.fn()}
    onActivate={vi.fn()}
    onThisTimeOnly={vi.fn()}
    onChangeScope={vi.fn()}
    onPause={vi.fn()}
    onRetract={vi.fn()}
    {...overrides}
  />;
}

describe('LearningReceiptPill', () => {
  it('shows one quiet line and exposes source, scope and controls on click', () => {
    render(subject());
    fireEvent.click(screen.getByRole('button', { name: /已记录，尚未用于执行/ }));
    expect(screen.getByText('以后汇报先说结论')).toBeTruthy();
    expect(screen.getByText('Code · 当前项目')).toBeTruthy();
    expect(screen.getByRole('button', { name: '以后这样做' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '仅本次' })).toBeTruthy();
  });

  it('auto-collapses after eight seconds and acknowledges the receipt', () => {
    vi.useFakeTimers();
    const onAcknowledge = vi.fn();
    render(subject({ onAcknowledge }));
    act(() => { vi.advanceTimersByTime(8_000); });
    expect(screen.queryByRole('button', { name: /已记录，尚未用于执行/ })).toBeNull();
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });
});
