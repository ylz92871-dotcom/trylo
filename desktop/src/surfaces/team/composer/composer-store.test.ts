// Composer draft store tests (Foundation spec §10.4).
//
// The preview cross-check imports user-learning's authoritative merge —
// allowed HERE because test files are not part of either runtime bundle;
// this is what keeps the mirror from drifting (Pitfall 8).

import { describe, expect, it } from 'vitest';
import {
  addableRoles,
  addMember,
  blankCustomDraft,
  buildProfileFromDraft,
  draftFromProfile,
  draftStructuralError,
  patchOverlay,
  previewMemberOverlay,
  removeMember,
  rosterAllowsNoWorker,
  startGate,
  teamModelChoices,
  type ComposerDraft,
} from './composer-store';
import { emptyMemberOverlay, type TeamMemberSpec } from '../../../user-learning/team-access/profiles/profile-types';
import { applyMemberOverlayPreview } from '../../../user-learning/team-access/profiles/overlay-merge';
import { builtinTemplate } from '../../../user-learning/team-access/profiles/templates';
import type { TeamProfile } from '../team-profile-types';

describe('composer-store drafts', () => {
  it('blank custom draft presets Person + Worker, Person first', () => {
    const draft = blankCustomDraft('code');
    expect(draft.members.map((m) => m.baseRole)).toEqual(['person', 'worker']);
    expect(draftStructuralError(draft, { allowNoWorker: false })).toBe('');
  });

  it('add menu only lists unfilled roles; worker capped at 2', () => {
    const draft = blankCustomDraft('code');
    expect(addableRoles(draft)).toEqual(['architect', 'worker', 'reviewer', 'verifier']);
    const withArchitect = addMember(draft, 'architect');
    expect(addableRoles(withArchitect)).toEqual(['worker', 'reviewer', 'verifier']);
    const twoWorkers = addMember(addMember(withArchitect, 'worker'), 'worker');
    expect(addableRoles(twoWorkers)).toEqual(['reviewer', 'verifier']);
  });

  it('second worker defaults to 动手 · 2 and cannot write', () => {
    const draft = addMember(blankCustomDraft('code'), 'worker');
    const extra = draft.members.filter((m) => m.baseRole === 'worker')[1]!;
    expect(extra.displayName).toBe('动手 · 2');
    expect(extra.overlay.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write']));
  });

  it('Person cannot be removed; others can', () => {
    const draft = blankCustomDraft('code');
    const personId = draft.members[0]!.memberId;
    expect(removeMember(draft, personId).members).toHaveLength(2);
    const workerId = draft.members[1]!.memberId;
    expect(removeMember(draft, workerId).members).toHaveLength(1);
  });

  it('overlay patches stay within the member', () => {
    const draft = blankCustomDraft('code');
    const workerId = draft.members[1]!.memberId;
    const patched = patchOverlay(draft, workerId, { systemPromptOverlay: '写文档' });
    expect(patched.members[1]!.overlay.systemPromptOverlay).toBe('写文档');
    expect(patched.members[0]!.overlay.systemPromptOverlay).toBe('');
  });

  it('start gate: flags → goal → structure, each with a reason', () => {
    const draft = blankCustomDraft('code');
    expect(startGate(draft, { composerLive: false, allowNoWorker: false }).reason)
      .toContain('在设置里打开 Team');
    expect(startGate(draft, { composerLive: true, allowNoWorker: false }).reason)
      .toBe('缺少目标');
    const withGoal = { ...draft, goal: '做点事' };
    // remove worker → needs-a-worker reason
    const noWorker = removeMember(withGoal, withGoal.members[1]!.memberId);
    expect(startGate(noWorker, { composerLive: true, allowNoWorker: false }).reason)
      .toBe('需要一个 Worker，或改用只审模板');
    // review-only drafts allow no worker
    expect(startGate(noWorker, { composerLive: true, allowNoWorker: true }).enabled).toBe(true);
  });

  it('rosterAllowsNoWorker is the review-only shape, including saved custom copies', () => {
    const review = draftFromProfile(builtinTemplate('review-only', 'code'));
    expect(rosterAllowsNoWorker(review.members)).toBe(true);
    const saved = { ...review, templateId: 'uuid-saved', origin: 'custom' as const };
    expect(rosterAllowsNoWorker(saved.members)).toBe(true);
    expect(rosterAllowsNoWorker(blankCustomDraft('code').members)).toBe(false);
  });

  it('buildProfileFromDraft snapshots a custom profile', () => {
    const draft = draftFromProfile(builtinTemplate('small-change', 'code'), { goal: 'x' });
    const profile: TeamProfile = buildProfileFromDraft(draft, 42);
    expect(profile.origin).toBe('custom');
    expect(profile.createdAt).toBe(42);
    expect(profile.members).toHaveLength(3);
  });

  it('freezing two workers denies write tools on the second', () => {
    const draft = addMember(blankCustomDraft('code'), 'worker');
    const profile = buildProfileFromDraft({ ...draft, goal: 'x' }, 1);
    const workers = profile.members.filter((m) => m.baseRole === 'worker');
    expect(workers[0]!.overlay.disallowedTools ?? []).not.toEqual(expect.arrayContaining(['Edit']));
    expect(workers[1]!.overlay.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write']));
  });
});

describe('previewMemberOverlay ↔ user-learning authoritative merge', () => {
  function toCanonical(member: TeamMemberSpec) {
    return member;
  }

  it('produces identical tool sets for worker / reviewer / person with overlays', () => {
    const cases: TeamMemberSpec[] = [
      { memberId: 'a', baseRole: 'worker', displayName: 'W', overlay: emptyMemberOverlay() },
      {
        memberId: 'b', baseRole: 'worker', displayName: 'W2',
        overlay: { model: 'inherit', skills: ['docs'], tools: ['Read', 'WebFetch'], systemPromptOverlay: 'x' },
      },
      {
        memberId: 'c', baseRole: 'reviewer', displayName: 'R',
        overlay: { model: 'inherit', skills: ['repo-writer'], tools: ['Read', 'Write'], systemPromptOverlay: '' },
      },
      { memberId: 'd', baseRole: 'person', displayName: 'P', overlay: emptyMemberOverlay() },
    ];
    for (const member of cases) {
      const mirror = previewMemberOverlay(member);
      const authoritative = applyMemberOverlayPreview(toCanonical(member));
      expect(mirror.toolsApplied).toEqual(authoritative.toolsApplied);
      expect(mirror.skillsDropped).toEqual(authoritative.skillsDropped);
      expect(mirror.writes).toBe(authoritative.writes);
      expect(mirror.independence).toBe(authoritative.independence);
      expect(mirror.resolvedModel).toBe(authoritative.resolvedModel);
    }
  });
});

describe('teamModelChoices (spec §4.4 — no marketing grid)', () => {
  it('lists Inherit + main model + only non-primary vision/summary', () => {
    const choices = teamModelChoices({
      apiModel: 'claude-main',
      poolModel: '',
      vision: { usePrimaryConnection: false, model: 'vision-model' },
      summary: { usePrimaryConnection: true, model: 'ignored' },
    });
    expect(choices.map((c) => c.value)).toEqual(['inherit', 'claude-main', 'vision-model']);
  });

  it('primary-connection sub-models and main duplicates are not listed', () => {
    const choices = teamModelChoices({
      apiModel: 'claude-main',
      poolModel: 'pooled-main',
      vision: { usePrimaryConnection: false, model: 'pooled-main' },
      summary: undefined,
    });
    expect(choices.map((c) => c.value)).toEqual(['inherit', 'pooled-main']);
  });
});

describe('draft from saved profile', () => {
  it('keeps profileId so 覆盖保存 targets the same record', () => {
    const saved: TeamProfile = {
      schemaVersion: 1,
      id: 'saved-1',
      origin: 'custom',
      surface: 'code',
      title: '我的团队',
      createdAt: 1,
      updatedAt: 1,
      members: [],
    };
    const draft: ComposerDraft = draftFromProfile(saved);
    expect(draft.profileId).toBe('saved-1');
    expect(draft.title).toBe('我的团队');
  });
});
