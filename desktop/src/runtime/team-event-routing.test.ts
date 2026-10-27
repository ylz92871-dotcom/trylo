import { describe, expect, it } from 'vitest';
import { failTeamStart, mergeTeamProjection, routeTeamEvents } from './team-event-routing';
import { configureTeamRunsCache, loadTeamRunsForWorkspace, teamRunsSnapshot, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import { createFrozenTeamRun } from '../user-learning/team-access/profiles/launch';
import type { TeamProfile } from '../surfaces/team/team-profile-types';
import type { TeamRun } from '../surfaces/team/team-types';

const profile: TeamProfile = { schemaVersion: 1, id: 'p', origin: 'custom', surface: 'code', title: 'team', createdAt: 1, updatedAt: 1,
  members: ['person', 'worker'].map((role, index) => ({ memberId: `m${index}`, baseRole: role as 'person' | 'worker', displayName: role,
    overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } })) };
const run = (id: string, conversationId: string) => createFrozenTeamRun({ teamRunId: id, personConversationId: conversationId, goal: 'g', frozenProfile: profile, now: 1 });

describe('team event ownership', () => {
  it('closes the origin cache after confirmed stop, including a waiting member, after navigation', async () => {
    configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async () => {} });
    await loadTeamRunsForWorkspace('D:/stop-origin', 'stop-origin');
    const stopped = run('stopped-team', 'stopped-chat');
    await upsertTeamRun({ ...stopped, seats: stopped.seats.map((seat, index) => index === 0
      ? { ...seat, status: 'waiting_approval', error: 'Needs operator input' } : seat) });
    await loadTeamRunsForWorkspace('D:/other-selection', 'other-selection');
    await upsertTeamRun(run('other-team', 'other-chat'));
    const closed = routeTeamEvents({ workspaceId: 'D:/stop-origin', personConversationId: 'stopped-chat', teamRunId: 'stopped-team' }, [
      { type: 'loop_end', reason: 'cancelled', ts: 4 },
    ]);
    expect(closed?.lifecycle).toBe('closed');
    expect(closed?.seats.every(seat => seat.status === 'cancelled')).toBe(true);
    expect(teamRunsSnapshot('stop-origin')[0]?.status).toBe('cancelled');
    expect(teamRunsSnapshot()[0]?.id).toBe('other-team');
    expect(teamRunsSnapshot()[0]?.lifecycle).toBe('open');
  });
  it('normalizes an origin root to the stable UI workspace identity before merging live events', async () => {
    configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async () => {} });
    await loadTeamRunsForWorkspace('D:/identity', 'workspace-stable-id');
    await upsertTeamRun(run('team-identity', 'c-identity'));
    const current = { ...run('team-identity', 'c-identity'), workspaceId: 'workspace-stable-id', selectedSeatId: 'queued:m1' } as TeamRun;
    const projected = routeTeamEvents({ workspaceId: 'D:/identity', personConversationId: 'c-identity' }, [{
      type: 'subagent', source: 'trylo-v1', kind: 'spawn', id: 'live-worker', teamRunId: 'team-identity',
      memberId: 'm1', agentType: 'worker', status: 'running',
    }]);
    const merged = mergeTeamProjection(current, projected);
    expect(projected?.workspaceId).toBe('workspace-stable-id');
    expect(merged?.selectedSeatId).toBe('live-worker');
    expect(merged?.seats.find(seat => seat.id === 'live-worker')).toBeDefined();
  });
  it('closes only the team whose startup failed, including its actual failure reason', async () => {
    configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async () => {} });
    await loadTeamRunsForWorkspace('D:/start', 'ws-start');
    await upsertTeamRun(run('old-launch', 'c-start'));
    await upsertTeamRun({ ...run('new-launch', 'c-start'), updatedAt: 2 });
    const failed = failTeamStart({ workspaceId: 'ws-start', personConversationId: 'c-start', teamRunId: 'old-launch' }, 'Runtime refused the selected connection', 3);
    expect(failed?.id).toBe('old-launch');
    expect(failed?.lifecycle).toBe('closed');
    expect(failed?.status).toBe('failed');
    expect(failed?.seats.every(seat => seat.error?.includes('Runtime refused'))).toBe(true);
    expect(teamRunsSnapshot().find(value => value.id === 'new-launch')?.lifecycle).toBe('open');
  });
  it('updates a background conversation in its origin workspace without replacing the selected team', async () => {
    const files = new Map<string, string>();
    configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async (path, text) => { files.set(path, text); } });
    await loadTeamRunsForWorkspace('D:/a', 'wa');
    await upsertTeamRun(run('ta', 'ca'));
    await loadTeamRunsForWorkspace('D:/b', 'wb');
    await upsertTeamRun(run('tb', 'cb'));
    const current = { ...run('tb', 'cb'), workspaceId: 'wb', selectedSeatId: null } as TeamRun;
    const projected = routeTeamEvents({ workspaceId: 'wa', personConversationId: 'ca' }, [{ type: 'subagent', source: 'trylo-v1',
      kind: 'spawn', id: 'worker-a', teamRunId: 'ta', memberId: 'm1', agentType: 'worker', status: 'running' }]);
    expect(projected?.seats.find(seat => seat.id === 'worker-a')?.status).toBe('running');
    expect(mergeTeamProjection(current, projected)).toBe(current);
    expect(teamRunsSnapshot().map(value => value.id)).toEqual(['tb']);
    expect(teamRunsSnapshot('wa')[0]?.seats.find(seat => seat.id === 'worker-a')).toBeDefined();
    // Wait for queued origin persistence without changing the active workspace.
    await upsertTeamRun(teamRunsSnapshot('wa')[0]!, 'wa');
    expect(JSON.parse(files.get('D:/a/.trylo/team-runs.json')!).runs[0].seats[1].id).toBe('worker-a');
    expect(JSON.parse(files.get('D:/b/.trylo/team-runs.json')!).runs[0].id).toBe('tb');
  });

  it('preserves the selected member when recovery replaces its execution id', () => {
    const current = { ...run('t', 'c'), workspaceId: 'w', selectedSeatId: 'queued:m1' } as TeamRun;
    const projected = { ...current, seats: current.seats.map(seat => seat.memberId === 'm1' ? { ...seat, id: 'recovered' } : seat), selectedSeatId: null };
    expect(mergeTeamProjection(current, projected)?.selectedSeatId).toBe('recovered');
  });
});
