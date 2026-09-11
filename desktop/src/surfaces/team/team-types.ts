/**
 * Team surface data types. Spec §6.
 *
 * The TeamRun is **attached to the Person (Code/Work) conversation
 * that spawned it** — there is no `kind: 'team'` conversation. The
 * `personConversationId` is the only stable link between a team and
 * the conversation the user was in when they kicked it off.
 *
 * Seats only contain on-stage agents. A seat that has not joined the
 * current run must NOT appear in `run.seats`. The fixture / live run
 * sources are responsible for that; the UI only renders what's there.
 */

import type { TeamProfile } from './team-profile-types';

export type CollaborationSurface = 'person' | 'team';

/**
 * Foundation spec §3: the five canonical roles are the safety floor
 * (`TeamRoleId`); each member INSTANCE gets a stable uuid (`TeamMemberId`).
 * `TryloTeamSeatId` survives only as a deprecated alias of TeamRoleId —
 * never use it as an instance id.
 */
export type TeamRoleId =
  | 'person'
  | 'architect'
  | 'worker'
  | 'reviewer'
  | 'verifier'
  | 'cad-planner'
  | 'cad-verifier';

/** @deprecated alias of TeamRoleId; do NOT use as an instance id. */
export type TryloTeamSeatId = TeamRoleId;

/** Member instance id (uuid v4) — stable within one profile and one run. */
export type TeamMemberId = string;

export type SeatRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TeamRunStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskSummary {
  /** Short, imperative title — "实现最小抽象", "把 X 写好". */
  readonly title: string;
  /** Full goal; the hero card uses the first 80 chars as `oneLiner`. */
  readonly goal: string;
  /** Capped at 80 chars. Computed by the fixture; live runs reuse the
   *  clamped version of `goal` until P1 brings its own field. */
  readonly oneLiner: string;
  /** Engineering contract fields — all optional, free text. */
  readonly explicit?: string;
  readonly inferred?: string;
  readonly baseline?: string;
}

export interface SeatActivityItem {
  readonly id: string;
  readonly kind: 'tool' | 'result' | 'note';
  readonly at: number;
  readonly label: string;
  readonly ok?: boolean;
}

export interface SeatInstance {
  /** Stable id; live = the CLI tool_use id, queued = `queued:${memberId}`,
   *  fixture = a fixture id. End events match on this id only. */
  readonly id: string;
  /** Member instance id from the frozen TeamProfile (Foundation spec §7.3).
   *  Undefined for legacy runs projected before the memberId channel. */
  readonly memberId?: TeamMemberId;
  /** Role = baseRole. The CLI `agentType` always equals this. */
  readonly seat: TryloTeamSeatId;
  /** Frozen display name (e.g. `Worker · 文档`); falls back to the role
   *  name. Two workers never render as "Worker · Worker". */
  readonly displayName?: string;
  readonly status: SeatRunStatus;
  /** ≤ 24 chars; appears on the chip and the summary card. */
  readonly summary: string;
  /** Long-form prompt text (shown on the detail page when no event
   *  timeline is available yet). */
  readonly prompt?: string;
  /** Final result / latest completion text. */
  readonly result?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly error?: string;
  /** Live tool/result trail for this member. Newest last. */
  readonly activity?: readonly SeatActivityItem[];
  // Observability (Foundation spec §15) — DEV diagnostics only.
  readonly resolvedModel?: string;
  readonly toolsApplied?: readonly string[];
  readonly skillsDropped?: readonly string[];
}

export interface TeamRun {
  readonly id: string;
  readonly workspaceId: string;
  /** The Code/Work conversation that started this team. */
  readonly personConversationId: string;
  readonly status: TeamRunStatus;
  readonly summary: TaskSummary;
  /** Engineering contract identity of the run (spec §8.4). Optional —
   *  only present when a contract was compiled for the spawn. */
  readonly contractId?: string;
  readonly contractVersion?: number;
  /** Freeze-at-start snapshot (Foundation spec §9.2). Editing the live
   *  profile can never mutate a running or historical run. */
  readonly frozenProfile: TeamProfile;
  /** Only on-stage seats. Order: the frozen profile's member order. */
  readonly seats: readonly SeatInstance[];
  /** UI-only: which seat is currently expanded in the detail view. */
  readonly selectedSeatId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamSummaryStats {
  readonly running: number;
  readonly waiting: number;
  readonly queued: number;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
}
