// TeamProfile disk format (Foundation spec §9.1).
//
// Pure path/JSON helpers — NO fs, NO React. The App (hosting
// hostAdapter.fs) performs the reads/writes through startTeamTurn and
// the composer's save flow. Builtins are never written to disk and a
// same-id custom entry is rejected on parse (spec §7.5).

import {
  BUILTIN_TEMPLATE_IDS,
} from './templates';
import {
  MAX_CUSTOM_PROFILES,
  type TeamProfile,
  type TeamProfilesFile,
} from './profile-types';
import { sanitizeOverlay } from './profile-validate';
import { TEAM_ROLE_IDS } from './profile-types';

/** `<workspace>/.trylo/team-profiles.json` (forward slashes). */
export function teamProfilesFilePath(workspaceRoot: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return `${root}/.trylo/team-profiles.json`;
}

export function serializeTeamProfilesFile(
  workspaceId: string,
  profiles: readonly TeamProfile[],
): string {
  const file: TeamProfilesFile = {
    schemaVersion: 1,
    workspaceId,
    profiles: profiles.filter((p) => p.origin === 'custom'),
  };
  return JSON.stringify(file, null, 2);
}

/** Parse result carries the failure mode so idle can show a hint
 *  without crashing (spec §10.9: profile JSON 损坏 → 自定义段提示). */
export type ParsedTeamProfiles =
  | { readonly ok: true; readonly profiles: readonly TeamProfile[] }
  | { readonly ok: false; readonly reason: 'malformed' | 'foreign_schema' };

export function parseTeamProfilesFile(text: string): ParsedTeamProfiles {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'malformed' };
  }
  const file = value as Record<string, unknown>;
  if (file['schemaVersion'] !== 1) return { ok: false, reason: 'foreign_schema' };
  if (!Array.isArray(file['profiles'])) return { ok: false, reason: 'malformed' };

  const profiles: TeamProfile[] = [];
  for (const raw of file['profiles']) {
    const profile = parseProfile(raw);
    if (profile) profiles.push(profile);
  }
  // Builtins live in code; a same-id disk entry never overrides them.
  const customOnly = profiles.filter(
    (p) => p.origin === 'custom' && !(BUILTIN_TEMPLATE_IDS as readonly string[]).includes(p.id),
  );
  return { ok: true, profiles: customOnly };
}

function parseProfile(value: unknown): TeamProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const membersRaw = raw['members'];
  if (
    typeof raw['id'] !== 'string' ||
    (raw['surface'] !== 'code' && raw['surface'] !== 'work') ||
    typeof raw['title'] !== 'string' ||
    !Array.isArray(membersRaw)
  ) {
    return null;
  }
  const members = membersRaw
    .map((m): TeamProfile['members'][number] | null => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
      const member = m as Record<string, unknown>;
      if (
        typeof member['memberId'] !== 'string' ||
        typeof member['displayName'] !== 'string' ||
        !(TEAM_ROLE_IDS as readonly string[]).includes(member['baseRole'] as string)
      ) {
        return null;
      }
      return {
        memberId: member['memberId'],
        baseRole: member['baseRole'] as TeamProfile['members'][number]['baseRole'],
        displayName: member['displayName'],
        overlay: sanitizeOverlay(member['overlay']),
      };
    })
    .filter((m): m is TeamProfile['members'][number] => m !== null);
  return {
    schemaVersion: 1,
    id: raw['id'],
    origin: 'custom',
    surface: raw['surface'],
    title: raw['title'],
    createdAt: typeof raw['createdAt'] === 'number' ? raw['createdAt'] : 0,
    updatedAt: typeof raw['updatedAt'] === 'number' ? raw['updatedAt'] : 0,
    members,
  };
}

/** Save guard: refuse beyond 16 customs; never auto-LRU-delete (user assets). */
export function canSaveCustomProfile(
  existing: readonly TeamProfile[],
  incomingId: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const others = existing.filter((p) => p.id !== incomingId && p.origin === 'custom');
  if (others.length >= MAX_CUSTOM_PROFILES) {
    return {
      ok: false,
      reason: `最多 ${MAX_CUSTOM_PROFILES} 个自定义团队，请先删一个`,
    };
  }
  return { ok: true };
}
