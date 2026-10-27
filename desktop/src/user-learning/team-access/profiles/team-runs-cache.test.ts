// team-runs-cache tests (Foundation spec §9.3 / Pitfall 22).

import { describe, expect, it, vi } from 'vitest';
import {
  configureTeamRunsCache,
  isTeamRunsFileCorrupted,
  loadTeamRunsForWorkspace,
  selectRunForConversation,
  teamMarksFromRuns,
  teamRunsSnapshot,
  toPersistableTeamRun,
  upsertTeamRun,
} from './team-runs-cache';
import type { PersistableTeamRun } from '../persist';

function run(overrides: Partial<PersistableTeamRun> = {}): PersistableTeamRun {
  return {
    id: 'team-conv-1',
    personConversationId: 'conv-1',
    status: 'running',
    summary: { title: 'T', goal: 'g', oneLiner: 'o' },
    seats: [
      { id: 'queued:m1', memberId: 'm1', seat: 'worker', displayName: 'Worker', status: 'queued', summary: '' },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function memoryIo(initial?: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
  const writes: { path: string; body: string }[] = [];
  return {
    files,
    writes,
    io: {
      readFile: async (path: string) => {
        const body = files.get(path);
        if (body === undefined) throw new Error('missing');
        return body;
      },
      writeFile: async (path: string, body: string) => {
        writes.push({ path, body });
        files.set(path, body);
      },
    },
  };
}

describe('team-runs-cache', () => {
  it('routes a background workspace save to its own history after a workspace switch', async () => {
    const { io, files } = memoryIo();
    configureTeamRunsCache(io);
    await loadTeamRunsForWorkspace('D:/first', 'ws-first');
    await upsertTeamRun(run({ id: 'first' }));
    await loadTeamRunsForWorkspace('D:/second', 'ws-second');
    await upsertTeamRun(run({ id: 'second' }));
    const save = upsertTeamRun as (value: PersistableTeamRun, workspace?: string) => Promise<void>;
    await save(run({ id: 'first', status: 'completed', updatedAt: 9 }), 'ws-first');
    expect(teamRunsSnapshot().map(value => value.id)).toEqual(['second']);
    expect(JSON.parse(files.get('D:/first/.trylo/team-runs.json')!).runs[0].status).toBe('completed');
    expect(JSON.parse(files.get('D:/second/.trylo/team-runs.json')!).runs.map((value: { id: string }) => value.id)).toEqual(['second']);
  });

  it('merges events received during a slow initial history read before saving', async () => {
    const { io, files } = memoryIo();
    let release: ((value: string) => void) | undefined;
    const read = new Promise<string>(resolve => { release = resolve; });
    io.readFile = async () => read;
    configureTeamRunsCache(io);
    const loading = loadTeamRunsForWorkspace('D:/proj', 'ws');
    const saving = upsertTeamRun(run({ id: 'new' }));
    release?.(JSON.stringify({ schemaVersion: 2, workspaceId: 'ws', runs: [run({ id: 'old' })] }));
    await Promise.all([loading, saving]);
    expect(teamRunsSnapshot()).toHaveLength(2);
    expect(JSON.parse(files.get('D:/proj/.trylo/team-runs.json')!).runs).toHaveLength(2);
  });
  it('serializes overlapping saves so an older disk write cannot erase a newer run', async () => {
    const files = new Map<string, string>();
    const gates: (() => void)[] = [];
    configureTeamRunsCache({
      readFile: async () => { throw new Error('missing'); },
      writeFile: async (path, body) => {
        await new Promise<void>(resolve => { gates.push(resolve); });
        files.set(path, body);
      },
    });
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    const first = upsertTeamRun(run());
    const second = upsertTeamRun(run({ id: 'second', personConversationId: 'conv-2' }));
    await Promise.resolve();
    await Promise.resolve();
    const startedTogether = gates.length;
    // Always release the unfixed implementation too, so red tests do not leak work.
    gates[0]?.();
    await first;
    await Promise.resolve();
    gates[1]?.();
    await second;
    expect(startedTogether).toBe(1);
    expect(JSON.parse(files.get('D:/proj/.trylo/team-runs.json')!).runs).toHaveLength(2);
  });

  it('re-entering the same workspace preserves its loaded in-memory runs', async () => {
    const { io } = memoryIo();
    configureTeamRunsCache(io);
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    await upsertTeamRun(run());
    io.readFile = async () => { throw new Error('temporarily unavailable'); };
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    expect(teamRunsSnapshot()).toHaveLength(1);
  });

  it('does not overwrite a corrupt history when a new run is saved', async () => {
    const { io, files, writes } = memoryIo({ 'D:/proj/.trylo/team-runs.json': '{broken' });
    configureTeamRunsCache(io);
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await upsertTeamRun(run());
      expect(teamRunsSnapshot()).toHaveLength(1);
      expect(files.get('D:/proj/.trylo/team-runs.json')).toBe('{broken');
      expect(writes).toHaveLength(0);
      expect(isTeamRunsFileCorrupted()).toBe(true);
    } finally { warn.mockRestore(); }
  });
  it('upsert keeps runs from OTHER conversations and rewrites the full file', async () => {
    const { io, writes } = memoryIo();
    configureTeamRunsCache(io);
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    await upsertTeamRun(run({ id: 'team-conv-1', personConversationId: 'conv-1', status: 'completed' }));
    await upsertTeamRun(run({ id: 'team-conv-2', personConversationId: 'conv-2', status: 'completed', updatedAt: 3 }));
    // Re-saving conversation 1 must not wipe conversation 2 (Pitfall 22).
    await upsertTeamRun(run({ id: 'team-conv-1', personConversationId: 'conv-1', status: 'completed', updatedAt: 9 }));
    expect(teamRunsSnapshot()).toHaveLength(2);
    expect(writes).toHaveLength(3);
    const last = JSON.parse(writes[2]!.body);
    expect(last.runs).toHaveLength(2);
  });

  it('strips the UI-only selectedSeatId before persisting (Pitfall 17)', async () => {
    const { io, writes } = memoryIo();
    configureTeamRunsCache(io);
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    await upsertTeamRun(toPersistableTeamRun({ ...run(), selectedSeatId: 'queued:m1', recovery: { kind: 'checking', message: 'checking' } }));
    expect(writes[0]!.body.includes('selectedSeatId')).toBe(false);
    expect(writes[0]!.body.includes('recovery')).toBe(false);
  });

  it('marks: active beats past; conversations with only terminal runs are past', async () => {
    const marks = teamMarksFromRuns([
      run({ personConversationId: 'a', status: 'running' }),
      run({ personConversationId: 'b', status: 'completed' }),
      run({ personConversationId: 'c', status: 'failed' }),
    ]);
    expect(marks.get('a')).toBe('active');
    expect(marks.get('b')).toBe('past');
    expect(marks.get('c')).toBe('past');
  });

  it('selectRunForConversation prefers the non-terminal run over newer terminal ones', () => {
    const runs = [
      run({ id: 'old', personConversationId: 'a', status: 'completed', updatedAt: 50 }),
      run({ id: 'live', personConversationId: 'a', status: 'waiting', updatedAt: 10 }),
    ];
    expect(selectRunForConversation(runs, 'a')?.id).toBe('live');
    expect(selectRunForConversation(runs, 'missing')).toBeNull();
  });

  it('selects the latest live launch when older history contains an interrupted live run', () => {
    expect(selectRunForConversation([run({ id: 'stale', updatedAt: 1 }), run({ id: 'current', updatedAt: 9 })], 'conv-1')?.id).toBe('current');
  });

  it('unreadable file ⇒ empty cache, corrupted flag, file NOT deleted', async () => {
    const { io, files } = memoryIo({ 'D:/proj/.trylo/team-runs.json': '{broken' });
    configureTeamRunsCache(io);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    warn.mockRestore();
    expect(teamRunsSnapshot()).toEqual([]);
    expect(isTeamRunsFileCorrupted()).toBe(true);
    // The bad file survives.
    expect(files.has('D:/proj/.trylo/team-runs.json')).toBe(true);
  });

  it('migrated v1 content round-trips through the cache with legacy ids', async () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      workspaceId: 'ws',
      runs: [run({ seats: [{ id: 'p1', seat: 'person', status: 'running', summary: 's' }] })],
    });
    const { io } = memoryIo({ 'D:/proj/.trylo/team-runs.json': v1 });
    configureTeamRunsCache(io);
    await loadTeamRunsForWorkspace('D:/proj', 'ws');
    expect(teamRunsSnapshot()[0]!.seats[0]!.memberId).toBe('legacy-person-p1');
  });

  it('retries an identical failed save without replacing or reordering the cached fact snapshot', async () => {
    const files = new Map<string, string>(); let rejectWrite = true;
    configureTeamRunsCache({ readFile: async () => { throw new Error('missing'); }, writeFile: async (path, body) => {
      if (rejectWrite) throw new Error('disk unavailable'); files.set(path, body);
    } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await loadTeamRunsForWorkspace('D:/proj', 'ws'); await upsertTeamRun(run());
      const original = teamRunsSnapshot()[0]!;
      rejectWrite = false;
      await upsertTeamRun(toPersistableTeamRun({ ...original, workspaceId: 'ws', recovery: { kind: 'checking' } }));
      expect(teamRunsSnapshot()[0]).toBe(original);
      expect(JSON.parse(files.get('D:/proj/.trylo/team-runs.json')!).runs[0].id).toBe(original.id);
      expect(files.get('D:/proj/.trylo/team-runs.json')).not.toContain('recovery');
    } finally { warn.mockRestore(); }
  });
});
