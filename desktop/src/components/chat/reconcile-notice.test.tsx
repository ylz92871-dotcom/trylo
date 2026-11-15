import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { applyEvents, settleOpenTools } from './events';
import { ReconcileNotice } from './ReconcileNotice';
import { installEffectReconcileHost } from './effect-reconcile-context';
import type { NoticeMessage, ChatMessage } from './types';
import type { RuntimeWarningEvent } from '../../host-adapter/loop-events';

afterEach(() => installEffectReconcileHost(null));

const blocked: RuntimeWarningEvent = {
  type: 'runtime_warning',
  id: 'warn:s1',
  seq: 9,
  ts: 1_700_000_000_000,
  code: 'effect_reconciliation_required',
  message: '上一次操作的结果没有被记录，有 1 步需要你确认；核对前这个会话不能继续。',
  reconcile: {
    sessionId: 'desktop-ddfe13cd',
    pending: [{
      turn: 'turn-758e092f',
      key: 'tool:call_00_c9syy',
      issuedAtSequence: 4557,
      issuedAt: '2026-11-11T06:27:50.607Z',
      tool: 'run_shell',
    }],
  },
};

function noticeOf(event: RuntimeWarningEvent): NoticeMessage {
  const applied = applyEvents([], [event]);
  const last = applied[applied.length - 1];
  if (last?.kind !== 'notice') throw new Error('warning did not become a notice');
  return last;
}

it('carries the unproven-effect list from the warning into the notice', () => {
  const notice = noticeOf(blocked);
  expect(notice.reconcile?.sessionId).toBe('desktop-ddfe13cd');
  expect(notice.reconcile?.pending[0]?.key).toBe('tool:call_00_c9syy');
});

it('renders the question, not just the engine sentence, when a list is attached', () => {
  render(<ReconcileNotice message={noticeOf(blocked)} />);
  expect(screen.getByText('上次操作的结果没有被记录')).toBeTruthy();
  expect(screen.getByRole('button', { name: '没有做成' })).toBeTruthy();
});

it('stays a plain notice when the warning carries no list', () => {
  const plain: RuntimeWarningEvent = { ...blocked, code: 'process_output_incomplete', message: '尾部输出未完整接收' };
  delete (plain as { reconcile?: unknown }).reconcile;
  render(<ReconcileNotice message={noticeOf(plain)} />);
  expect(screen.getByText('尾部输出未完整接收')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '没有做成' })).toBeNull();
});

const runningTool = {
  id: 'tool-1', kind: 'tool', role: 'assistant', createdAt: 0, tool: 'run_shell', status: 'running',
} as unknown as ChatMessage;

it('stops claiming 执行中 once the run died without writing results', () => {
  const applied = applyEvents([runningTool], [{ ...blocked, code: 'missing_terminal', message: '进程已结束，没有终态' }]);
  expect(applied[0]).toMatchObject({ id: 'tool-1', status: 'interrupted' });
});

it('leaves a live tool alone while the run is still going', () => {
  const applied = applyEvents([runningTool], [{ ...blocked, code: 'process_output_incomplete', message: '尾部输出未完整接收' }]);
  expect(applied[0]).toMatchObject({ id: 'tool-1', status: 'running' });
});

it('settles open tools without touching finished ones', () => {
  const done = { id: 'tool-2', kind: 'tool', role: 'assistant', createdAt: 0, tool: 'Read', status: 'done' } as unknown as ChatMessage;
  expect(settleOpenTools([runningTool, done])).toEqual([
    expect.objectContaining({ id: 'tool-1', status: 'interrupted' }),
    expect.objectContaining({ id: 'tool-2', status: 'done' }),
  ]);
});
