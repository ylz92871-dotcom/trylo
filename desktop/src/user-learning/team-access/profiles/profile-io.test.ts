// TeamProfile IO format tests (Foundation spec §9.1).

import { describe, expect, it } from 'vitest';
import {
  canSaveCustomProfile,
  parseTeamProfilesFile,
  serializeTeamProfilesFile,
  teamProfilesFilePath,
} from './profile-io';
import { builtinTemplate } from './templates';
import { emptyMemberOverlay, type TeamProfile } from './profile-types';

function customProfile(id: string): TeamProfile {
  return {
    schemaVersion: 1,
    id,
    origin: 'custom',
    surface: 'code',
    title: `自定义 ${id}`,
    createdAt: 1,
    updatedAt: 1,
    members: [
      { memberId: `${id}-p`, baseRole: 'person', displayName: 'Person', overlay: emptyMemberOverlay() },
      { memberId: `${id}-w`, baseRole: 'worker', displayName: 'Worker', overlay: emptyMemberOverlay() },
    ],
  };
}

describe('profile-io', () => {
  it('path joins forward slashes under .trylo', () => {
    expect(teamProfilesFilePath('D:/proj')).toBe('D:/proj/.trylo/team-profiles.json');
    expect(teamProfilesFilePath('D:\\proj\\')).toBe('D:/proj/.trylo/team-profiles.json');
  });

  it('round-trips custom profiles and never writes builtins', () => {
    const text = serializeTeamProfilesFile('ws', [
      builtinTemplate('small-change', 'code'),
      customProfile('c-1'),
    ]);
    const parsed = parseTeamProfilesFile(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.profiles).toHaveLength(1);
      expect(parsed.profiles[0]!.id).toBe('c-1');
    }
  });

  it('a same-id disk entry cannot override a builtin (spec §7.5)', () => {
    const impostor = { ...builtinTemplate('small-change', 'code'), origin: 'custom' as const };
    const text = serializeTeamProfilesFile('ws', [impostor, customProfile('c-2')]);
    const parsed = parseTeamProfilesFile(text);
    if (parsed.ok) {
      expect(parsed.profiles.some((p) => p.id === 'small-change')).toBe(false);
      expect(parsed.profiles.some((p) => p.id === 'c-2')).toBe(true);
    } else {
      expect(parsed.ok).toBe(false);
    }
  });

  it('malformed files fail with a reason (idle shows a hint, no crash)', () => {
    expect(parseTeamProfilesFile('{broken')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTeamProfilesFile('[]')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseTeamProfilesFile('{"schemaVersion":2,"workspaceId":"w","profiles":[]}'))
      .toEqual({ ok: false, reason: 'foreign_schema' });
  });

  it('save guard: 16 customs max, no auto-LRU-delete', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => customProfile(`c-${i}`));
    expect(canSaveCustomProfile(sixteen, 'c-new'))
      .toEqual({ ok: false, reason: '最多 16 个自定义团队，请先删一个' });
    // Editing an existing profile (same id) stays legal.
    expect(canSaveCustomProfile(sixteen, 'c-0')).toEqual({ ok: true });
    expect(canSaveCustomProfile(sixteen.slice(0, 15), 'c-new')).toEqual({ ok: true });
  });
});
