// TeamProfile validation tests (Foundation spec §7.3).

import { describe, expect, it } from 'vitest';
import { firstValidationError, sanitizeOverlay, validateProfile } from './profile-validate';
import { emptyMemberOverlay, type TeamMemberSpec, type TeamProfile } from './profile-types';

let seq = 0;
function member(baseRole: TeamMemberSpec['baseRole'], overrides: Partial<TeamMemberSpec> = {}): TeamMemberSpec {
  seq += 1;
  return {
    memberId: overrides.memberId ?? `m-${seq}`,
    baseRole,
    displayName: overrides.displayName ?? baseRole,
    overlay: overrides.overlay ?? emptyMemberOverlay(),
  };
}

function profile(members: readonly TeamMemberSpec[], title = '测试团队'): Pick<TeamProfile, 'members' | 'title'> {
  return { members, title };
}

describe('validateProfile (Foundation spec §7.3)', () => {
  it('valid default roster (person + worker + reviewer) passes', () => {
    expect(validateProfile(profile([
      member('person'),
      member('worker'),
      member('reviewer'),
    ]))).toEqual({ ok: true });
  });

  it('exactly one person, and it must be first', () => {
    const noPerson = validateProfile(profile([member('worker')]));
    expect(noPerson.ok).toBe(false);
    const wrongOrder = validateProfile(profile([member('worker'), member('person')]));
    expect(wrongOrder.ok).toBe(false);
    expect(firstValidationError(wrongOrder)).toBe('Person 必须排在第一位');
    const twoPeople = validateProfile(profile([member('person'), member('person'), member('worker')]));
    expect(twoPeople.ok).toBe(false);
  });

  it('architect / reviewer / verifier are 0..1 each; worker ≤ 2', () => {
    const dup = validateProfile(profile([
      member('person'), member('reviewer'), member('reviewer'), member('worker'),
    ]));
    expect(dup.ok).toBe(false);
    const threeWorkers = validateProfile(profile([
      member('person'), member('worker'), member('worker'), member('worker'),
    ]));
    expect(threeWorkers.ok).toBe(false);
  });

  it('zero workers rejected unless allowNoWorker (review-only lineups)', () => {
    const noWorker = profile([member('person'), member('reviewer')]);
    expect(validateProfile(noWorker).ok).toBe(false);
    expect(validateProfile(noWorker, { allowNoWorker: true })).toEqual({ ok: true });
  });

  it('member cap 6 and duplicate memberIds rejected', () => {
    const six = profile([
      member('person'), member('worker'), member('worker'),
      member('architect'), member('reviewer'), member('verifier'),
    ]);
    expect(six.members).toHaveLength(6);
    expect(validateProfile(six)).toEqual({ ok: true });
    const seven = profile([...six.members, member('worker')]);
    expect(validateProfile(seven).ok).toBe(false);

    const dupId = profile([
      { ...member('person'), memberId: 'same' },
      { ...member('worker'), memberId: 'same' },
      member('reviewer'),
    ]);
    expect(validateProfile(dupId).ok).toBe(false);
  });

  it('displayName ≤ 24 chars; overlay prompt ≤ 2000 chars', () => {
    const longName = profile([member('person', { displayName: 'x'.repeat(25) }), member('worker')]);
    expect(validateProfile(longName).ok).toBe(false);
    const longPrompt = profile([
      member('person', { overlay: { ...emptyMemberOverlay(), systemPromptOverlay: 'x'.repeat(2001) } }),
      member('worker'),
    ]);
    expect(validateProfile(longPrompt).ok).toBe(false);
  });

  it('overlay can never carry independence / writes / canSpawn / isolation', () => {
    const smuggler = profile([
      member('person', {
        overlay: { ...emptyMemberOverlay(), ...{ independence: 'none' } } as never,
      }),
      member('worker'),
    ]);
    expect(validateProfile(smuggler).ok).toBe(false);
  });
});

describe('sanitizeOverlay (disk parse guard, spec §14.2)', () => {
  it('drops unknown keys and keeps only known string/array fields', () => {
    const cleaned = sanitizeOverlay({
      model: 'my-model',
      skills: ['docs'],
      independence: 'none',
      writes: true,
      canSpawn: true,
      systemPromptOverlay: 'x'.repeat(3000),
    });
    expect(cleaned).toEqual({
      model: 'my-model',
      skills: ['docs'],
      systemPromptOverlay: 'x'.repeat(2000),
    });
    expect((cleaned as unknown as Record<string, unknown>)['independence']).toBeUndefined();
    expect((cleaned as unknown as Record<string, unknown>)['writes']).toBeUndefined();
  });

  it('non-object input collapses to the inherit default', () => {
    expect(sanitizeOverlay(null)).toEqual({ model: 'inherit', skills: [], systemPromptOverlay: '' });
    expect(sanitizeOverlay('junk')).toEqual({ model: 'inherit', skills: [], systemPromptOverlay: '' });
  });
});
