/**
 * Pure-function store for the TeamRun. Spec §6 — `emptyTeamRun`,
 * `selectSeat`, `applySeatPatch`, `summarizeTeam`. No React. No IO.
 *
 * The store is intentionally tiny: the data lives in App-level state
 * (PR-B is fixture-driven; P1 will swap the source for live events).
 * Components hold a `useState<TeamRun>` and call these helpers.
 */
import {
  TEAM_SEAT_ORDER,
  isTeamSeatId,
} from '../shared/seats';
import type { TeamProfile } from './team-profile-types';
import type {
  SeatActivityItem,
  SeatInstance,
  SeatRunStatus,
  TaskSummary,
  TeamRun,
  TeamRunStatus,
  TeamSummaryStats,
} from './team-types';

export interface CreateTeamRunInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly personConversationId: string;
  readonly summary: TaskSummary;
  /** Freeze-at-start snapshot (Foundation spec §9.2) — required from the
   *  same PR that made it required on TeamRun. */
  readonly frozenProfile: TeamProfile;
  readonly seats?: readonly SeatInstance[];
  readonly status?: TeamRunStatus;
  readonly createdAt?: number;
}

export function emptyTeamRun(input: CreateTeamRunInput): TeamRun {
  const now = input.createdAt ?? Date.now();
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    personConversationId: input.personConversationId,
    status: input.status ?? 'running',
    summary: input.summary,
    frozenProfile: input.frozenProfile,
    seats: sortSeats(input.seats ?? [], input.frozenProfile),
    selectedSeatId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function selectSeat(run: TeamRun, seatId: string | null): TeamRun {
  // If the previously selected seat is no longer on stage, drop the
  // selection (return to summary board) instead of pointing at a ghost.
  let nextSelected: string | null = null;
  if (seatId !== null) {
    nextSelected = run.seats.some(s => s.id === seatId) ? seatId : null;
  }
  if (run.selectedSeatId === nextSelected) return run;
  return { ...run, selectedSeatId: nextSelected, updatedAt: Date.now() };
}

export interface SeatPatch {
  /** Bind patch: a queued row adopts the spawn's tool_use id. */
  readonly id?: string;
  /** Bind patch: adopt the event memberId when the queued row lacks one. */
  readonly memberId?: string;
  readonly status?: SeatRunStatus;
  readonly summary?: string;
  readonly prompt?: string;
  readonly result?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly error?: string;
  readonly activity?: readonly SeatActivityItem[];
}

export function applySeatPatch(
  run: TeamRun,
  seatId: string,
  patch: SeatPatch,
): TeamRun {
  let changed = false;
  const nextSeats = run.seats.map(seat => {
    if (seat.id !== seatId) return seat;
    const next: SeatInstance = { ...seat, ...patch };
    changed = true;
    return next;
  });
  if (!changed) return run;
  return {
    ...run,
    seats: sortSeats(nextSeats, run.frozenProfile),
    updatedAt: Date.now(),
  };
}

export function appendSeat(run: TeamRun, seat: SeatInstance): TeamRun {
  if (run.seats.some(s => s.id === seat.id)) return run;
  return {
    ...run,
    seats: sortSeats([...run.seats, seat], run.frozenProfile),
    updatedAt: Date.now(),
  };
}

export function summarizeTeam(run: TeamRun): TeamSummaryStats {
  let running = 0;
  let waiting = 0;
  let queued = 0;
  let done = 0;
  let failed = 0;
  for (const seat of run.seats) {
    switch (seat.status) {
      case 'running':
        running += 1;
        break;
      case 'waiting_approval':
        waiting += 1;
        break;
      case 'queued':
        queued += 1;
        break;
      case 'completed':
        done += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'cancelled':
        // Treated as terminal-but-not-successful; not part of done / failed buckets.
        break;
    }
  }
  return { running, waiting, queued, done, failed, total: run.seats.length };
}

export function isTeamRunActive(run: TeamRun | null | undefined): boolean {
  if (!run) return false;
  return run.status === 'running' || run.status === 'waiting';
}

export function findSeat(
  run: TeamRun,
  seatId: string,
): SeatInstance | undefined {
  return run.seats.find(s => s.id === seatId);
}

/**
 * Order seats by the FROZEN profile's member order (Foundation spec
 * Pitfall 26): the user's composer ordering (e.g. Worker2 above
 * Reviewer) must not snap back to role order. Unknown members sort last;
 * same-rank seats keep their relative order (stable).
 */
function sortSeats(
  seats: readonly SeatInstance[],
  frozenProfile?: TeamProfile,
): readonly SeatInstance[] {
  const memberIndex = new Map<string, number>(
    (frozenProfile?.members ?? []).map((m, index) => [m.memberId, index]),
  );
  const roleRank = (seat: SeatInstance): number => {
    if (!isTeamSeatId(seat.seat)) return TEAM_SEAT_ORDER.length;
    return TEAM_SEAT_ORDER.indexOf(seat.seat);
  };
  const rank = (seat: SeatInstance): number => {
    const index = seat.memberId !== undefined
      ? memberIndex.get(seat.memberId)
      : undefined;
    if (index !== undefined) return index;
    return roleRank(seat) + TEAM_SEAT_ORDER.length;
  };
  return [...seats].sort((a, b) => rank(a) - rank(b));
}
