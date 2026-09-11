// Launch pure helpers (Foundation spec §7.6.2 step 4).
//
// Freeze-at-start: the profile snapshot is DEEP-COPIED into the run —
// editing the live profile afterwards can never mutate a running or
// historical run (Pitfall 13). No fs, no React, no clock.
//
// Returns the PERSISTABLE run mirror (persist.ts) — user-learning must
// not import surfaces; the App boundary treats the shapes structurally.

import type { PersistableTeamRun } from '../persist';
import type { TeamProfile } from './profile-types';

/**
 * Deep-copies the profile. Builtin templates may seed the launch — the
 * frozen copy is tagged custom so history never points at code.
 */
export function freezeProfile(profile: TeamProfile): TeamProfile {
  return {
    ...profile,
    origin: 'custom',
    members: profile.members.map((m) => ({
      ...m,
      overlay: {
        model: m.overlay.model,
        skills: [...m.overlay.skills],
        systemPromptOverlay: m.overlay.systemPromptOverlay,
        ...(m.overlay.tools ? { tools: [...m.overlay.tools] } : {}),
        ...(m.overlay.disallowedTools
          ? { disallowedTools: [...m.overlay.disallowedTools] }
          : {}),
      },
    })),
  };
}

export function createFrozenTeamRun(input: {
  readonly teamRunId: string;
  readonly personConversationId: string;
  readonly goal: string;
  readonly frozenProfile: TeamProfile;
  readonly now: number;
  /** Contract identity when the runtime compiled one for the spawn. */
  readonly contractId?: string;
  readonly contractVersion?: number;
}): PersistableTeamRun {
  // queued seats pre-exist the spawn events; `id = queued:${memberId}` is
  // replaced by the CLI tool_use id at bind time (spec §7.6.3).
  const seats = input.frozenProfile.members.map((m) => ({
    id: `queued:${m.memberId}`,
    memberId: m.memberId,
    seat: m.baseRole,
    displayName: m.displayName,
    status: 'queued' as const,
    summary: '',
  }));
  const oneLiner =
    input.goal.length <= 80 ? input.goal : `${input.goal.slice(0, 79)}…`;
  return {
    id: input.teamRunId,
    personConversationId: input.personConversationId,
    status: 'running',
    summary: { title: input.frozenProfile.title, goal: input.goal, oneLiner },
    frozenProfile: input.frozenProfile,
    seats,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.contractId !== undefined ? { contractId: input.contractId } : {}),
    ...(input.contractVersion !== undefined ? { contractVersion: input.contractVersion } : {}),
  };
}

/** The scratch profile file the CLI reads at spawn time (spec §8.4). */
export function frozenProfilePath(workspaceRoot: string, teamRunId: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return `${root}/.trylo/team/${teamRunId}/profile.v1.json`;
}

export function serializeFrozenProfile(profile: TeamProfile): string {
  return JSON.stringify({ frozenProfile: profile }, null, 2);
}
