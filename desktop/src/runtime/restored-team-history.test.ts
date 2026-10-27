import { beforeEach, expect, it, vi } from 'vitest';
import { restoreTeamHistory, type RestoreTeamHistoryInput } from './restored-team-history';
import { configureTeamRunsCache, loadTeamRunsForWorkspace, selectRunForConversation, teamRunsSnapshot, upsertTeamRun } from '../user-learning/team-access/profiles/team-runs-cache';
import { createFrozenTeamRun } from '../user-learning/team-access/profiles/launch';
import type { TeamProfile } from '../surfaces/team/team-profile-types';
import type { TeamRun } from '../surfaces/team/team-types';
import { IncompleteTeamOutputError } from './recovered-team-output';

const profile: TeamProfile = { schemaVersion: 1, id: 'p', origin: 'builtin', surface: 'code', title: 'test', createdAt: 1, updatedAt: 1,
  members: ['person', 'worker', 'reviewer'].map((baseRole, i) => ({ memberId: `m${i}`, baseRole: baseRole as 'person' | 'worker' | 'reviewer',
    displayName: baseRole, overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } })) };
const root = 'D:/reloaded-history';
const files = new Map<string, string>();
const seed = (id = 'team', chat = 'chat') => createFrozenTeamRun({ teamRunId: id, personConversationId: chat, goal: 'verify', frozenProfile: profile, now: 1 });
const input = (patch: Partial<RestoreTeamHistoryInput> = {}): RestoreTeamHistoryInput => ({ workspaceRoot: root, workspaceId: 'workspace',
  conversationId: 'chat', runtime: { hasLocalOwner: () => false, inspectRestoredOwner: async () => 'absent' }, now: () => 10, ...patch });
beforeEach(async () => {
  files.clear(); configureTeamRunsCache({ readFile: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
    writeFile: async (path, body) => { files.set(path, body); } });
  await loadTeamRunsForWorkspace(root, 'workspace');
  await upsertTeamRun({ ...seed(), seats: seed().seats.map((seat, i) => i === 0 ? { ...seat, status: 'completed', result: 'keep this result', endedAt: 2 }
    : { ...seat, status: i === 1 ? 'running' : 'queued', canReceiveInput: true }) });
});

it('absent native ownership closes stale open history as interrupted, preserving completed results', async () => {
  const restored = await restoreTeamHistory(input());
  expect(restored).toMatchObject({ status: 'failed', lifecycle: 'closed', endedAt: 10, error: expect.stringContaining('中断') });
  expect(restored?.seats[0]).toMatchObject({ status: 'completed', result: 'keep this result' });
  expect(restored?.seats.slice(1).every(seat => seat.status === 'failed' && !seat.canReceiveInput)).toBe(true);
  const durable = JSON.parse(files.get(`${root}/.trylo/team-runs.json`)!).runs[0];
  expect(durable).toMatchObject({ lifecycle: 'closed', status: 'failed' });
  expect(durable).not.toHaveProperty('recovery');
});

it('uses retained member completion before absence from the live process table', async () => {
  const original = teamRunsSnapshot('workspace')[0]!;
  const inspect = vi.fn(async () => 'absent' as const);
  const acknowledge = vi.fn(); const onRecoveredEvents = vi.fn();
  const events = original.seats.slice(1).map((seat, index) => ({ type: 'subagent' as const, kind: 'end' as const,
    id: seat.id, result: `retained result ${index}`, status: 'done' as const, seq: index, ts: 8 }));
  const restored = await restoreTeamHistory(input({ onRecoveredEvents,
    runtime: { hasLocalOwner: () => false, inspectRestoredOwner: inspect, recoverTeamOutput: async () => ({
      process: { id: 'root', pid: 1, projectKey: root, conversationId: 'chat', identity: { teamRunId: 'team', turnId: 'turn' } },
      events: [...events, { type: 'loop_end', reason: 'end_turn', isError: false, seq: 3, ts: 9,
        durationMs: 8, totalCost: 0, numTurns: 1, finalResult: 'retained' }], live: false, sessionId: 's', acknowledge,
    }) } }));
  expect(restored).toMatchObject({ status: 'completed', lifecycle: 'closed' });
  expect(restored?.seats[0]?.result).toBe('keep this result');
  expect(restored?.seats[1]?.result).toBe('retained result 0');
  expect(inspect).not.toHaveBeenCalled(); expect(acknowledge).toHaveBeenCalledOnce(); expect(onRecoveredEvents).toHaveBeenCalledOnce();
});

it.each(['absence', 'recovered-output'] as const)('a delayed %s save cannot replace a newly started team in the same conversation', async mode => {
  const raw = files.get(`${root}/.trylo/team-runs.json`)!;
  let release!: () => void; let entered!: () => void; let first = true;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  configureTeamRunsCache({ readFile: async () => raw, writeFile: async (path, body) => {
    if (first) { first = false; entered(); await blocked; }
    files.set(path, body);
  } });
  await loadTeamRunsForWorkspace(root, 'workspace');
  const restored = restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false, inspectRestoredOwner: async () => 'absent',
    ...(mode === 'recovered-output' ? { recoverTeamOutput: async () => ({
      process: { id: 'root', pid: 1, projectKey: root, conversationId: 'chat', identity: { teamRunId: 'team', turnId: 'old-turn' } },
      events: [], live: false, sessionId: null, acknowledge() {},
    }) } : {}) } }));
  await started;
  const newRun = { ...seed('new-team'), updatedAt: 20, createdAt: 20 };
  const saved = upsertTeamRun(newRun, 'workspace');
  release();
  try {
    const view = await restored;
    await saved;
    expect(view?.id).toBe('new-team');
    expect(selectRunForConversation(teamRunsSnapshot('workspace'), 'chat')?.id).toBe('new-team');
  } finally { release(); }
});

it('restores the same Person veto semantics as live output', async () => {
  const original = teamRunsSnapshot('workspace')[0]!;
  const result = '### Intent\n- explicit: keep acceptance\n- inferred: none\n- unknown: none\n\n### Veto\nRemoved acceptance steps. source: explicit.acceptance\n\n### User questions\nnone\n\n### Representation notes\nKeep the original requirement.';
  const restored = await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false,
    inspectRestoredOwner: async () => 'detached', recoverTeamOutput: async () => ({
      process: { id: 'root', pid: 1, projectKey: root, conversationId: 'chat', identity: { teamRunId: 'team', turnId: 'turn' } },
      events: [{ type: 'subagent', kind: 'end', id: original.seats[0]!.id, agentType: 'person', result, status: 'done', seq: 0, ts: 8 }],
      live: true, sessionId: 's', acknowledge() {},
    }) } }));
  expect(restored?.seats[0]).toMatchObject({ status: 'waiting_approval', summary: expect.stringContaining('Person 否决') });
  expect(restored?.lifecycle).toBe('open');
});

it('a detached live native root stays open with an explicit disconnected projection and without persisting the hint', async () => {
  const original = files.get(`${root}/.trylo/team-runs.json`);
  const restored = await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false, inspectRestoredOwner: async () => 'detached' } }));
  expect(restored).toMatchObject({ lifecycle: 'open', recovery: { kind: 'detached' } });
  expect(files.get(`${root}/.trylo/team-runs.json`)).toBe(original);
});

it('a failed native inspection cannot be interpreted as absence', async () => {
  const original = files.get(`${root}/.trylo/team-runs.json`);
  const restored = await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false, inspectRestoredOwner: async () => { throw new Error('native unavailable'); } } }));
  expect(restored).toMatchObject({ lifecycle: 'open', recovery: { kind: 'unavailable', message: expect.stringContaining('native unavailable') } });
  expect(files.get(`${root}/.trylo/team-runs.json`)).toBe(original);
});

it('navigation within a live local controller never inspects native ownership or interrupts its team', async () => {
  const inspectRestoredOwner = vi.fn(async () => 'absent' as const);
  const restored = await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => true, inspectRestoredOwner } }));
  expect(restored?.lifecycle).toBe('open'); expect(restored).not.toHaveProperty('recovery');
  expect(inspectRestoredOwner).not.toHaveBeenCalled();
});

it('an ended task is not reopened or inspected', async () => {
  await upsertTeamRun({ ...seed(), status: 'completed', lifecycle: 'closed', endedAt: 3, updatedAt: 3 });
  const inspectRestoredOwner = vi.fn(async () => 'absent' as const);
  expect(await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false, inspectRestoredOwner } }))).toMatchObject({ status: 'completed' });
  expect(inspectRestoredOwner).not.toHaveBeenCalled();
});

it('an expired incomplete replay cannot downgrade an already completed durable team', async () => {
  await upsertTeamRun({ ...seed(), status: 'completed', lifecycle: 'closed', endedAt: 3, updatedAt: 3 });
  const before = files.get(`${root}/.trylo/team-runs.json`);
  const restored = await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false,
    inspectRestoredOwner: async () => 'absent', recoverTeamOutput: async () => { throw new IncompleteTeamOutputError(true); } } }));
  expect(restored).toMatchObject({ status: 'completed', lifecycle: 'closed', endedAt: 3 });
  expect(files.get(`${root}/.trylo/team-runs.json`)).toBe(before);
});

it('confirmed cancellation with missing output preserves completed members and cancels only unfinished seats', async () => {
  const restored = await restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false,
    inspectRestoredOwner: async () => 'absent', recoverTeamOutput: async () => { throw new IncompleteTeamOutputError(true, true); } } }));
  expect(restored).toMatchObject({ status: 'cancelled', lifecycle: 'closed' });
  expect(restored?.seats[0]).toMatchObject({ status: 'completed', result: 'keep this result' });
  expect(restored?.seats.slice(1).every(seat => seat.status === 'cancelled')).toBe(true);
});

it('reports checking before an asynchronous native read and drops the result after selection cancellation', async () => {
  let done!: (value: 'absent') => void; let current = true;
  const checked: TeamRun[] = [];
  const restored = restoreTeamHistory(input({ isCurrent: () => current, onChecking: run => checked.push(run),
    runtime: { hasLocalOwner: () => false, inspectRestoredOwner: () => new Promise(resolve => { done = resolve; }) } }));
  expect(checked[0]).toMatchObject({ recovery: { kind: 'checking' } });
  current = false; done('absent');
  expect(await restored).toBeNull(); expect(teamRunsSnapshot('workspace')[0]?.lifecycle).toBe('open');
});

it('a live event arriving during inspection wins over its old snapshot', async () => {
  let done!: (value: 'absent') => void;
  const restored = restoreTeamHistory(input({ runtime: { hasLocalOwner: () => false,
    inspectRestoredOwner: () => new Promise(resolve => { done = resolve; }) } }));
  await upsertTeamRun({ ...teamRunsSnapshot('workspace')[0]!, updatedAt: 5, summary: { title: 'new fact', goal: 'g', oneLiner: 'new fact' } });
  done('absent');
  expect(await restored).toMatchObject({ lifecycle: 'open', summary: { title: 'new fact' } });
  expect(teamRunsSnapshot('workspace')[0]?.lifecycle).toBe('open');
});

it('only the original run changes, preserving another chat and an older terminal team', async () => {
  await upsertTeamRun({ ...seed('older'), status: 'completed', lifecycle: 'closed', endedAt: 2 });
  await upsertTeamRun(seed('sibling', 'other-chat'));
  await restoreTeamHistory(input());
  expect(teamRunsSnapshot('workspace').find(run => run.id === 'team')?.status).toBe('failed');
  expect(teamRunsSnapshot('workspace').find(run => run.id === 'sibling')?.lifecycle).toBe('open');
  expect(teamRunsSnapshot('workspace').find(run => run.id === 'older')?.status).toBe('completed');
});

it('uses the canonical project key for native ownership, independently of the history root and UI id', async () => {
  const inspectRestoredOwner = vi.fn(async () => 'absent' as const);
  await restoreTeamHistory(input({ projectKey: 'd:/reloaded-history', runtime: { hasLocalOwner: () => false, inspectRestoredOwner } }));
  expect(inspectRestoredOwner).toHaveBeenCalledWith('d:/reloaded-history', 'chat');
});

it('all answered members do not manufacture parent completion after a lost root', async () => {
  await upsertTeamRun({ ...seed(), seats: seed().seats.map(seat => ({ ...seat, status: 'completed', result: 'answer retained' })) });
  const restored = await restoreTeamHistory(input());
  expect(restored).toMatchObject({ status: 'failed', lifecycle: 'closed' });
  expect(restored?.seats.every(seat => seat.status === 'completed' && seat.result === 'answer retained')).toBe(true);
});

it('absent conversation ownership retires every unchanged open history in that chat without falling back to another stale run', async () => {
  const original = teamRunsSnapshot('workspace')[0]!;
  files.set(`${root}/.trylo/team-runs.json`, JSON.stringify({ schemaVersion: 2, workspaceId: 'workspace', runs: [{ ...seed('older-open'), updatedAt: 0 }, original] }));
  configureTeamRunsCache({ readFile: async path => files.get(path)!, writeFile: async (path, body) => { files.set(path, body); } });
  await loadTeamRunsForWorkspace(root, 'workspace');
  const restored = await restoreTeamHistory(input());
  expect(restored).toMatchObject({ id: 'team', lifecycle: 'closed', status: 'failed' });
  expect(teamRunsSnapshot('workspace').every(run => run.lifecycle === 'closed')).toBe(true);
  // App's projection effect persists again after hydration; that no-op must
  // not reorder equal-timestamp terminal runs or replace their fact snapshot.
  await upsertTeamRun(restored!, 'workspace');
  expect(selectRunForConversation(teamRunsSnapshot('workspace'), 'chat')?.id).toBe('team');
});
