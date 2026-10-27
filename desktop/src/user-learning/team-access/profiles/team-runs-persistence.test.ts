import { expect, it, vi } from 'vitest';
import { commitTeamRuns, type TeamRunsStorage } from './team-runs-persistence';
import { createFrozenTeamRun } from './launch';
import { FIXTURE_FROZEN_PROFILE } from '../../../surfaces/team/team-fixture';
import { parseTeamRunsFile, serializeTeamRunsFile } from '../persist';
import { configureTeamRunsCache, isTeamRunsFileCorrupted, loadTeamRunsForWorkspace, subscribeTeamRuns, teamRunsSnapshot, upsertTeamRun } from './team-runs-cache';

const run = (id: string, at = 1) => createFrozenTeamRun({ teamRunId: id, personConversationId: `chat-${id}`, goal: 'verify',
  frozenProfile: FIXTURE_FROZEN_PROFILE, now: at });
function storage(initial: string | null) {
  let raw = initial;
  const port: TeamRunsStorage = { load: async () => raw, save: async (_root, expected, json) => {
    if (raw !== expected) return { status: 'conflict', current: raw };
    raw = json; return { status: 'written' };
  } };
  return { port, get: () => raw, set: (value: string | null) => { raw = value; } };
}

it('merges concurrent independent writers by changed run id instead of replacing their full stale caches', async () => {
  const original = serializeTeamRunsFile('w', [run('original')]);
  const disk = storage(original);
  await Promise.all(['a', 'b'].map(id => commitTeamRuns(disk.port, 'root', 'w', original,
    [{ version: 1, run: run(id, 2) }], () => true)));
  expect(parseTeamRunsFile(disk.get()!)!.runs.map(value => value.id).sort()).toEqual(['a', 'b', 'original']);
});

it('a stale absence closure cannot overwrite a peer actual completion, even with a later interruption timestamp', async () => {
  const original = run('same');
  const initial = serializeTeamRunsFile('w', [original]);
  const completed = { ...original, status: 'completed' as const, lifecycle: 'closed' as const, updatedAt: 8, endedAt: 8 };
  const disk = storage(serializeTeamRunsFile('w', [completed]));
  const saved = await commitTeamRuns(disk.port, 'root', 'w', initial, [{ version: 1, onlyIfUnchanged: original,
    run: { ...original, status: 'failed', lifecycle: 'closed', updatedAt: 9, endedAt: 9 } }], () => true);
  expect(saved?.runs[0]).toMatchObject({ status: 'completed', endedAt: 8 });
});

it('later authoritative output replaces an early absence closure while preserving an unrelated peer run', async () => {
  const original = run('same');
  const initial = serializeTeamRunsFile('w', [original]);
  const disk = storage(serializeTeamRunsFile('w', [{ ...original, status: 'failed', lifecycle: 'closed', updatedAt: 9, endedAt: 9 }, run('peer')]));
  const saved = await commitTeamRuns(disk.port, 'root', 'w', initial, [{ version: 1,
    run: { ...original, status: 'completed', lifecycle: 'closed', updatedAt: 8, endedAt: 8 } }], () => true);
  expect(saved?.runs.find(value => value.id === 'same')).toMatchObject({ status: 'completed' });
  expect(saved?.runs.some(value => value.id === 'peer')).toBe(true);
});

it('a slow native write cannot roll back a newer in-memory projection or erase its next save', async () => {
  const disk = storage(serializeTeamRunsFile('w', [run('same')]));
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const originalSave = disk.port.save; let first = true;
  const port: TeamRunsStorage = { ...disk.port, save: async (...args) => {
    if (first) { first = false; started(); await held; }
    return originalSave(...args);
  } };
  configureTeamRunsCache({ readFile: async () => disk.get()!, writeFile: async () => {}, storage: port });
  await loadTeamRunsForWorkspace('root', 'w');
  const versions: number[] = [];
  const off = subscribeTeamRuns(() => versions.push(teamRunsSnapshot('w')[0]?.updatedAt ?? 0));
  try {
    const firstWrite = upsertTeamRun(run('same', 2), 'w');
    await entered;
    const secondWrite = upsertTeamRun(run('same', 3), 'w');
    release(); await Promise.all([firstWrite, secondWrite]);
    expect(teamRunsSnapshot('w')[0]?.updatedAt).toBe(3);
    expect(parseTeamRunsFile(disk.get()!)!.runs[0]?.updatedAt).toBe(3);
    expect(versions.slice(versions.indexOf(3))).not.toContain(2);
  } finally { release(); off(); }
});

it('adopts a peer completion in the cache when a conditional interrupted projection becomes stale', async () => {
  const original = run('same');
  const disk = storage(serializeTeamRunsFile('w', [original]));
  configureTeamRunsCache({ readFile: async () => disk.get()!, writeFile: async () => {}, storage: disk.port });
  await loadTeamRunsForWorkspace('root', 'w');
  const completed = { ...original, status: 'completed' as const, lifecycle: 'closed' as const, updatedAt: 8, endedAt: 8,
    seats: original.seats.map(seat => ({ ...seat, status: 'completed' as const, result: 'peer proof', endedAt: 8 })) };
  disk.set(serializeTeamRunsFile('w', [completed]));
  await upsertTeamRun({ ...original, status: 'failed', lifecycle: 'closed', updatedAt: 9, endedAt: 9 }, 'w', { onlyIfUnchanged: original });
  expect(teamRunsSnapshot('w')[0]).toMatchObject({ status: 'completed', endedAt: 8 });
  expect(teamRunsSnapshot('w')[0]?.seats[0]?.result).toBe('peer proof');
});

it('retries all uncommitted local runs after a failed save instead of losing the earlier dirty run', async () => {
  const disk = storage(null); const originalSave = disk.port.save; let fail = true;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  configureTeamRunsCache({ readFile: async () => '', writeFile: async () => {}, storage: { ...disk.port, save: async (...args) => {
    if (fail) { fail = false; throw new Error('isolated write refusal'); }
    return originalSave(...args);
  } } });
  try {
    await loadTeamRunsForWorkspace('root', 'w');
    await upsertTeamRun(run('a'), 'w'); expect(disk.get()).toBeNull();
    await upsertTeamRun(run('b'), 'w');
    expect(parseTeamRunsFile(disk.get()!)!.runs.map(value => value.id).sort()).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledOnce();
  } finally { warn.mockRestore(); }
});

it('keeps the corruption hint and refuses persistence when Native load returns an invalid original', async () => {
  const raw = 'original malformed history'; const disk = storage(raw);
  const save = vi.spyOn(disk.port, 'save'); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  configureTeamRunsCache({ readFile: async () => raw, writeFile: async () => {}, storage: disk.port });
  try {
    await loadTeamRunsForWorkspace('root', 'w');
    expect(isTeamRunsFileCorrupted('w')).toBe(true);
    await upsertTeamRun(run('new'), 'w');
    expect(save).not.toHaveBeenCalled(); expect(disk.get()).toBe(raw);
  } finally { save.mockRestore(); warn.mockRestore(); }
});
