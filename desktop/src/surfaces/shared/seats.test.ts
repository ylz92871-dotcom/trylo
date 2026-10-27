import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEAM_SEAT_ORDER,
  TRYLO_TEAM_SEAT_DISPLAY_NAME_DESKTOP,
  TRYLO_TEAM_SEAT_IDS_DESKTOP,
  isTeamSeatId,
  seatDescriptor,
} from './seats';

const CLI_ROSTER = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../new trylo cli/src/internal/surface/cli/team-profile-wiring.ts',
);

describe('surfaces/shared/seats', () => {
  it('carries the same seat IDs in the same order as the CLI roster', () => {
    // 1) local snapshot — five core seats + two CAD seats (Work surface)
    expect([...TRYLO_TEAM_SEAT_IDS_DESKTOP]).toEqual([
      'person',
      'architect',
      'worker',
      'reviewer',
      'verifier',
      'cad-planner',
      'cad-verifier',
    ]);
    expect([...TEAM_SEAT_ORDER]).toEqual([...TRYLO_TEAM_SEAT_IDS_DESKTOP]);

    // 2) lock against the CLI roster file (string match). The test
    // fails loud if the CLI ever renames / reorders a seat.
    const source = readFileSync(CLI_ROSTER, 'utf8').replaceAll('"', "'");
    expect(source).toContain("'person'");
    expect(source).toContain("'architect'");
    expect(source).toContain("'worker'");
    expect(source).toContain("'reviewer'");
    expect(source).toContain("'verifier'");
    expect(source).toContain("'cad-planner'");
    expect(source).toContain("'cad-verifier'");
  });

  it('exposes distinct Desktop display names without coupling CLI policy to UI labels', () => {
    for (const id of TRYLO_TEAM_SEAT_IDS_DESKTOP) {
      expect(TRYLO_TEAM_SEAT_DISPLAY_NAME_DESKTOP[id]).toBeTruthy();
    }
    expect(new Set(Object.values(TRYLO_TEAM_SEAT_DISPLAY_NAME_DESKTOP)).size).toBe(TRYLO_TEAM_SEAT_IDS_DESKTOP.length);
  });

  it('flags unknown ids', () => {
    expect(isTeamSeatId('worker')).toBe(true);
    expect(isTeamSeatId('explore')).toBe(false);
    expect(isTeamSeatId('general-purpose')).toBe(false);
    expect(isTeamSeatId('managed-work')).toBe(false);
  });

  it('round-trips seat descriptors', () => {
    for (const id of TRYLO_TEAM_SEAT_IDS_DESKTOP) {
      const d = seatDescriptor(id);
      expect(d.id).toBe(id);
      expect(d.short).toHaveLength(1);
    }
  });
});
