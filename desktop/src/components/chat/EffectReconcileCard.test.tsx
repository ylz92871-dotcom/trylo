import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { EffectReconcileCard } from './EffectReconcileCard';
import type { PendingEffect } from '../../runtime/effect-reconciliation';

const pending: readonly PendingEffect[] = [{
  turn: 'turn-758e092f',
  key: 'tool:call_00_c9syy',
  issuedAtSequence: 4557,
  issuedAt: '2026-11-11T06:27:50.607Z',
  tool: 'run_shell',
  arguments: { command: 'soffice --convert-to pdf' },
}];

function ask(evidence: string): void {
  fireEvent.change(screen.getByLabelText('你查到了什么'), { target: { value: evidence } });
}

it('shows what the engine could not prove instead of a dead-end notice', () => {
  render(<EffectReconcileCard pending={pending} onSettle={vi.fn()} />);
  expect(screen.getByText('上次操作的结果没有被记录')).toBeTruthy();
  expect(screen.getByText(/run_shell/)).toBeTruthy();
  expect(screen.getByText(/soffice --convert-to pdf/)).toBeTruthy();
});

it('will not record a verdict until the person says what they checked', () => {
  const onSettle = vi.fn(async () => ({ ok: true }) as const);
  render(<EffectReconcileCard pending={pending} onSettle={onSettle} />);
  const done = screen.getByRole('button', { name: '没有做成' });
  expect((done as HTMLButtonElement).disabled).toBe(true);

  ask('输出目录里没有 PDF');
  fireEvent.click(done);
  expect(onSettle).toHaveBeenCalledWith({
    key: 'tool:call_00_c9syy', turn: 'turn-758e092f', verdict: 'failed', evidence: '输出目录里没有 PDF',
  });
});

it('keeps the engine refusal visible and does not pretend the verdict landed', async () => {
  const onSettled = vi.fn();
  render(<EffectReconcileCard pending={pending} onSettle={async () => ({ ok: false, reason: 'exit_1:already recorded as committed' })} onSettled={onSettled} />);
  ask('我确认没有生成');
  fireEvent.click(screen.getByRole('button', { name: '已经做了' }));

  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already recorded as committed'));
  expect(onSettled).not.toHaveBeenCalled();
  expect(screen.getByText('上次操作的结果没有被记录')).toBeTruthy();
});

it('closes the question once the engine accepted the verdict', async () => {
  const onSettled = vi.fn();
  render(<EffectReconcileCard pending={pending} onSettle={async () => ({ ok: true })} onSettled={onSettled} />);
  ask('确认只有配置文件被改过');
  fireEvent.click(screen.getByRole('button', { name: '已经做了' }));

  await waitFor(() => expect(screen.getByText('已记录核对结果')).toBeTruthy());
  expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'committed' }));
  expect(screen.queryByRole('button', { name: '已经做了' })).toBeNull();
});
