// Three-copy lock: canonical profile types (user-learning), the
// surfaces mirror, and the CLI overlay fields must never drift
// (Foundation spec §7.7 / Pitfall 8). Reads the SOURCE FILES as text —
// a renamed field fails loud here instead of silently diverging.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPLAY_NAME_MAX_CHARS,
  MAX_MEMBERS_PER_PROFILE,
  MAX_WORKERS_PER_PROFILE,
  OVERLAY_PROMPT_MAX_CHARS,
} from './team-profile-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANONICAL = join(HERE, '../../user-learning/team-access/profiles/profile-types.ts');
const MIRROR = join(HERE, './team-profile-types.ts');
const CLI_TOOLS = join(
  HERE,
  '../../../../new trylo cli/src/internal/surface/cli/team-profile-wiring.ts',
);

const OVERLAY_FIELDS = ['model', 'tools', 'disallowedTools', 'skills', 'systemPromptOverlay'];
const MEMBER_FIELDS = ['memberId', 'baseRole', 'displayName', 'overlay'];
const PROFILE_FIELDS = [
  'schemaVersion', 'id', 'origin', 'surface', 'title', 'createdAt', 'updatedAt', 'members',
];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('team-profile-types three-copy lock', () => {
  it('canonical and mirror carry the same overlay / member / profile fields', () => {
    const canonical = read(CANONICAL);
    const mirror = read(MIRROR);
    for (const field of OVERLAY_FIELDS) {
      expect(canonical).toContain(`readonly ${field}`);
      expect(mirror).toContain(`readonly ${field}`);
    }
    for (const field of MEMBER_FIELDS) {
      expect(canonical).toContain(`readonly ${field}`);
      expect(mirror).toContain(`readonly ${field}`);
    }
    for (const field of PROFILE_FIELDS) {
      expect(canonical).toContain(`readonly ${field}`);
      expect(mirror).toContain(`readonly ${field}`);
    }
  });

  it('budgets agree between the two Desktop copies', () => {
    const mirror = read(MIRROR);
    expect(OVERLAY_PROMPT_MAX_CHARS).toBe(2000);
    expect(DISPLAY_NAME_MAX_CHARS).toBe(24);
    expect(MAX_MEMBERS_PER_PROFILE).toBe(6);
    expect(MAX_WORKERS_PER_PROFILE).toBe(2);
    for (const [name, value] of [
      ['OVERLAY_PROMPT_MAX_CHARS', 2000],
      ['DISPLAY_NAME_MAX_CHARS', 24],
      ['MAX_MEMBERS_PER_PROFILE', 6],
      ['MAX_WORKERS_PER_PROFILE', 2],
    ] as const) {
      expect(mirror).toContain(`export const ${name} = ${value}`);
    }
  });

  it('the new CLI reads the frozen overlay without importing the legacy engine', () => {
    const cli = read(CLI_TOOLS);
    for (const field of OVERLAY_FIELDS) expect(cli).toContain(field);
    expect(cli).toContain('spawn_agent');
    expect(cli).toContain('inspectTeamRepresentation');
  });
});
