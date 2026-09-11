// startTeamTurn tests (Foundation spec §7.6.2).

import { describe, expect, it } from 'vitest';
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
    writeFile: memoryIo().writeFile,
    ...overrides,
  };
}

describe('startTeamTurn', () => {
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
