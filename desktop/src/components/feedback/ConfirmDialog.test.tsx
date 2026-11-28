import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(() => cleanup());

describe('ConfirmDialog', () => {
  it('focuses Cancel by default on danger tone, cancels on Escape, and restores opener focus', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Delete';
    document.body.appendChild(opener);
    opener.focus();

    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open={true}
        tone="danger"
        title="永久删除对话？"
        description="删除后无法恢复。"
        confirmLabel="永久删除"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const cancelBtn = screen.getByRole('button', { name: '取消' });
    expect(cancelBtn).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(
      <ConfirmDialog
        open={false}
        tone="danger"
        title="永久删除对话？"
        description="删除后无法恢复。"
        confirmLabel="永久删除"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('prevents duplicate confirm submissions while pending', async () => {
    let resolveConfirm!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { resolveConfirm = resolve; }));
    render(
      <ConfirmDialog
        open={true}
        tone="danger"
        title="永久删除对话？"
        description="删除后无法恢复。"
        confirmLabel="永久删除"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const confirmBtn = screen.getByRole('button', { name: '永久删除' });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm();
    });
  });
});
