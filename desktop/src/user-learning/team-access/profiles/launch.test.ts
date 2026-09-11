// Launch freeze tests (Foundation spec §7.6.2 step 4 / §9.2).

import { describe, expect, it } from 'vitest';
import { createFrozenTeamRun, freezeProfile, frozenProfilePath, serializeFrozenProfile } from './launch';
import type { TeamProfile } from './profile-types';

function profile(): TeamProfile {
  return {
    schemaVersion: 1,
    id: 'small-change',
    origin: 'builtin',
    surface: 'code',
    title: '实现小改动',
    createdAt: 1,
    updatedAt: 1,
    members: [
      { memberId: 'm-p', baseRole: 'person', displayName: 'Person', overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' } },
      { memberId: 'm-w', baseRole: 'worker', displayName: 'Worker', overlay: { model: 'inherit', skills: ['docs'], tools: ['Read'], systemPromptOverlay: '写导出层' } },
    ],
  };
}

describe('freezeProfile', () => {
  it('deep-copies members and overlays; snapshot is detached from the source', () => {
    const source = profile();
    const frozen = JSON.parse(JSON.stringify(freezeProfile(source))) as TeamProfile;
    (frozen.members[1]!.overlay.skills as string[]).push('late-skill');
    (frozen.members[1]!.overlay as { systemPromptOverlay: string }).systemPromptOverlay = 'mutated';
    expect(source.members[1]!.overlay.skills).toEqual(['docs']);
    expect(source.members[1]!.overlay.systemPromptOverlay).toBe('写导出层');
    // Frozen copy is a custom snapshot, never a builtin reference.
    expect(frozen.origin).toBe('custom');
  });

  it('preserves optional tool lists as copies', () => {
    const frozen = JSON.parse(JSON.stringify(freezeProfile(profile()))) as TeamProfile;
    (frozen.members[1]!.overlay.tools as string[]).push('Agent');
    expect(profile().members[1]!.overlay.tools).toEqual(['Read']);
  });
});

describe('createFrozenTeamRun', () => {
  it('builds queued seats in frozen member order with memberId identity', () => {
    const run = createFrozenTeamRun({
      teamRunId: 'team-conv-1',
      personConversationId: 'conv-1',
      goal: '把导出路径改成配置项',
      frozenProfile: freezeProfile(profile()),
      now: 42,
    });
    expect(run.id).toBe('team-conv-1');
    expect(run.status).toBe('running');
    expect(run.personConversationId).toBe('conv-1');
    expect(run.seats.map((s) => s.id)).toEqual(['queued:m-p', 'queued:m-w']);
    expect(run.seats.map((s) => s.memberId)).toEqual(['m-p', 'm-w']);
    expect(run.seats.every((s) => s.status === 'queued')).toBe(true);
    expect(run.summary.oneLiner).toBe('把导出路径改成配置项');
    expect(run.frozenProfile!.members).toHaveLength(2);
  });

  it('clamps the oneLiner to 80 chars', () => {
    const run = createFrozenTeamRun({
      teamRunId: 'team-conv-2',
      personConversationId: 'conv-2',
      goal: 'x'.repeat(120),
      frozenProfile: freezeProfile(profile()),
      now: 1,
    });
    expect(run.summary.oneLiner).toHaveLength(80);
  });
});

describe('frozen profile file', () => {
  it('writes under .trylo/team/<teamRunId>/profile.v1.json', () => {
    expect(frozenProfilePath('D:/proj', 'team-c1')).toBe('D:/proj/.trylo/team/team-c1/profile.v1.json');
    expect(frozenProfilePath('D:\\proj\\', 'team-c1')).toBe('D:/proj/.trylo/team/team-c1/profile.v1.json');
    const body = serializeFrozenProfile(profile());
    expect(JSON.parse(body)['frozenProfile']).toBeTruthy();
  });
});
