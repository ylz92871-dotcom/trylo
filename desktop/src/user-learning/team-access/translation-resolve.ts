// Per-seat Team Translation projector (PR-4, spec §9.3).
//
// 0 LLM. A seat sees audience `team` rules plus its own
// `seat:${id}` rules. Shadow yields empty instructions — the bundle and
// LearningRun are still produced upstream, only the injectable text is
// withheld. Per-seat budget is 250 tokens; trimming drops the weakest
// strengths first and never drops `hard` (spec §9.3).
import { estimateTokens } from '../ids';
import type { EnforcementMode } from '../types';
import type { TeamAccessSeatId } from './contract-types';
import type { TeamTranslationProjection, TeamTranslationRule } from './translation-compiler';

const STRENGTH_RANK: Record<TeamTranslationRule['strength'], number> = {
  hard: 100,
  strong_default: 70,
  soft: 40,
  advisory: 10,
};

const MAX_SEAT_TOKENS = 250;

export function projectSeatTranslation(input: {
  readonly rules: readonly TeamTranslationRule[];
  readonly seat: TeamAccessSeatId;
  readonly mode: EnforcementMode;
}): TeamTranslationProjection {
  const audience: TeamTranslationProjection['audience'] = `seat:${input.seat}`;
  if (input.mode !== 'enforced') {
    return { audience, instructions: [], tokenCountEstimate: 0, mode: input.mode };
  }
  const applicable = input.rules.filter(
    (r) => r.status === 'active' && (r.audience === 'team' || r.audience === audience),
  );
  const ordered = [...applicable].sort(
    (a, b) => STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength],
  );
  const instructions: string[] = [];
  const kept: TeamTranslationRule[] = [];
  let tokens = 0;
  for (const rule of ordered) {
    if (estimateTokens(rule.instruction) + tokens > MAX_SEAT_TOKENS && STRENGTH_RANK[rule.strength] < 100) {
      continue; // soft/advisory overflow is droppable; hard never is
    }
    instructions.push(rule.instruction);
    kept.push(rule);
    tokens += estimateTokens(rule.instruction);
  }
  void kept;
  return { audience, instructions, tokenCountEstimate: tokens, mode: input.mode };
}

export function projectAllSeats(
  rules: readonly TeamTranslationRule[],
  mode: EnforcementMode,
): Readonly<Record<TeamAccessSeatId, TeamTranslationProjection>> {
  const seats: readonly TeamAccessSeatId[] = [
    'person',
    'architect',
    'worker',
    'reviewer',
    'verifier',
    'cad-planner',
    'cad-verifier',
  ];
  return Object.fromEntries(
    seats.map((seat) => [seat, projectSeatTranslation({ rules, seat, mode })]),
  ) as Readonly<Record<TeamAccessSeatId, TeamTranslationProjection>>;
}
