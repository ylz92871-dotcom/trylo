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
    await upsertTeamRun(toPersistableTeamRun({ ...run(), selectedSeatId: 'queued:m1' }));
    expect(writes[0]!.body.includes('selectedSeatId')).toBe(false);
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
});
