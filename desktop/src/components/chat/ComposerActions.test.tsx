import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerActions } from './ComposerActions';

describe('composer actions', () => {
  it('opens from the plus button, navigates by keyboard and returns focus on Escape', () => {
    render(<ComposerActions onAdd={vi.fn()} onGoal={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '添加和设置' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '添加文件或图片' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('设置目标');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('routes each action once and dismisses on outside pointer input', () => {
    const onAdd = vi.fn();
    const onGoal = vi.fn();
    render(<ComposerActions onAdd={onAdd} onGoal={onGoal} />);
    const trigger = screen.getByRole('button', { name: '添加和设置' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: '添加文件或图片' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: /设置目标/ }));
    expect(onGoal).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
