import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from './ToastHost';
import { clearToasts, pushToast } from './toast-store';

describe('ToastHost & toast-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
    cleanup();
    vi.useRealTimers();
  });

  it('deduplicates repeated ids and auto-dismisses info toasts without stealing focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    render(<ToastHost />);
    act(() => {
      pushToast({ id: 'copy-path', tone: 'success', title: '已复制文件路径' });
      pushToast({ id: 'copy-path', tone: 'success', title: '已复制文件路径' });
    });

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(document.activeElement).toBe(input);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole('status')).toBeNull();
    input.remove();
  });

  it('keeps error toasts persistent until explicitly closed', () => {
    render(<ToastHost />);
    act(() => {
      pushToast({ id: 'err', tone: 'error', title: '预览不可用', detail: '端口未响应' });
    });

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('预览不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('端口未响应');

    fireEvent.click(screen.getByRole('button', { name: '关闭通知：预览不可用' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('runs undo action once and dismisses the toast, pausing timer while hovered', async () => {
    const onUndo = vi.fn();
    render(<ToastHost />);
    act(() => {
      pushToast({
        id: 'archive:1',
        tone: 'info',
        title: '已归档「示例任务」',
        action: { label: '撤销', onAction: onUndo },
        durationMs: 5500,
      });
    });

    const toast = screen.getByRole('status');
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
