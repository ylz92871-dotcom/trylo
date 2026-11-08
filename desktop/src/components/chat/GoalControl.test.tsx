import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GoalControl } from './GoalControl';
import type { GoalSnapshot } from '../../domain/goal';
afterEach(cleanup);
const goal: GoalSnapshot = { objective: '整理项目并验证', status: 'active', tokensUsed: 90, createdAtTurn: 't', updatedAtTurn: 't' };
describe('current chat goal mode', () => {
  it('starts an explicit goal with an optional user budget', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GoalControl draft="整理项目并验证" running={false} onAction={onAction} />);
    fireEvent.click(screen.getByText('设置目标'));
    fireEvent.change(screen.getByLabelText('Token 预算'), { target: { value: '1000' } });
    fireEvent.click(screen.getByText('开始目标'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ version: 1, action: 'create', objective: goal.objective, tokenBudget: 1000 }));
  });
  it('pauses the running goal and keeps the objective visible', () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GoalControl goal={goal} draft="" running onAction={onAction} />);
    expect(screen.getByText(goal.objective)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '暂停目标' }));
    expect(onAction).toHaveBeenCalledWith({ version: 1, action: 'pause' });
  });
  it('labels a stale active goal as interrupted rather than running in background', () => {
    render(<GoalControl goal={goal} draft="" running={false} onAction={vi.fn()} />);
    expect(screen.getByText(/执行已中断，可继续/)).toBeTruthy();
  });
  it('keeps edits pending until a new authoritative snapshot acknowledges them', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const paused = { ...goal, status: 'paused_by_user' as const, tokenBudget: 1000 };
    const { rerender } = render(<GoalControl goal={paused} draft="" running={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '修改后的目标' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ version: 1, action: 'edit', objective: '修改后的目标', tokenBudget: 1000 }));
    expect(screen.getByLabelText('目标')).toBeTruthy();
    rerender(<GoalControl goal={{ ...paused, objective: '修改后的目标', updatedAtTurn: 'edit' }} draft="" running={false} onAction={onAction} />);
    await waitFor(() => expect(screen.queryByLabelText('目标')).toBeNull());
  });
  it('pauses before editing a live goal and keeps its editor open after the pause acknowledgement', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<GoalControl goal={goal} draft="" running onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑目标' }));
    expect(onAction).toHaveBeenCalledWith({ version: 1, action: 'pause' });
    rerender(<GoalControl goal={{ ...goal, status: 'paused_by_user' }} draft="" running={false} onAction={onAction} />);
    await waitFor(() => expect((screen.getByLabelText('目标') as HTMLTextAreaElement).disabled).toBe(false));
  });
  it('requires a larger explicit total budget before resuming exhaustion', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<GoalControl goal={{ ...goal, status: 'budget_exhausted', tokenBudget: 90 }} draft="" running={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '继续目标' }));
    fireEvent.change(screen.getByLabelText('Token 预算'), { target: { value: '90' } });
    expect((screen.getByText('增加预算并继续') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Token 预算'), { target: { value: '200' } });
    fireEvent.click(screen.getByText('增加预算并继续'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ version: 1, action: 'resume', tokenBudget: 200 }));
  });
});
