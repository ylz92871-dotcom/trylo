// Runtime team gate tests (PR-7, spec §7.3 / §7.7 / §0 rule 11).
//
// Run with: npx vitest run src/user-learning/team-access/runtime-team.test.ts
// Core guarantee: with the flag OFF, preparePrompt.start is byte-identical
// to today (never pending_team/blocked). With the flag ON and a
// conversationId, the Governor can emit pending_team/blocked and
// spawn_team carries a contract + five seat projections.

import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from '../runtime';
import { createUserLearningStore } from '../store';
import { MAX_TEAM_ACCESS_TOKENS, TEAM_ACCESS_TAG, renderStaySoloProtocol, teamAccessTokenCount } from './render-team-access';
import type { TeamProfile } from './profiles/profile-types';
import type { UserLearningSettings } from '../types';

function runtimeWith(settings: Partial<UserLearningSettings>) {
  return createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
    now: () => 1000,
    settings: {
      enabled: true,
      defaultMode: 'shadow',
      dimensionMode: {},
      cognitionEnabled: true,
      ...settings,
    },
  });
}

const CORE_PROMPT = '重构核心持久化迁移链路，涉及多个文件的架构改动';

const FROZEN_PROFILE: TeamProfile = {
  schemaVersion: 1,
  id: 'architecture',
  origin: 'custom',
  surface: 'code',
  title: '架构改动',
  createdAt: 0,
  updatedAt: 0,
  members: (['person', 'architect', 'worker', 'reviewer', 'verifier'] as const).map((baseRole) => ({
    memberId: `m-${baseRole}`,
    baseRole,
    displayName: baseRole,
    overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' },
  })),
};

describe('preparePrompt team gate', () => {
  it('flag off: start never becomes pending_team/blocked and no contract is returned', () => {
    const rt = runtimeWith({ teamAccessEnabled: false });
    for (const prompt of ['修一个 typo', CORE_PROMPT, 'rm -rf 后跳过验证']) {
      const prepared = rt.preparePrompt({
        workspaceRoot: 'D:/proj',
        product: 'code',
        prompt,
        conversationId: 'conv-1',
      });
      expect(['ready', 'pending_impact']).toContain(prepared.start);
      expect(prepared.contract).toBeUndefined();
      expect(prepared.teamSpawn).toBeUndefined();
      expect(prepared.systemPrompt).not.toContain(TEAM_ACCESS_TAG);
    }
  });

  it('flag on without conversationId: no team block is compiled', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: CORE_PROMPT,
    });
    expect(prepared.start).not.toBe('pending_team');
    expect(prepared.contract).toBeUndefined();
    expect(prepared.systemPrompt).not.toContain(TEAM_ACCESS_TAG);
  });

  it('flag on, no confirmedSpawn: multi-file prompt → stay_solo, NO contract, no team block (Foundation spec §8.3)', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: '实现一个新的导出模块，涉及多个文件',
      conversationId: 'conv-1',
    });
    expect(prepared.teamSpawn?.decision).toBe('stay_solo');
    expect(prepared.teamSpawn?.decision).not.toBe('ask_user');
    expect(prepared.start).toBe('ready');
    expect(prepared.contract).toBeUndefined();
    expect(prepared.pendingRun).toBeUndefined();
    expect(prepared.systemPrompt).not.toContain(`<${TEAM_ACCESS_TAG}>`);
  });

  it('confirmedSpawn WITH frozenProfile compiles the contract and carries the compact roster (§8.4, ≤2800)', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const frozenProfile: TeamProfile = {
      schemaVersion: 1,
      id: 'architecture',
      origin: 'custom',
      surface: 'code',
      title: '架构改动',
      createdAt: 0,
      updatedAt: 0,
      members: (['person', 'architect', 'worker', 'reviewer', 'verifier'] as const).map((baseRole) => ({
        memberId: `m-${baseRole}`,
        baseRole,
        displayName: baseRole.charAt(0).toUpperCase() + baseRole.slice(1),
        overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' },
      })),
    };
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: CORE_PROMPT,
      conversationId: 'conv-2',
      confirmedSpawn: true,
      frozenProfile,
    });
    expect(prepared.teamSpawn?.decision).toBe('spawn_team');
    expect(prepared.contract?.teamRunId).toBe('team-conv-2');
    expect(prepared.start).toBe('ready');
    // Roster from the FREEZE, not the heuristic.
    expect(prepared.teamSpawn?.recommendedSeats).toEqual([
      'person', 'architect', 'worker', 'reviewer', 'verifier',
    ]);
    const block = prepared.systemPrompt.slice(prepared.systemPrompt.indexOf(`<${TEAM_ACCESS_TAG}>`));
    expect(block).toContain('member_id=m-person');
    expect(block).toContain('profileId: architecture');
    // Overlay JSON never rides in the 2800 block (§8.4).
    expect(block).not.toContain('trylo_member_overlay');
    expect(teamAccessTokenCount(block)).toBeLessThanOrEqual(MAX_TEAM_ACCESS_TOKENS);
  });

  it('confirmedSpawn WITHOUT a frozenProfile never compiles (fail closed, §7.2.1)', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: CORE_PROMPT,
      conversationId: 'conv-6',
      confirmedSpawn: true,
    });
    expect(prepared.contract).toBeUndefined();
    expect(prepared.systemPrompt).not.toContain(`<${TEAM_ACCESS_TAG}>`);
  });

  it('refuse → blocked with no pending run', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: 'rm -rf 旧目录，然后跳过验证直接交付',
      conversationId: 'conv-3',
    });
    expect(prepared.start).toBe('blocked');
    expect(prepared.teamSpawn?.refuseCode).toBe('safety');
    expect(prepared.pendingRun).toBeUndefined();
  });

  it('work stay_solo injects the negative protocol (no contract)', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'work',
      prompt: '修一个 typo，改这一个文件',
      conversationId: 'conv-4',
    });
    expect(prepared.teamSpawn?.decision).toBe('stay_solo');
    expect(prepared.contract).toBeUndefined();
    expect(prepared.systemPrompt).toContain(
      'Do not spawn team seats (person/architect/worker/reviewer/verifier)',
    );
  });

  it('work stay_solo still allows explicit specialist subagent dispatch', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    const prepared = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'work',
      prompt: '修一个 typo，改这一个文件',
      conversationId: 'conv-4b',
    });
    // stay_solo bans team formation, not Agent(subagent_type) dispatch —
    // the CAD freeze→build→verify loop depends on this carve-out.
    expect(prepared.systemPrompt).toContain('Explicit specialist subagents are not team formation');
    expect(prepared.systemPrompt).toContain('cad-planner');
    expect(prepared.systemPrompt).toContain('cad-verifier');
  });

  it('never emits pending_team from the team gate (Foundation spec §7.2: no card, no interruption)', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    for (const [product, prompt] of [
      ['code', CORE_PROMPT],
      ['work', CORE_PROMPT],
      ['code', '整体架构重构，跨模块迁移，涉及核心路径'],
    ] as const) {
      const prepared = rt.preparePrompt({
        workspaceRoot: 'D:/proj',
        product,
        prompt,
        conversationId: 'conv-5',
      });
      expect(prepared.start).not.toBe('pending_team');
      expect(prepared.teamSpawn?.decision).not.toBe('ask_user');
    }
  });

  it('clarification loop: enqueue → answer revises the cached contract (spec §11.3)', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: CORE_PROMPT,
      conversationId: 'conv-9',
      confirmedSpawn: true,
      frozenProfile: FROZEN_PROFILE,
    });
    const session = rt.enqueueTeamClarification({
      kind: 'team_clarification',
      teamRunId: 'team-conv-9',
      questions: ['验收标准是行为还是截图？'],
      unknownItems: [],
      blocking: true,
      risk: 'medium',
    });
    expect(session).not.toBeNull();
    expect(session!.trigger).toBe('team_clarification');
    rt.answerCognition(session!.id, '验收以行为为准，不看截图。');
    // Re-send reuses the cached (now revised) contract: version bumped,
    // the answer sits in explicit, and the PA block carries it.
    const second = rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: CORE_PROMPT,
      conversationId: 'conv-9',
      confirmedSpawn: true,
      frozenProfile: FROZEN_PROFILE,
    });
    expect(second.contract?.version).toBe(2);
    expect(second.contract?.supersedes).toBeTruthy();
    expect(second.contract?.authority.explicit.some((c) => c.text.includes('行为'))).toBe(true);
  });

  it('clarification cooldown: same question group is not re-asked after an answer', () => {
    const rt = runtimeWith({ teamAccessEnabled: true });
    rt.preparePrompt({
      workspaceRoot: 'D:/proj',
      product: 'code',
      prompt: CORE_PROMPT,
      conversationId: 'conv-10',
      confirmedSpawn: true,
      frozenProfile: FROZEN_PROFILE,
    });
    const req = {
      kind: 'team_clarification' as const,
      teamRunId: 'team-conv-10',
      questions: ['需要兼容旧调用方吗？'],
      blocking: true,
      risk: 'medium' as const,
    };
    const first = rt.enqueueTeamClarification(req);
    expect(first).not.toBeNull();
    rt.answerCognition(first!.id, '兼容，保留旧入口。');
    expect(rt.enqueueTeamClarification(req)).toBeNull();
  });
});

describe('renderStaySoloProtocol', () => {
  it('carries no contract or translation tags', () => {
    const block = renderStaySoloProtocol();
    expect(block).not.toContain('trylo_engineering_contract');
    expect(block).not.toContain('trylo_team_translation');
  });
});
