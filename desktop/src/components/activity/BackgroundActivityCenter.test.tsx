import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundActivityCenter, type ActivityItem } from './BackgroundActivityCenter';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const item = (patch: Partial<ActivityItem> = {}): ActivityItem => ({ id: 'run-1', kind: 'work', conversationId: 'conversation-1', workspaceLabel: 'trylo', title: '核对报告', statusLabel: 'Running', startedAt: Date.now() - 42000, onStop: vi.fn(), onJump: vi.fn(), ...patch });

describe('Running-task panel', () => {
  it('renders nothing while closed, and shows a Chinese empty state without a zero badge', () => {
    const { rerender } = render(<BackgroundActivityCenter open={false} items={[]} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<BackgroundActivityCenter open items={[]} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: '运行中的任务' })).toBeTruthy();
    expect(screen.getByText('当前没有运行中的任务')).toBeTruthy();
    expect(screen.queryByLabelText('0项任务')).toBeNull();
  });
  it('renders mode, workspace and the actual translated status, with live elapsed time', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const active = item();
    render(<BackgroundActivityCenter open items={[active]} onClose={() => {}} />);
    expect(screen.getByText('Work')).toBeTruthy(); expect(screen.getByText('trylo')).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy(); expect(screen.getByText('42秒')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000)); expect(screen.getByText('44秒')).toBeTruthy();
  });
  it('preserves the row focus through list updates and clock ticks', () => {
    vi.useFakeTimers(); const active = item(); const close = vi.fn();
    const { rerender } = render(<BackgroundActivityCenter open items={[active]} onClose={close} />);
    const row = screen.getByRole('button', { name: '返回会话：核对报告' }); row.focus();
    rerender(<BackgroundActivityCenter open items={[{ ...active, statusLabel: '准备就绪' }]} onClose={() => {}} />);
    act(() => vi.advanceTimersByTime(1000)); expect(document.activeElement).toBe(row);
  });
  it('returns to the selected conversation and closes only through its original callbacks', () => {
    const active = item(); const close = vi.fn();
    render(<BackgroundActivityCenter open items={[active]} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '返回会话：核对报告' }));
    expect(active.onJump).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); expect(active.onStop).not.toHaveBeenCalled();
  });
  it('retains incomplete metadata as a stoppable row with navigation disabled', () => {
    const active = item({ kind: 'unknown', onJump: undefined, statusLabel: '会话信息暂不可用' });
    render(<BackgroundActivityCenter open items={[active]} onClose={() => {}} />);
    expect((screen.getByRole('button', { name: '返回会话：核对报告' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '停止任务：核对报告' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('waits for stop acknowledgment, prevents repeated requests and preserves a failed request for retry', async () => {
    let reject!: (error: Error) => void;
    const stop = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const close = vi.fn(); render(<BackgroundActivityCenter open items={[item({ onStop: stop })]} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '停止任务：核对报告' }));
    const pending = screen.getByRole('button', { name: '正在停止：核对报告' });
    expect((pending as HTMLButtonElement).disabled).toBe(true); fireEvent.click(pending); expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => reject(Error('执行器尚未确认停止')));
    expect(screen.getByRole('alert').textContent).toContain('执行器尚未确认停止');
    expect((screen.getByRole('button', { name: '停止任务：核对报告' }) as HTMLButtonElement).disabled).toBe(false); expect(close).not.toHaveBeenCalled();
  });
  it('shows a successful stop receipt without removing a run until the supervisor updates the list', async () => {
    const active = item({ onStop: vi.fn(async () => {}) });
    render(<BackgroundActivityCenter open items={[active]} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '停止任务：核对报告' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '停止任务：核对报告' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('核对报告')).toBeTruthy(); expect(screen.getByText('执行中')).toBeTruthy();
  });
  it('dismisses with Escape and restores focus to the actual trigger after unmount', () => {
    function Harness(): JSX.Element {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开任务</button>{open && <BackgroundActivityCenter open items={[]} onClose={() => setOpen(false)} />}</>;
    }
    render(<Harness />); const trigger = screen.getByRole('button', { name: '打开任务' }); trigger.focus(); fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭任务面板' }));
    fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it('ignores its own trigger in outside dismissal while allowing a real outside pointer', () => {
    const trigger = document.createElement('button'); document.body.append(trigger); const close = vi.fn();
    render(<BackgroundActivityCenter open items={[]} anchor={trigger} onClose={close} />);
    fireEvent.pointerDown(trigger); expect(close).not.toHaveBeenCalled(); fireEvent.pointerDown(document.body); expect(close).toHaveBeenCalledTimes(1); trigger.remove();
  });
});
