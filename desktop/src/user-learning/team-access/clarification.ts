// Team clarification → CognitionQuestion (PR-5, spec §11.2).
//
// Person seat `User questions` bubble up here; the seat never talks to
// the user and never writes the User Model. The produced question feeds
// the existing Cognition UI (trigger `team_clarification`); the user's
// answer becomes Evidence and later `reviseContract` input. Empty
// questions → null. `CognitionQuestion.dimension` is REQUIRED, so a
// task-level question defaults to `engineering_language_semantics`;
// `inferDimension` treats `agent_autonomy` as its universal fallback,
// which counts as "no hit" here.
import { inferDimension } from '../conclusion';
import { cooling } from '../cognition';
import { sourceHash } from '../ids';
import type {
  CognitionQuestion,
  PolicyDimension,
  RiskLevel,
  UserLearningSnapshot,
} from '../types';

export interface TeamClarificationRequest {
  readonly kind: 'team_clarification';
  readonly teamRunId: string;
  /** Optional from the App (it may not hold the contract id); the
   *  runtime fills both from its per-conversation cache. */
  readonly contractId?: string;
  readonly contractVersion?: number;
  readonly seatId?: string;
  readonly questions: readonly string[];
  /** Person `intent.unknown` lines, used to clear resolved inferred
   *  clauses when the user answers (spec §8.7 / §11.3). */
  readonly unknownItems?: readonly string[];
  readonly blocking: boolean;
  readonly risk: RiskLevel;
  /** `${contractId}:${sourceHash(questions)}` — computed by the runtime
   *  when the caller omits it. */
  readonly cooldownKey?: string;
}

export function teamClarificationCooldownKey(
  contractId: string,
  questions: readonly string[],
): string {
  return `${contractId}:${sourceHash(questions)}`;
}

/** The effective cooldown key for a (possibly incomplete) request.
 *  Keyed by teamRunId + questions: contractId changes on every revision
 *  (§8.7), but a re-asked question group within one TeamRun must cool
 *  under the SAME key (spec §11.2 intent: dont_ask_similar per group). */
export function resolveTeamClarificationKey(req: TeamClarificationRequest): string {
  return req.cooldownKey
    ?? teamClarificationCooldownKey(req.teamRunId, req.questions);
}

const DEFAULT_DIMENSION: PolicyDimension = 'engineering_language_semantics';

function dimensionForQuestion(prompt: string): PolicyDimension {
  const hit = inferDimension(prompt);
  return hit === 'agent_autonomy' ? DEFAULT_DIMENSION : hit;
}

/**
 * Build the CognitionQuestion for one team-clarification group. All
 * questions merge into a single prompt (v0 asks one group, never a
 * thread). Null when the Person seat asked nothing.
 */
export function clarificationFromPersonOutput(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly request: TeamClarificationRequest;
  readonly now?: number;
}): CognitionQuestion | null {
  const questions = input.request.questions
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  if (questions.length === 0) return null;
  const first = questions[0]!;
  const prompt = questions.length > 1
    ? `${first}\n（一并确认：${questions.slice(1).join('；')}）`
    : first;
  const key = resolveTeamClarificationKey(input.request);
  return {
    id: `q_team_${sourceHash([key]).slice(6, 16)}`,
    dimension: dimensionForQuestion(prompt),
    trigger: 'team_clarification',
    prompt,
    scopeHint: 'team_clarification',
  };
}

/**
 * True when this clarification group was already answered or dismissed
 * (same cooldownKey). Keyed lookup: other dimensions' cooldowns never
 * block a team question (spec §11.2).
 */
export function teamClarificationCooling(
  snapshot: UserLearningSnapshot,
  request: TeamClarificationRequest,
  now: number,
): boolean {
  return cooling(snapshot.cognitionCooldowns, DEFAULT_DIMENSION, now, request.cooldownKey);
}
