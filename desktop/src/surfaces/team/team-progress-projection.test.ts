import { describe, expect, it } from 'vitest';
import { applyTeamEvents } from './team-projection';
import { FIXTURE_TEAM_RUN } from './team-fixture';
import { parseTeamRunsFile, serializeTeamRunsFile } from '../../user-learning/team-access/persist';
import type { TeamRun } from './team-types';

const initial: TeamRun = { ...FIXTURE_TEAM_RUN, seats: [{ id: 'worker', memberId: 'member-worker', taskId: 'task-worker',
  seat: 'worker', displayName: '代码实现', status: 'running', summary: '正在定位', round: 1 }], reports: [] };
const ctx = { workspaceId: initial.workspaceId, personConversationId: initial.personConversationId };
const project = (run: TeamRun, events: readonly unknown[]): TeamRun => applyTeamEvents(run, events, ctx)!;

describe('durable team progress from runtime events', () => {
  it('records a dedicated user report separately from raw member answers and prompts', () => {
    const next = project(initial, [{ type: 'subagent', kind: 'update', id: 'worker', status: 'running', round: 1, ts: 10,
      observation: { id: 'progress-1', round: 1, kind: 'report', reportState: 'blocked', text: '文件路径不存在，需要确认导出入口。' } }]);
    expect(next.reports).toContainEqual(expect.objectContaining({ kind: 'blocked', text: '文件路径不存在，需要确认导出入口。' }));
    expect(next.seats[0]?.observations?.[0]?.kind).toBe('report');
    const stored = parseTeamRunsFile(serializeTeamRunsFile(initial.workspaceId, [next]));
    expect(stored?.runs[0]?.seats[0]?.observations).toEqual(next.seats[0]?.observations);
  });
  it('updates one streaming report, seals it, and appends the next round without broadcasting local input', () => {
    const working = project(initial, [{ type: 'subagent', kind: 'update', id: 'worker', round: 1, status: 'running', result: '定位到编码问题', ts: 10 }]);
    const delta = project(working, [{ type: 'subagent', kind: 'update', id: 'worker', round: 1, result: '定位到编码问题，正在修复', ts: 10 }]);
    expect(delta.reports).toHaveLength(1);
    expect(delta.reports?.[0]?.streaming).toBe(true);
    const delivered = project(working, [{ type: 'subagent', kind: 'end', id: 'worker', round: 1, status: 'done', result: '已修复编码问题', parked: true, canReceiveInput: true, ts: 11 }]);
    const next = project(delivered, [{ type: 'subagent', kind: 'update', id: 'worker', round: 2, status: 'running', prompt: '只补充空格用例', result: '开始检查空格路径', ts: 12 }]);
    expect(next.reports?.map(report => report.text)).toEqual(['已修复编码问题', '开始检查空格路径']);
    expect(next.reports?.[0]?.streaming).toBe(false);
    expect(next.reports?.some(report => report.text.includes('只补充空格用例'))).toBe(false);
    expect(working.reports?.[0]?.text).toBe('定位到编码问题');
    expect(next.seats[0]?.awaitingInput).toBe(false);
  });

  it('preserves a finished report when a later correction arrives', () => {
    const first = project(initial, [{ type: 'subagent', kind: 'update', id: 'worker', round: 1, status: 'waiting', canReceiveInput: true, result: '初步检查完成', ts: 10 }]);
    const corrected = project(first, [{ type: 'subagent', kind: 'update', id: 'worker', round: 1, status: 'waiting', canReceiveInput: true, result: '补充说明：覆盖写入仍待核对', ts: 11 }]);
    const replay = project(corrected, [{ type: 'subagent', kind: 'update', id: 'worker', round: 1, status: 'waiting', canReceiveInput: true, result: '补充说明：覆盖写入仍待核对', ts: 11 }]);
    expect(replay.reports?.map(report => report.text)).toEqual(['初步检查完成', '补充说明：覆盖写入仍待核对']);
    expect(replay.seats[0]?.awaitingInput).toBe(true);
  });

  it('shows actual send_input queue receipts and preserves the exchange through disk serialization', () => {
    const next = project(initial, [
      { type: 'tool_use', id: 'exchange', tool: 'send_input', source: 'trylo-v1', input: { target: 'task-worker', message: '继续核对覆盖写入' }, ts: 10 },
      { type: 'tool_result', id: 'exchange', tool: 'send_input', source: 'trylo-v1', ok: true, output: JSON.stringify({ value: { delivery: 'queued', task_id: 'task-worker' } }), ts: 11 },
    ]);
    expect(next.handoffs?.[0]).toMatchObject({ toSeatId: 'worker', status: 'queued', at: 10, settledAt: 11 });
    expect(next.handoffs?.[0]?.fromSeatId).toBeUndefined();
    const stored = parseTeamRunsFile(serializeTeamRunsFile(initial.workspaceId, [next]));
    expect(stored?.runs[0]?.handoffs).toEqual(next.handoffs);
    expect(stored?.runs[0]?.reports).toEqual(next.reports);
  });

  it('does not fabricate a handoff for unknown targets, other conversations, or closed runs', () => {
    const events = [{ type: 'tool_use', id: 'exchange', tool: 'send_input', input: { target: 'unrelated', message: 'hello' }, ts: 10 }];
    expect(project(initial, events).handoffs).toBeUndefined();
    expect(applyTeamEvents(initial, [{ ...events[0], input: { target: 'worker', message: 'hello' } }], { ...ctx, personConversationId: 'other' })).toBe(initial);
    const closed = { ...initial, endedAt: 9, lifecycle: 'closed' as const };
    expect(project(closed, events)).toBe(closed);
  });

  it('retains delivery errors and rejects malformed persisted report facts', () => {
    const next = project(initial, [
      { type: 'tool_use', id: 'failed-exchange', tool: 'send_input', input: { target: 'worker', message: '继续' }, ts: 10 },
      { type: 'tool_result', id: 'failed-exchange', ok: false, output: '成员已关闭', ts: 11 },
    ]);
    expect(next.handoffs?.[0]).toMatchObject({ status: 'failed', error: '成员已关闭' });
    const json = JSON.parse(serializeTeamRunsFile(initial.workspaceId, [next])) as { runs: Record<string, unknown>[] };
    json.runs[0]!.reports = [{ id: 'unsafe', seatId: 'worker', kind: 'report', text: 123 }];
    expect(parseTeamRunsFile(JSON.stringify(json))).toBeNull();
  });
});
