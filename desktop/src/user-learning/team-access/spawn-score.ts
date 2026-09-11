// Team spawn scorer (PR-3) — pure functions, 0 LLM.
// Foundation spec §7.2 (2026-09-04): the Governor NEVER auto-spawns and
// NEVER interrupts the Person with a card. Without `confirmedSpawn` the
// answer is always `stay_solo` (or `refuse` for destructive
// skip-verification prompts) — `ask_user` stays in the type union but the
// scorer must never return it. `spawn_team` is reachable ONLY via
// `confirmedSpawn` (the user clicked 开始 on the Team composer).
import type {
  ProductSurface,
  RiskLevel,
  TaskContext,
  UserLearningSnapshot,
} from '../types';
import type { TeamAccessSeatId } from './contract-types';

export type TeamSpawnDecisionKind =
  | 'spawn_team'
  | 'stay_solo'
  | 'ask_user'
  | 'refuse';

export interface PreferenceScore {
  readonly ranking: readonly { readonly id: string; readonly probability: number }[];
  readonly uncertainty: 'low' | 'medium' | 'high';
  readonly scopeFit: 'low' | 'medium' | 'high';
  readonly relevantObservations: number;
  readonly source: 'stub_symbolic' | 'neural_v1';
}

export interface TeamSpawnDecision {
  readonly kind: 'team_spawn';
  readonly decision: TeamSpawnDecisionKind;
  readonly reason: string;
  /** 0..1 heuristic confidence. */
  readonly confidence: number;
  readonly uncertainty: 'low' | 'medium' | 'high';
  readonly taskRisk: RiskLevel;
  readonly reversible: boolean;
  /** §8.3: the 建议一组 button maps the last Person prompt to a template
   *  id; the scorer never invents seats. Kept for spec fidelity — the
   *  button consumes mapSignalsToTemplate directly, not this field. */
  readonly recommendedTemplateId?: 'small-change' | 'architecture' | 'verify-only' | 'deliverable' | 'review-only';
  readonly recommendedSeats: readonly TeamAccessSeatId[];
  /** v0: always true when decision === 'spawn_team' (spec §10.1). */
  readonly requirePersonSeat: boolean;
  readonly requireArchitect: boolean;
  readonly clarificationQuestion?: string;
  readonly refuseCode?: 'safety' | 'irreversible_without_confirm' | 'feature_disabled';
}

/** Parallel to PendingRunChoice; impact-card buttons are never reused. */
export type TeamPendingChoice = 'spawn_team' | 'stay_solo' | 'dismiss';

export interface InferredSignal {
  readonly confidence: number;
  readonly uncertainty: 'low' | 'medium' | 'high';
}

/**
 * Person seat attendance. v0 ruling: spawn_team ⇒ Person on stage,
 first in recommendedSeats. The non-formingTeam inputs only record
 * WHY a representative matters (weak inferred, missing acceptance,
 * vague taste) — they must never flip the answer.
 */
export function requirePersonSeat(input: {
  readonly formingTeam: boolean;
  readonly task: TaskContext;
  readonly inferred: readonly InferredSignal[];
  readonly unknownDecisions: boolean;
  readonly vagueTaste: boolean;
}): boolean {
  if (!input.formingTeam) return false;
  return true;
}

const DESTRUCTIVE_SKIP_RE = /rm\s+-rf|del\s+\/[sf]|format\s+[a-z]:|drop\s+(table|database)/i;
const SKIP_VERIFICATION_RE = /跳过验证|不要审核|不用审核|跳过测试|不要测试|skip (verification|tests?|review)/i;

const VAGUE_TASTE_RE = /别搞太复杂|好看一点|简单点|再改好看|不要太重/;

const ACCEPTANCE_MISSING_RE = /验收|交付|完成标准|acceptance/;

export function hasVagueTaste(prompt: string): boolean {
  return VAGUE_TASTE_RE.test(prompt);
}

export function hasUnknownDecisions(prompt: string, product: ProductSurface): boolean {
  if (product === 'work') {
    return !/docx|xlsx|pptx|md|文档|表格|幻灯|报告/i.test(prompt);
  }
  return !ACCEPTANCE_MISSING_RE.test(prompt) && !/typo/i.test(prompt);
}

function destructiveWithoutVerification(prompt: string): boolean {
  return DESTRUCTIVE_SKIP_RE.test(prompt) && SKIP_VERIFICATION_RE.test(prompt);
}

/**
 * Four-way deterministic spawn decision (Foundation spec §7.2 table).
 * Reads only the given inputs; never touches stores, React, or the clock.
 *
 * Priority: flag off → stay_solo; confirmedSpawn → spawn_team;
 * destructive skip-verification → refuse; everything else → stay_solo.
 * `ask_user` is NEVER returned (spec §0 rule 1 / §7.2.1).
 */
export function scoreTeamSpawn(input: {
  readonly task: TaskContext;
  readonly teamAccessEnabled: boolean;
  readonly preference?: PreferenceScore;
  readonly recentlyAsked: boolean;
  readonly inferred?: readonly InferredSignal[];
  readonly unknownDecisions?: boolean;
  readonly vagueTaste?: boolean;
  /** Set only when the user clicked 开始 on the Team composer. Must
   *  short-circuit to spawn_team; never re-asks (spec §7.2). */
  readonly confirmedSpawn?: boolean;
}): TeamSpawnDecision {
  const { task } = input;
  const base = {
    kind: 'team_spawn' as const,
    taskRisk: task.risk,
    reversible: task.reversible,
  };
  if (!input.teamAccessEnabled) {
    return {
      ...base,
      decision: 'stay_solo',
      reason: 'team access disabled — solo behavior identical to today',
      confidence: 1,
      uncertainty: 'low',
      recommendedSeats: [],
      requirePersonSeat: false,
      requireArchitect: false,
    };
  }
  if (input.confirmedSpawn) {
    // §8.3: roster comes from frozenProfile.members (Person first, unique
    // baseRole), applied in runtime.ts where the freeze is in scope — the
    // spawnDecision() heuristic is forbidden here. Person is always
    // required (§10.1); runtime.ts replaces this anchor with the full
    // frozen roster before rendering the team-access block.
    return {
      ...base,
      decision: 'spawn_team',
      reason: 'user confirmed team spawn on the Team composer',
      confidence: 1,
      uncertainty: 'low',
      recommendedSeats: ['person'],
      requirePersonSeat: true,
      requireArchitect: false,
    };
  }
  if (destructiveWithoutVerification(task.prompt)) {
    return {
      ...base,
      decision: 'refuse',
      reason: 'destructive operation paired with a request to skip verification',
      confidence: 0.95,
      uncertainty: 'low',
      recommendedSeats: [],
      requirePersonSeat: false,
      requireArchitect: false,
      refuseCode: 'safety',
    };
  }
  // Foundation spec §7.2: every remaining signal — medium/high complexity,
  // core path, irreversibility, high uncertainty — stays solo. Assembling
  // a team is a manual action on the Team surface ("让 Person 建议一组"),
  // never a Governor decision and never a Person-conversation card.
  return {
    ...base,
    decision: 'stay_solo',
    reason: 'team assembly is a manual action on the Team surface; Person continues solo',
    confidence: 0.9,
    uncertainty: 'low',
    recommendedSeats: [],
    requirePersonSeat: false,
    requireArchitect: false,
  };
}

/** Convenience wrapper used by later PRs; keeps scorer inputs tidy. */
export function teamSpawnSignalsFromPrompt(prompt: string, product: ProductSurface): {
  readonly unknownDecisions: boolean;
  readonly vagueTaste: boolean;
} {
  return {
    unknownDecisions: hasUnknownDecisions(prompt, product),
    vagueTaste: hasVagueTaste(prompt),
  };
}

/** Stub-scorer input guard: never reads PolicyRule (Latent §4.6). */
export type TeamSpawnSnapshotInput = Pick<UserLearningSnapshot, 'userModels'>;
