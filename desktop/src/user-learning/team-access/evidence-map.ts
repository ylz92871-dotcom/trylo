// Team evidence provenance (PR-9, spec §13).
//
// Team results re-enter the EXISTING learning chain: Trace → Evidence →
// Conclusion → User Model. Only user-actor events are evidence
// (`extractEvidenceFromTrace.userSourced` is untouched); seat output —
// including a Person veto or a seat VERDICT: PASS — never becomes
// evidence. Provenance rides in `UserDecisionEvent.structured` so the
// UL snapshot v2 shape stays untouched; `agentPolicyCaused` marks
// behavior produced by Team Translation / Personal Policy so future
// preference training can exclude it (Latent Preference §4.6).
import type { TeamAccessSeatId } from './contract-types';

export type TeamEvidenceSource = 'team_seat' | 'personal_agent' | 'user';

export interface TeamEvidenceProvenance {
  readonly source: TeamEvidenceSource;
  readonly seatId?: TeamAccessSeatId;
  readonly teamRunId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly agentPolicyCaused: boolean;
}

export const TEAM_PROVENANCE_KEY = 'teamProvenance';

/**
 * Build provenance for a user action inside a team run. `source` is
 * 'user' by construction — callers are App-side user actions (stop,
 * approval, steer, clarification answer).
 */
export function teamEvidenceProvenance(input: {
  readonly seatId?: TeamAccessSeatId;
  readonly teamRunId: string;
  readonly contractId: string;
  readonly contractVersion: number;
  readonly agentPolicyCaused?: boolean;
}): TeamEvidenceProvenance {
  return {
    source: 'user',
    ...(input.seatId ? { seatId: input.seatId } : {}),
    teamRunId: input.teamRunId,
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    agentPolicyCaused: input.agentPolicyCaused ?? false,
  };
}

/**
 * Merge provenance into an event's `structured` carrier without
 * disturbing other keys. Returns the event unchanged when provenance is
 * undefined (no team run → no provenance, byte-identical events).
 */
export function withTeamProvenance<E extends object>(
  event: E,
  provenance: TeamEvidenceProvenance | undefined,
): E {
  if (!provenance) return event;
  const structured = (event as { structured?: Readonly<Record<string, unknown>> }).structured;
  return {
    ...event,
    structured: {
      ...(structured ?? {}),
      [TEAM_PROVENANCE_KEY]: provenance,
    },
  };
}

/** Read provenance back from an event's structured carrier. */
export function teamProvenanceOf(event: { readonly structured?: Readonly<Record<string, unknown>> }): TeamEvidenceProvenance | undefined {
  const value = event.structured?.[TEAM_PROVENANCE_KEY];
  return value && typeof value === 'object' ? (value as TeamEvidenceProvenance) : undefined;
}
