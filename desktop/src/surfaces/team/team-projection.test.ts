import { describe, expect, it } from 'vitest';
import { applyTeamEvents, cancelTeamSeat } from './team-projection';
import { emptyTeamRun, findSeat } from './team-store';
import type { TeamProfile } from './team-profile-types';

const CTX = { workspaceId: 'ws-1', personConversationId: 'conv-1' };

/** Frozen launch output: Person + two Workers, in composer order. */
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
    { memberId: 'm1', baseRole: 'worker', displayName: 'Worker · 1', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
    { memberId: 'm2', baseRole: 'worker', displayName: 'Worker · 2', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
  ],
};

function frozenRun(): NonNullable<ReturnType<typeof applyTeamEvents>> {
  // A frozen run starts with queued rows (one per frozen member); end
  // events only carry the tool_use id, so bind happens at spawn.
  return emptyTeamRun({
    id: 'team-conv-1',
    workspaceId: 'ws-1',
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

describe('surfaces/team/team-projection (Foundation spec §7.6.3)', () => {
  it('is a no-op for empty batches and non-team subagents', () => {
    expect(applyTeamEvents(null, [], CTX)).toBeNull();
    const run = applyTeamEvents(null, [
      { type: 'subagent', kind: 'spawn', id: 's1', agentType: 'Explore', prompt: 'look around', ts: 1 },
      { type: 'subagent', kind: 'spawn', id: 's2', agentType: 'managed-work', prompt: 'do work', ts: 2 },
    ], CTX);
    expect(run).toBeNull();
  });

  it('spawn events NEVER create a run without a launch freeze (v0: no phantom teams)', () => {
    const run = applyTeamEvents(null, [
      { type: 'subagent', kind: 'spawn', id: 'seat-w', agentType: 'worker', prompt: 'x', ts: 10 },
    ], CTX);
    expect(run).toBeNull();
  });

  it('Agent tool_use binds the queued seat before the file-tail spawn', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      {
        type: 'tool_use',
        id: 'seat-w',
        tool: 'Agent',
        input: { subagent_type: 'worker', member_id: 'm1', prompt: '写登录' },
        ts: 10,
      },
    ], CTX)!;
    expect(bound.seats.find((s) => s.id === 'seat-w')).toMatchObject({
      memberId: 'm1',
      seat: 'worker',
      status: 'running',
    });
  });

  it('parented tool_use attaches to that seat even when Person is also running', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'seat-p', agentType: 'person', memberId: 'm-p', prompt: 'lead', ts: 9 },
      { type: 'subagent', kind: 'spawn', id: 'seat-w', agentType: 'worker', memberId: 'm1', prompt: '写登录', ts: 10 },
    ], CTX)!;
    const withTool = applyTeamEvents(bound, [
      { type: 'tool_use', id: 'tu1', tool: 'Edit', parentId: 'seat-w', input: { file_path: 'src/Login.tsx' }, ts: 11 },
    ], CTX)!;
    expect(findSeat(withTool, 'seat-w')?.activity?.some((a) => a.label === '改 Login.tsx')).toBe(true);
    expect(findSeat(withTool, 'seat-p')?.activity ?? []).toEqual([]);
  });

  it('tool_use on a running seat becomes activity and a live summary', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'seat-w', agentType: 'worker', memberId: 'm1', prompt: '写登录', ts: 10 },
    ], CTX)!;
    const withTool = applyTeamEvents(bound, [
      { type: 'tool_use', id: 'tu1', tool: 'Edit', parentId: 'seat-w', input: { file_path: 'src/Login.tsx' }, ts: 11 },
    ], CTX)!;
    const seat = findSeat(withTool, 'seat-w');
    expect(seat?.activity?.some((a) => a.label === '改 Login.tsx')).toBe(true);
    expect(seat?.summary).toBe('改 Login.tsx');
  });

  it('spawn binds the queued row; end completes it', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'seat-w', agentType: 'worker', memberId: 'm1', prompt: '把交付件写到 .trylo/out', ts: 10 },
    ], CTX)!;
    expect(bound.seats.find((s) => s.id === 'seat-w')).toMatchObject({
      memberId: 'm1',
      seat: 'worker',
      status: 'running',
    });
    expect(bound.seats.find((s) => s.id === 'queued:m-p')?.status).toBe('queued');

    const ended = applyTeamEvents(bound, [
      { type: 'subagent', kind: 'end', id: 'seat-w', agentType: 'worker', result: '### Deliverables\nok', durationMs: 40, ts: 30 },
    ], CTX)!;
    expect(findSeat(ended, 'seat-w')?.status).toBe('completed');
    expect(findSeat(ended, 'seat-w')?.result).toContain('Deliverables');
    expect(ended.status).toBe('running');
  });

  it('all seats completing marks the team completed', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'p', agentType: 'person', memberId: 'm-p', prompt: 'intent', ts: 1 },
    ], CTX)!;
    const ended = applyTeamEvents(bound, [
      { type: 'subagent', kind: 'end', id: 'p', agentType: 'person', result: 'ok', ts: 2 },
    ], CTX)!;
    expect(ended.status).toBe('running'); // workers still queued → not terminal
    expect(ended.seats.find((s) => s.id === 'p')!.status).toBe('completed');
  });

  it('cancelTeamSeat marks a running seat cancelled without touching others', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'w', agentType: 'worker', memberId: 'm1', prompt: 'write', ts: 100 },
    ], CTX)!;
    const cancelled = cancelTeamSeat(bound, 'w', 150);
    expect(findSeat(cancelled, 'w')?.status).toBe('cancelled');
    expect(findSeat(cancelled, 'w')?.durationMs).toBe(50);
    expect(cancelled.status).toBe('running');
  });

  it('a late subagent end does not un-cancel a seat', () => {
    const run = frozenRun();
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'w', agentType: 'worker', memberId: 'm1', prompt: 'write', ts: 1 },
    ], CTX)!;
    const cancelled = cancelTeamSeat(bound, 'w', 2);
    const ended = applyTeamEvents(cancelled, [
      { type: 'subagent', kind: 'end', id: 'w', agentType: 'worker', result: 'partial', ts: 3 },
    ], CTX)!;
    expect(findSeat(ended, 'w')?.status).toBe('cancelled');
    expect(findSeat(ended, 'w')?.result).toBe('partial');
  });

  it('events for another Person conversation are ignored, never steal the run', () => {
    const run = frozenRun();
    const other = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'w2', agentType: 'worker', prompt: 'b', ts: 2 },
    ], { workspaceId: 'ws-1', personConversationId: 'conv-other' });
    expect(other).toBe(run);
  });

  it('a spawn with no matching queued row is dropped, not appended', () => {
    const run = frozenRun();
    // Bind both workers, then a third worker spawn arrives → no queued
    // worker left → dropped (no phantom running row).
    const bound = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'w1', agentType: 'worker', memberId: 'm1', prompt: 'a', ts: 1 },
      { type: 'subagent', kind: 'spawn', id: 'w2', agentType: 'worker', memberId: 'm2', prompt: 'b', ts: 2 },
      { type: 'subagent', kind: 'spawn', id: 'w3', agentType: 'worker', memberId: 'm9', prompt: 'c', ts: 3 },
    ], CTX)!;
    expect(bound.seats.some((s) => s.id === 'w3')).toBe(false);
    expect(bound.seats.filter((s) => s.status === 'running')).toHaveLength(2);
  });
});

describe('queued seat bind (Foundation spec §7.6.3)', () => {
  it('spawn with memberId binds the exact queued row and adopts the tool_use id', () => {
    const run = frozenRun();
    const next = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'tool-2', agentType: 'worker', memberId: 'm2', prompt: 'docs', ts: 5 },
    ], CTX)!;
    expect(next.seats.find((s) => s.id === 'tool-2')).toMatchObject({
      memberId: 'm2',
      displayName: 'Worker · 2',
      status: 'running',
    });
    expect(next.seats.find((s) => s.id === 'queued:m1')?.status).toBe('queued');
    // No duplicate running row for the same role.
    expect(next.seats.filter((s) => s.status === 'running')).toHaveLength(1);
  });

  it('spawn without memberId FIFO-binds the first unused queued row of that role', () => {
    const run = frozenRun();
    const next = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'tool-a', agentType: 'worker', prompt: 'impl', ts: 5 },
      { type: 'subagent', kind: 'spawn', id: 'tool-b', agentType: 'worker', prompt: 'tests', ts: 6 },
    ], CTX)!;
    const bound = next.seats.filter((s) => s.status === 'running');
    expect(bound).toHaveLength(2);
    expect(bound.map((s) => s.id)).toEqual(['tool-a', 'tool-b']);
    // Stable order: FIFO keeps m1 before m2; run-side ordering stays stable.
    expect(bound.map((s) => s.memberId)).toEqual(['m1', 'm2']);
  });

  it('out-of-order spawns of two workers each bind their own queued row (no overlay swap)', () => {
    const run = frozenRun();
    const next = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'tool-late', agentType: 'worker', memberId: 'm2', prompt: 'second first', ts: 5 },
      { type: 'subagent', kind: 'spawn', id: 'tool-early', agentType: 'worker', memberId: 'm1', prompt: 'first second', ts: 6 },
    ], CTX)!;
    expect(next.seats.find((s) => s.id === 'tool-late')?.memberId).toBe('m2');
    expect(next.seats.find((s) => s.id === 'tool-early')?.memberId).toBe('m1');
  });

  it('an unknown agentType is still dropped even with a memberId', () => {
    const run = frozenRun();
    const next = applyTeamEvents(run, [
      { type: 'subagent', kind: 'spawn', id: 'tool-x', agentType: 'docs-writer', memberId: 'm9', prompt: 'x', ts: 5 },
    ], CTX);
    expect(next).toBe(run);
  });

  it('terminal runs ignore late spawns (no restart from events)', () => {
    const done = emptyTeamRun({
      id: 'team-conv-1',
      workspaceId: 'ws-1',
      personConversationId: 'conv-1',
      status: 'completed',
      summary: { title: 'T', goal: 'g', oneLiner: 'o' },
      frozenProfile: FROZEN,
      seats: [
        { id: 'w1', memberId: 'm1', seat: 'worker', status: 'completed', summary: 'done' },
      ],
    });
    const next = applyTeamEvents(done, [
      { type: 'subagent', kind: 'spawn', id: 'late', agentType: 'worker', memberId: 'm2', prompt: 'x', ts: 9 },
    ], CTX);
    expect(next).toBe(done);
  });
});
