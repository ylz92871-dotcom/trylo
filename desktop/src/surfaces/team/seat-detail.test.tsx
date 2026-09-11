import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeatDetail } from './SeatDetail';
import type { SeatInstance } from './team-types';

const RUNNING_SEAT: SeatInstance = {
  id: 's-w',
  seat: 'worker',
  status: 'running',
  summary: '正在改文件',
  prompt: '实现 SeatDetail 的卡片。',
};

const COMPLETED_SEAT: SeatInstance = {
  id: 's-r',
  seat: 'reviewer',
  status: 'completed',
  summary: '已通过独立审查',
  prompt: '检查 spec §3 / §11 硬约束。',
  result: '通过。',
  startedAt: 1_730_000_000_000,
  endedAt: 1_730_000_004_000,
  durationMs: 4_000,
};

describe('surfaces/team/SeatDetail', () => {
  it('shows the seat display name and status pill', () => {
    render(<SeatDetail seat={RUNNING_SEAT} onBack={() => {}} />);
    expect(screen.getByText('动手')).toBeTruthy();
    expect(screen.getAllByText(/运行中/).length).toBeGreaterThan(0);
  });

  it('marks reviewer/verifier seats as 独立', () => {
    const reviewer: SeatInstance = { id: 's-r', seat: 'reviewer', status: 'completed', summary: 'ok' };
    render(<SeatDetail seat={reviewer} onBack={() => {}} />);
    expect(screen.getByText('独立')).toBeTruthy();
  });

  it('does NOT mark worker/architect/person as 独立', () => {
    render(<SeatDetail seat={RUNNING_SEAT} onBack={() => {}} />);
    expect(screen.queryByText('独立')).toBeNull();
  });

  it('invokes onBack when the collapse button is clicked (Foundation spec §10.5: 收起, not 返回摘要)', () => {
    const onBack = vi.fn();
    render(<SeatDetail seat={RUNNING_SEAT} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: /收起/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('lists live activity instead of dumping the prompt', () => {
    render(
      <SeatDetail
        seat={{
          ...RUNNING_SEAT,
          activity: [{ id: 't1', kind: 'tool', at: 1, label: '改 Login.tsx' }],
        }}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText('改 Login.tsx')).toBeTruthy();
    expect(screen.queryByText(/实现 SeatDetail 的卡片/)).toBeNull();
  });

  it('renders the completed result card with the result text', () => {
    render(<SeatDetail seat={COMPLETED_SEAT} onBack={() => {}} />);
    expect(screen.getByText('通过。')).toBeTruthy();
  });

  it('hides the cancel button when no onCancel is wired', () => {
    render(<SeatDetail seat={RUNNING_SEAT} onBack={() => {}} />);
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
  });

  it('invokes onCancel with the seat id when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<SeatDetail seat={RUNNING_SEAT} onBack={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledWith('s-w');
  });
});
