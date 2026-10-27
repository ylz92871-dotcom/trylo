import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchRestoredTeamHistory } from './watch-restored-team-history';
import { configureTeamRunsCache, loadTeamRunsForWorkspace, teamRunsSnapshot, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import { createFrozenTeamRun } from '../user-learning/team-access/profiles/launch';
import { FIXTURE_FROZEN_PROFILE } from '../surfaces/team/team-fixture';
import type { TeamRun } from '../surfaces/team/team-types';

beforeEach(async () => {
  vi.useFakeTimers();
  configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async () => {} });
  await loadTeamRunsForWorkspace('D:/watch-history', 'watch-workspace');
  const run = createFrozenTeamRun({ teamRunId: 'watched-team', personConversationId: 'watched-chat', goal: 'watch', frozenProfile: FIXTURE_FROZEN_PROFILE, now: 1 });
  await upsertTeamRun({ ...run, seats: run.seats.map((seat, index) => index === 0
    ? { ...seat, status: 'completed', result: 'keep prior proof' } : { ...seat, status: 'running' }) });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function observe(inspect: () => Promise<'owned' | 'absent' | 'detached'>, hasLocalOwner = () => false) {
  const views: (TeamRun | null)[] = []; const checks: TeamRun[] = [];
  const errors: unknown[] = [];
  const stop = watchRestoredTeamHistory({ workspaceRoot: 'D:/watch-history', workspaceId: 'watch-workspace',
    conversationId: 'watched-chat', now: () => 20,
    runtime: { hasLocalOwner, inspectRestoredOwner: inspect },
    onRestored: run => views.push(run), onChecking: run => checks.push(run), onError: error => errors.push(error) });
  return { views, checks, errors, stop };
}

it('rechecks a detached root and automatically closes it after an independent exit', async () => {
  const inspect = vi.fn().mockResolvedValueOnce('detached').mockResolvedValueOnce('absent');
  const watcher = observe(inspect);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.views.at(-1)?.recovery?.kind).toBe('detached');
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.views.at(-1)).toMatchObject({ lifecycle: 'closed', status: 'failed' });
    expect(watcher.views.at(-1)?.seats[0]).toMatchObject({ status: 'completed', result: 'keep prior proof' });
    expect(inspect).toHaveBeenCalledTimes(2); expect(watcher.checks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { watcher.stop(); }
});

it('retries unavailable ownership without manufacturing exit on the failed read', async () => {
  const inspect = vi.fn().mockRejectedValueOnce(new Error('native unavailable')).mockResolvedValueOnce('absent');
  const watcher = observe(inspect);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.views.at(-1)?.recovery?.kind).toBe('unavailable');
    expect(teamRunsSnapshot('watch-workspace')[0]?.lifecycle).toBe('open');
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.views.at(-1)?.lifecycle).toBe('closed');
  } finally { watcher.stop(); }
});

it('waits for the current check to settle before scheduling another one', async () => {
  let release!: (value: 'detached') => void;
  const inspect = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue('detached');
  const watcher = observe(inspect);
  try {
    await vi.advanceTimersByTimeAsync(10_000); expect(inspect).toHaveBeenCalledOnce();
    release('detached'); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999); expect(inspect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(inspect).toHaveBeenCalledTimes(2);
  } finally { release?.('detached'); watcher.stop(); }
});

it('stops querying once a local owner takes over', async () => {
  let owned = false;
  const inspect = vi.fn().mockResolvedValue('detached');
  const watcher = observe(inspect, () => owned);
  try {
    await vi.advanceTimersByTimeAsync(0); owned = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.views.at(-1)).not.toHaveProperty('recovery');
    await vi.advanceTimersByTimeAsync(5000); expect(inspect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { watcher.stop(); }
});

it('cancels a late absent response without mutating history or delivering it', async () => {
  let release!: (value: 'absent') => void;
  const watcher = observe(() => new Promise(resolve => { release = resolve; }));
  watcher.stop(); release('absent'); await vi.advanceTimersByTimeAsync(1000);
  expect(watcher.views).toEqual([]); expect(teamRunsSnapshot('watch-workspace')[0]?.lifecycle).toBe('open');
  expect(vi.getTimerCount()).toBe(0);
});

it('disposal clears an already scheduled next inspection', async () => {
  const inspect = vi.fn().mockResolvedValue('detached'); const watcher = observe(inspect);
  await vi.advanceTimersByTimeAsync(0); watcher.stop();
  await vi.advanceTimersByTimeAsync(5000); expect(inspect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('reports an unexpected observer failure and permits a later successful check', async () => {
  const owned = vi.fn().mockImplementationOnce(() => { throw new Error('unexpected owner read failure'); }).mockReturnValue(false);
  const watcher = observe(async () => 'absent', owned);
  try {
    await vi.advanceTimersByTimeAsync(0); expect(watcher.errors.map(String)).toContain('Error: unexpected owner read failure');
    expect(teamRunsSnapshot('watch-workspace')[0]?.lifecycle).toBe('open');
    await vi.advanceTimersByTimeAsync(1000); expect(watcher.views.at(-1)?.lifecycle).toBe('closed');
  } finally { watcher.stop(); }
});

it('does not republish unchanged disconnected views on every poll', async () => {
  const inspect = vi.fn().mockResolvedValue('detached'); const watcher = observe(inspect);
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(inspect).toHaveBeenCalledTimes(4);
    expect(watcher.views).toHaveLength(1);
  } finally { watcher.stop(); }
});

it('rechecks a changed open snapshot after a concurrent history update wins over an older absence check', async () => {
  let first = true;
  const inspect = vi.fn(async () => {
    if (first) {
      first = false;
      await upsertTeamRun({ ...teamRunsSnapshot('watch-workspace')[0]!, updatedAt: 3 });
    }
    return 'absent' as const;
  });
  const watcher = observe(inspect);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.views.at(-1)?.lifecycle).toBe('open');
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.views.at(-1)?.lifecycle).toBe('closed');
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally { watcher.stop(); }
});

it('keeps reconnected output in its original cache after navigation, without replacing the new visible team', async () => {
  let live = true; let reads = 0; let selected = true;
  const views: (TeamRun | null)[] = [];
  const recoverTeamOutput = vi.fn(async () => {
    reads += 1;
    if (reads === 2) live = false;
    return { process: { id: 'root', pid: 1, projectKey: 'D:/watch-history', conversationId: 'watched-chat',
      identity: { teamRunId: 'watched-team', turnId: 'turn' } }, live, sessionId: 'session', acknowledge() {},
      events: live ? [] : [{ type: 'loop_end' as const, reason: 'cancelled', ts: 40, seq: 0,
        durationMs: 39, totalCost: 0, numTurns: 1, finalResult: '' }] };
  });
  const stop = watchRestoredTeamHistory({ workspaceRoot: 'D:/watch-history', workspaceId: 'watch-workspace', conversationId: 'watched-chat',
    runtime: { hasLocalOwner: () => false, hasRecoveredOwner: () => live,
      inspectRestoredOwner: async () => 'detached', recoverTeamOutput }, isCurrent: () => selected,
    onRestored: run => views.push(run), onError: error => { throw error; } });
  await vi.advanceTimersByTimeAsync(0);
  expect(views).toHaveLength(1);
  selected = false; stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(teamRunsSnapshot('watch-workspace')[0]).toMatchObject({ lifecycle: 'closed', status: 'cancelled' });
  expect(views).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(recoverTeamOutput).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
