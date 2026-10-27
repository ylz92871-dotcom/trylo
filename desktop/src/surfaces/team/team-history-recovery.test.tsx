import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { TeamRunView } from './run/TeamRunView';
import type { TeamRun } from './team-types';
import { FIXTURE_FROZEN_PROFILE } from './team-fixture';
afterEach(cleanup);
const run: TeamRun = { id: 'team', workspaceId: 'w', personConversationId: 'c', lifecycle: 'open', status: 'running',
  summary: { title: '核对', goal: '核对恢复', oneLiner: '核对恢复' }, frozenProfile: FIXTURE_FROZEN_PROFILE, createdAt: 1, updatedAt: 1,
  selectedSeatId: 'worker', seats: [{ id: 'worker', taskId: 'task', seat: 'worker', status: 'running', summary: '上次执行', canReceiveInput: true }] };

it('a disconnected restored member retains whole-run Stop while removing unavailable member actions', () => {
  const stop = vi.fn(); const input = vi.fn(); const cancel = vi.fn();
  render(<TeamRunView run={{ ...run, recovery: { kind: 'detached', message: '旧执行仍在，输出未连接。' } }}
    memberDrafts={new Map()} onMemberInput={input} onCancelSeat={cancel} onStopRun={stop} onSelectSeat={() => {}} />);
  expect(screen.getByText('未连接')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('输出未连接');
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('查看所有成员及当前任务'));
  fireEvent.click(screen.getByRole('button', { name: '停止' })); expect(stop).toHaveBeenCalledTimes(1);
  expect(input).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});

it('interrupted history explains the parent failure even if all members had returned', () => {
  render(<TeamRunView run={{ ...run, lifecycle: 'closed', status: 'failed', endedAt: 2, error: '执行已中断，未确认最终结果。',
    seats: run.seats.map(seat => ({ ...seat, status: 'completed', result: '保留已完成结果' })) }}
    onNewTeam={() => {}} onSelectSeat={() => {}} />);
  expect(screen.getByRole('alert')).toHaveTextContent('执行已中断');
  fireEvent.click(screen.getByLabelText('查看所有成员及当前任务'));
  expect(screen.getByRole('button', { name: '新团队' })).toBeInTheDocument();
});
