// startTeamTurn tests (Foundation spec §7.6.2).

import { describe, expect, it, vi } from 'vitest';
import { startTeamTurn } from './host-launch';
import { configureTeamRunsCache, teamRunsSnapshot } from './team-runs-cache';
import type { TeamProfile } from './profile-types';
import type { UserLearningRuntime } from '../../runtime';

const PROFILE: TeamProfile = {
  schemaVersion: 1,
  id: 'small-change',
  origin: 'builtin',
  surface: 'code',
  title: '实现小改动',
  createdAt: 1,
  updatedAt: 1,
  members: [
    { memberId: 'm-p', baseRole: 'person', displayName: 'Person', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
    { memberId: 'm-w', baseRole: 'worker', displayName: 'Worker', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
  ],
};

function memoryIo() {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: async (path: string, body: string) => {
      files.set(path, body);
    },
    readFile: async (path: string) => {
      const body = files.get(path);
      if (body === undefined) throw new Error('missing');
      return body;
    },
    failingWriteFile: async () => {
      throw new Error('disk full');
    },
  };
}

type PreparedShaped = {
  systemPrompt?: string;
  start?: 'ready' | 'pending_impact' | 'blocked';
  contract?: unknown;
  teamSpawn?: unknown;
};

function fakePrepare(result: PreparedShaped): UserLearningRuntime['preparePrompt'] {
  return ((input: unknown) => ({
    systemPrompt: result.systemPrompt ?? 'BASE',
    decision: { taskId: 't' },
    taskRisk: 'medium',
    start: result.start ?? 'ready',
    ...(result.contract ? { contract: result.contract, teamSpawn: result.teamSpawn } : {}),
    captured: input,
  })) as unknown as UserLearningRuntime['preparePrompt'];
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceRoot: 'D:/proj',
    conversationId: 'conv-1',
    product: 'code' as const,
    goal: '把导出路径改成配置项',
    profile: PROFILE,
    composerLive: true,
    preparePrompt: fakePrepare({
      systemPrompt: 'BASE <trylo_team_access>decision: spawn_team</trylo_team_access>',
      contract: { contractId: 'ec_1', version: 1, teamRunId: 'team-conv-1' },
      teamSpawn: { decision: 'spawn_team', reason: 'confirmed' },
    }),
    isPersonTurnRunning: false,
    newRunId: () => 'team-conv-1',
    writeFile: memoryIo().writeFile,
    ...overrides,
  };
}

describe('startTeamTurn', () => {
  it('Stop during native ownership inspection prevents preparing or writing the new team', async () => {
    const io = memoryIo(); configureTeamRunsCache(io);
    const cancel = new AbortController();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const checking = new Promise<void>(resolve => { entered = resolve; });
    const input = baseInput({ writeFile: io.writeFile, signal: cancel.signal, inspectOwner: async () => { entered(); await held; } });
    const preparePrompt = vi.fn(input.preparePrompt);
    const launching = startTeamTurn({ ...input, preparePrompt }); await checking;
    cancel.abort(); release(); const result = await launching;
    expect(result).toMatchObject({ ok: false, reason: 'blocked', message: expect.stringContaining('取消') });
    expect(preparePrompt).not.toHaveBeenCalled(); expect(io.files.size).toBe(0); expect(teamRunsSnapshot()).toHaveLength(0);
  });

  it('Stop during the frozen profile write leaves no queued active team', async () => {
    const io = memoryIo(); configureTeamRunsCache(io);
    const cancel = new AbortController();
    const result = await startTeamTurn(baseInput({ signal: cancel.signal, writeFile: async (path: string, body: string) => {
      await io.writeFile(path, body); cancel.abort();
    } }));
    expect(result).toMatchObject({ ok: false, reason: 'blocked', message: expect.stringContaining('取消') });
    expect(teamRunsSnapshot()).toHaveLength(0);
  });

  it('Stop during history persistence closes the unstarted run instead of leaving active history', async () => {
    const io = memoryIo(); const cancel = new AbortController();
    configureTeamRunsCache({ readFile: io.readFile, writeFile: async (path, body) => {
      await io.writeFile(path, body); cancel.abort();
    } });
    const result = await startTeamTurn(baseInput({ signal: cancel.signal, writeFile: io.writeFile }));
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    expect(teamRunsSnapshot()[0]).toMatchObject({ status: 'cancelled', lifecycle: 'closed' });
    expect(JSON.parse(io.files.get('D:/proj/.trylo/team-runs.json')!).runs[0].status).toBe('cancelled');
  });
  it('refuses a detached native owner before preparing or persisting a replacement team', async () => {
    const io = memoryIo(); configureTeamRunsCache(io);
    const input = baseInput({ writeFile: io.writeFile, inspectOwner: async () => { throw new Error('旧执行仍在运行'); } });
    const preparePrompt = vi.fn(input.preparePrompt);
    const result = await startTeamTurn({ ...input, preparePrompt });
    expect(result).toMatchObject({ ok: false, reason: 'blocked', message: expect.stringContaining('旧执行仍在运行') });
    expect(preparePrompt).not.toHaveBeenCalled(); expect(io.files.size).toBe(0); expect(teamRunsSnapshot()).toHaveLength(0);
  });
  it('independent conversation launches do not share the double-click lock', async () => {
    for (const otherOrigin of [{ workspaceRoot: 'D:/other', conversationId: 'conv-1' },
      { workspaceRoot: 'D:/proj', conversationId: 'conv-2' }]) {
      const io = memoryIo();
      configureTeamRunsCache(io);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const first = startTeamTurn(baseInput({ newRunId: () => 'team-first', writeFile: async (path: string, body: string) => {
        if (path.endsWith('profile.v1.json')) await blocked;
        await io.writeFile(path, body);
      } }));
      try {
        const second = await startTeamTurn(baseInput({ ...otherOrigin, newRunId: () => 'team-second', writeFile: io.writeFile }));
        expect(second.ok).toBe(true);
      } finally {
        release();
        expect((await first).ok).toBe(true);
      }
    }
  });
  it('rejects a Code/Work profile mismatch before preparation, freeze or queue mutation', async () => {
    for (const [product, surface] of [['work', 'code'], ['code', 'work']] as const) {
      const io = memoryIo();
      configureTeamRunsCache(io);
      const preparePrompt = vi.fn(fakePrepare({ contract: { contractId: 'ec_mismatch', version: 1 } }));
      const result = await startTeamTurn(baseInput({ product, profile: { ...PROFILE, surface },
        preparePrompt, writeFile: io.writeFile }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_profile');
      expect(preparePrompt).not.toHaveBeenCalled();
      expect(io.files.size).toBe(0);
      expect(teamRunsSnapshot()).toEqual([]);
    }
  });
  it('a second launch in the same conversation retains both frozen histories', async () => {
    const io = memoryIo();
    configureTeamRunsCache(io);
    const first = await startTeamTurn(baseInput({ writeFile: io.writeFile, newRunId: () => 'team-first' }));
    const second = await startTeamTurn(baseInput({ writeFile: io.writeFile, newRunId: () => 'team-second' }));
    expect(first.ok && second.ok && first.teamRunId !== second.teamRunId).toBe(true);
    expect(teamRunsSnapshot()).toHaveLength(2);
    expect(io.files.has('D:/proj/.trylo/team/team-first/profile.v1.json')).toBe(true);
    expect(io.files.has('D:/proj/.trylo/team/team-second/profile.v1.json')).toBe(true);
  });
  it('a refused preparation leaves no queued run or frozen profile on disk', async () => {
    for (const start of ['pending_impact', 'blocked', 'ready'] as const) {
      const io = memoryIo();
      configureTeamRunsCache(io);
      const result = await startTeamTurn(baseInput({
        writeFile: io.writeFile,
        preparePrompt: fakePrepare({ start }),
      }));
      expect(result.ok).toBe(false);
      expect(teamRunsSnapshot()).toEqual([]);
      expect([...io.files.keys()]).toEqual([]);
    }
  });
  it('flag off → flag_off; no freeze, no run', async () => {
    const io = memoryIo();
    configureTeamRunsCache(io);
    const result = await startTeamTurn(baseInput({ composerLive: false, writeFile: io.writeFile }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('flag_off');
    expect(teamRunsSnapshot()).toEqual([]);
  });

  it('empty goal → empty_goal; invalid profile → invalid_profile', async () => {
    const badProfile = { ...PROFILE, members: PROFILE.members.slice(0, 1) };
    const noGoal = await startTeamTurn(baseInput({ goal: '   ' }));
    expect(noGoal.ok).toBe(false);
    if (!noGoal.ok) expect(noGoal.reason).toBe('empty_goal');
    const noWorker = await startTeamTurn(baseInput({ profile: badProfile }));
    expect(noWorker.ok).toBe(false);
    if (!noWorker.ok) expect(noWorker.reason).toBe('invalid_profile');
  });

  it('review-only (Person + Reviewer, no worker) launches', async () => {
    const io = memoryIo();
    configureTeamRunsCache(io);
    const reviewOnly: TeamProfile = {
      ...PROFILE,
      id: 'review-only',
      title: '只审不写',
      members: [
        PROFILE.members[0]!,
        { memberId: 'm-r', baseRole: 'reviewer', displayName: 'Reviewer', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
      ],
    };
    const result = await startTeamTurn(baseInput({ profile: reviewOnly, writeFile: io.writeFile }));
    expect(result.ok).toBe(true);
  });

  it('person turn running → turn_busy', async () => {
    const result = await startTeamTurn(baseInput({ isPersonTurnRunning: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('turn_busy');
  });

  it('success: freezes the profile file, queues the run, and returns the send payload', async () => {
    const io = memoryIo();
    configureTeamRunsCache(io);
    const result = await startTeamTurn(baseInput({ writeFile: io.writeFile }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.teamMode).toBe(true);
    expect(result.systemPrompt).toContain('trylo_team_access');
    // NO sibling overlay tags on the happy path (§8.4).
    expect(result.systemPrompt).not.toContain('trylo_member_overlay');
    // The freeze went to disk where the CLI will read it.
    expect(io.files.has('D:/proj/.trylo/team/team-conv-1/profile.v1.json')).toBe(true);
    // The queued run hit the cache (and therefore the file).
    expect(teamRunsSnapshot()).toHaveLength(1);
    expect(teamRunsSnapshot()[0]!.seats.map((s) => s.id)).toEqual(['queued:m-p', 'queued:m-w']);
  });

  it('preparePrompt not ready (pending_impact / blocked) → composer error, no contract run', async () => {
    const pending = await startTeamTurn(baseInput({
      preparePrompt: fakePrepare({ start: 'pending_impact' }),
    }));
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.reason).toBe('pending_impact');

    const blocked = await startTeamTurn(baseInput({
      preparePrompt: fakePrepare({ start: 'blocked', teamSpawn: { reason: '破坏性操作' } as never }),
    }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('blocked');

    const notReady = await startTeamTurn(baseInput({
      preparePrompt: fakePrepare({ start: 'ready' }),
    }));
    expect(notReady.ok).toBe(false);
    if (!notReady.ok) expect(notReady.reason).toBe('prepare_not_ready');
  });

  it('freeze write failure degrades to sibling overlay tags, never aborts (§8.4)', async () => {
    const io = memoryIo();
    configureTeamRunsCache(io);
    const overlayProfile: TeamProfile = {
      ...PROFILE,
      members: PROFILE.members.map((m, i) => ({
        ...m,
        overlay: {
          model: 'inherit',
          skills: [],
          systemPromptOverlay: `成员 ${i} 的 overlay 提示`,
        },
      })),
    };
    const result = await startTeamTurn(baseInput({
      profile: overlayProfile,
      writeFile: io.failingWriteFile,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.systemPrompt).toContain('trylo_member_overlay');
    // Each member got a compact fallback tag.
    expect((result.systemPrompt.match(/<trylo_member_overlay /g) ?? []).length).toBe(2);
  });

  it('a second in-flight click is refused (double-click lock)', async () => {
    const io = memoryIo();
    configureTeamRunsCache(io);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowWrite = async (): Promise<void> => {
      await gate;
      io.writeFile;
    };
    const first = startTeamTurn(baseInput({ writeFile: slowWrite }));
    const second = await startTeamTurn(baseInput({ writeFile: slowWrite }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('in_flight');
    release?.();
    await first;
  });
});
