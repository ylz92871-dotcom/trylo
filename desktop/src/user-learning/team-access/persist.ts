// Team persistence path helpers (PR-7/PR-11, spec §18.2).
//
// Pure path/JSON helpers only — NO fs, NO Tauri. The App (which owns
// hostAdapter.fs) reads these and performs the writes after
// preparePrompt returns a contract. The runtime never touches disk.
import { CONTRACT_TAG } from './contract-types';
import type { TeamProfile } from './profiles/profile-types';
import type { EngineeringContract } from './contract-types';
import { isPersistableTeamRun } from './team-run-shape';
import { TEAM_ROLE_IDS } from './profiles/profile-types';
import { isTeamRunOpen } from '../../domain/team-run-lifecycle';

/** `<workspace>/.trylo/team/<teamRunId>/contract.v1.json` (forward slashes). */
export function contractFilePath(workspaceRoot: string, teamRunId: string): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  return `${root}/.trylo/team/${teamRunId}/contract.v1.json`;
}

/** `<workspace>/.trylo/team/<teamRunId>/translation.v1.json`. */
export function translationFilePath(workspaceRoot: string, teamRunId: string): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  return `${root}/.trylo/team/${teamRunId}/translation.v1.json`;
}

/** JSON string written to disk — identical bytes to the prompt body. */
export function serializeContractForDisk(c: EngineeringContract): string {
  return JSON.stringify(c, null, 2);
}

/** Wrapper used by the App to mirror the prompt tag structure on disk. */
export function contractDiskDocument(c: EngineeringContract): string {
  return JSON.stringify({ tag: CONTRACT_TAG, contract: c }, null, 2);
}

// ── team-runs.json (PR-11, spec §8.6) ──────────────────────────────
// Structural mirror of the surfaces TeamRun (user-learning must not
// import surfaces). `selectedSeatId` is UI-only and never persisted.

export type PersistedSeatRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PersistedTeamRunStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PersistableSeatInstance {
  readonly observations?: readonly import('../../domain/member-observation').RecordedMemberObservation[];
  readonly taskId?: string;
  readonly canReceiveInput?: boolean;
  readonly awaitingInput?: boolean;
  readonly parked?: boolean;
  readonly round?: number;
  readonly conversation?: readonly { readonly round: number; readonly prompt?: string; readonly result?: string }[];
  readonly id: string;
  /** Member instance uuid from the frozen profile (Foundation spec §9.2).
   *  Undefined on v1 runs; the v1 migrator synthesizes `legacy-` ids. */
  readonly memberId?: string;
  readonly seat: string;
  /** Frozen display name; two workers stay distinguishable on reload. */
  readonly displayName?: string;
  readonly status: PersistedSeatRunStatus;
  readonly summary: string;
  readonly prompt?: string;
  readonly result?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly error?: string;
}

export interface PersistableTeamRun {
  readonly reports?: readonly import('../../domain/team-progress').TeamProgressReport[];
  readonly handoffs?: readonly import('../../domain/team-progress').TeamHandoffRecord[];
  readonly error?: string;
  readonly lifecycle?: 'open' | 'closed';
  readonly endedAt?: number;
  readonly id: string;
  readonly personConversationId: string;
  readonly status: PersistedTeamRunStatus;
  readonly summary: {
    readonly title: string;
    readonly goal: string;
    readonly oneLiner: string;
    readonly explicit?: string;
    readonly inferred?: string;
    readonly baseline?: string;
  };
  readonly contractId?: string;
  readonly contractVersion?: number;
  /** Freeze-at-start snapshot (Foundation spec §9.2). Required from the
   *  v2 writer on; the v1 migrator synthesizes an ephemeral profile. */
  readonly frozenProfile?: TeamProfile;
  readonly seats: readonly PersistableSeatInstance[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamRunsFile {
  /** v1 = pre-memberId files; v2 = memberId + (from PR-7) frozenProfile.
   *  The parser must accept both from the first v2 write onward
   *  (Foundation spec §9.2 / Pitfall 22). */
  readonly schemaVersion: 1 | 2;
  readonly workspaceId: string;
  /** Retention: at most 20 terminal runs + 1 non-terminal (most recent). */
  readonly runs: readonly PersistableTeamRun[];
}

export const MAX_TERMINAL_TEAM_RUNS = 20;

/** `<workspace>/.trylo/team-runs.json`. */
export function teamRunsFilePath(workspaceRoot: string): string {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  return `${root}/.trylo/team-runs.json`;
}

/** Forward-slash workspace root without trailing separators. */
function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

/** Retention limits history only; every live conversation must survive reload. */
export function serializeTeamRunsFile(
  workspaceId: string,
  runs: readonly PersistableTeamRun[],
): string {
  const sorted = [...runs].sort((a, b) => b.updatedAt - a.updatedAt);
  const active = sorted.filter(isTeamRunOpen);
  const activeIds = new Set(active.map((r) => r.id));
  const terminal = sorted.filter((r) => !isTeamRunOpen(r) && !activeIds.has(r.id)).slice(0, MAX_TERMINAL_TEAM_RUNS);
  // Foundation spec §9.2: v2 (frozenProfile + memberId) from PR-7 on.
  // The parser accepts 1 | 2 since PR-2, so older loads never break.
  const file: TeamRunsFile = {
    schemaVersion: 2,
    workspaceId,
    runs: [...active, ...terminal],
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a stored team-runs file. Null on malformed JSON / foreign schema.
 * Accepts schemaVersion 1 | 2: v1 runs are migrated in-memory (synthetic
 * `legacy-` member ids + role display names) so identity fields always
 * read back populated. The next save rewrites the file at the writer's
 * current schema version.
 */
export function parseTeamRunsFile(text: string): TeamRunsFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (
    (file['schemaVersion'] !== 1 && file['schemaVersion'] !== 2) ||
    typeof file['workspaceId'] !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(file['runs'])) return null;
  if (!file['runs'].every(isPersistableTeamRun)) return null;
  if (new Set(file['runs'].map(run => run.id)).size !== file['runs'].length) return null;
  // Older v2 writers also omitted freezes. Hydrate those through the same
  // legacy projection so every accepted run has a usable profile.
  return migrateTeamRunsV1(value as TeamRunsFile);
}

/** In-memory v1 → v2-shaped projection (Foundation spec §9.2 migrate). */
function migrateTeamRunsV1(file: TeamRunsFile): TeamRunsFile {
  return {
    ...file,
    runs: file.runs.map((run) => {
      const seats = run.seats.map((seat) => ({
        ...seat,
        memberId: seat.memberId ?? `legacy-${seat.seat}-${seat.id}`,
        displayName: seat.displayName ?? TRYLO_TEAM_SEAT_FALLBACK_NAME[seat.seat] ?? seat.seat,
      }));
      return {
        ...run,
        seats,
        frozenProfile: run.frozenProfile ?? {
          schemaVersion: 1,
          id: run.id,
          origin: 'custom',
          surface: 'code',
          title: '(migrated)',
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          members: seats.map((seat) => ({
            memberId: seat.memberId!,
            baseRole: (isKnownRole(seat.seat) ? seat.seat : 'worker') as TeamProfile['members'][number]['baseRole'],
            displayName: seat.displayName ?? seat.seat,
            overlay: { model: 'inherit', skills: [], systemPromptOverlay: '' },
          })),
        },
      };
    }),
  };
}

function isKnownRole(seat: string): boolean {
  return (TEAM_ROLE_IDS as readonly string[]).includes(seat);
}

/** Role-level fallback names for v1 seats without a frozen displayName. */
const TRYLO_TEAM_SEAT_FALLBACK_NAME: Record<string, string> = {
  person: 'Person',
  architect: 'Architect',
  worker: 'Worker',
  reviewer: 'Reviewer',
  verifier: 'Verifier',
};
