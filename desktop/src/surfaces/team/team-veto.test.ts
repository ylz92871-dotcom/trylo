// Person veto projection tests (PR-8, spec §10.4 / §20.8).
//
// The projection consumes a pre-computed veto verdict (TeamEventExtras)
// — it never parses seat output itself. Person end + vetoActive ⇒
// waiting_approval so deriveTeamStatus yields 'waiting' and the status
// bar stays visible; without extras the completed path holds.

import { describe, expect, it } from 'vitest';
import { applyTeamEvents, cancelTeamSeat, taskSummaryFromSummaryDto, type TeamSubagentEvent } from './team-projection';
import { emptyTeamRun } from './team-store';
import type { TeamProjectionContext } from './team-projection';
import type { ContractSummaryLike } from '../shared/engineering-contract';
import type { TeamProfile } from './team-profile-types';

const CTX: TeamProjectionContext = { workspaceId: 'ws', personConversationId: 'conv-1' };

const FROZEN: TeamProfile = {
  schemaVersion: 1,
  id: 'team-conv-1',
  origin: 'custom',
  surface: 'code',
  title: 'T',
  createdAt: 0,
  updatedAt: 0,
  members: [
    { memberId: 'm-p', baseRole: 'person', displayName: 'Person', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
    { memberId: 'm-w', baseRole: 'worker', displayName: 'Worker', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
  ],
};

function personEnd(id: string, result: string): TeamSubagentEvent {
  return { type: 'subagent', kind: 'end', id, agentType: 'person', result };
}

function personSpawn(id: string): TeamSubagentEvent {
  return { type: 'subagent', kind: 'spawn', id, agentType: 'person', memberId: 'm-p', prompt: '实现导出模块', ts: 100 };
}

function workerSpawn(id: string): TeamSubagentEvent {
  return { type: 'subagent', kind: 'spawn', id, agentType: 'worker', memberId: 'm-w', prompt: '改代码', ts: 200 };
}

function frozenRun() {
  return emptyTeamRun({
    id: 'team-conv-1',
    workspaceId: 'ws',
    personConversationId: 'conv-1',
    summary: { title: 'T', goal: 'g', oneLiner: 'o' },
    frozenProfile: FROZEN,
    seats: FROZEN.members.map((m) => ({
      id: `queued:${m.memberId}`,
      memberId: m.memberId,
      seat: m.baseRole,
      displayName: m.displayName,
      status: 'queued' as const,
      summary: '',
    })),
  });
}

describe('applyTeamEvents veto extras', () => {
  it('person end + vetoActive → waiting_approval (not completed); cancelled worker yields run waiting', () => {
    let run = applyTeamEvents(frozenRun(), [personSpawn('p1')], CTX);
    run = applyTeamEvents(run, [workerSpawn('w1')], CTX);
    expect(run!.seats.map((s) => s.status)).toEqual(['running', 'running']);
    run = applyTeamEvents(run, [personEnd('p1', '### Veto\ncontradicts explicit')], CTX, {
      vetoActive: true,
      vetoReason: '方案删掉了用户明确要求的验收步骤，与 explicit.acceptance 冲突。',
    });
    const person = run!.seats.find((s) => s.id === 'p1')!;
    expect(person.status).toBe('waiting_approval');
    expect(person.summary.startsWith('Person 否决')).toBe(true);
    // Worker still running while the App reacts; the status bar headline
    // picks the first running|waiting_approval seat (the veto).
    expect(run!.status).toBe('running');
    // App cancels the writable worker via cancelTeamSeat (veto effect)
    // → run derives waiting.
    const cancelled = cancelTeamSeat(run!, 'w1', 300);
    expect(cancelled.seats.find((s) => s.id === 'w1')!.status).toBe('cancelled');
    expect(cancelled.status).toBe('waiting');
  });

  it('no extras: completed behavior unchanged', () => {
    let run = applyTeamEvents(frozenRun(), [personSpawn('p1')], CTX);
    run = applyTeamEvents(run, [personEnd('p1', 'all good')], CTX);
    expect(run!.seats.find((s) => s.id === 'p1')!.status).toBe('completed');
  });

  it('the frozen run summary is authoritative; events never overwrite it', () => {
    const summary: ContractSummaryLike = {
      title: '实现最小抽象',
      goal: '给导出函数补一个稳定入口',
      oneLiner: '给导出函数补一个稳定入口，不扩散改动',
      explicit: '禁止改动数据库 schema。',
      inferred: '保留轻量扩展点 (conf 0.76)',
      baseline: '必须保留有意义的最终验证。',
    };
    const run = emptyTeamRun({
      id: 'team-conv-1',
      workspaceId: 'ws',
      personConversationId: 'conv-1',
      summary: {
        title: summary.title,
        goal: summary.goal,
        oneLiner: summary.oneLiner,
        explicit: summary.explicit,
        inferred: summary.inferred,
        baseline: summary.baseline,
      },
      frozenProfile: FROZEN,
      seats: FROZEN.members.map((m) => ({
        id: `queued:${m.memberId}`,
        memberId: m.memberId,
        seat: m.baseRole,
        displayName: m.displayName,
        status: 'queued' as const,
        summary: '',
      })),
    });
    const after = applyTeamEvents(run, [personSpawn('p1')], CTX, { contractSummary: summary })!;
    // The launch froze the summary; spawn events only bind seats.
    expect(after.summary.title).toBe(summary.title);
    expect(after.summary.explicit).toContain('禁止');
  });

  it('summary DTO mapping keeps the inferred confidence visible', () => {
    const dto: ContractSummaryLike = {
      title: 't',
      goal: 'g'.repeat(120),
      oneLiner: '',
      inferred: '保留轻量扩展点 (conf 0.76)',
    };
    const ts = taskSummaryFromSummaryDto(dto);
    expect(ts.inferred).toBe('保留轻量扩展点 (conf 0.76)');
    expect(ts.oneLiner.length).toBeLessThanOrEqual(80);
    expect(ts.goal).toBe(dto.goal);
  });
});
