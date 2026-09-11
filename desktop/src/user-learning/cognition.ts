import { newId } from './ids';
import { inferDimension } from './conclusion';
import { extractPreferenceSignals } from './preference-signals';
import { dimensionLabel } from './labels';
import type {
  CognitionAskEntry,
  CognitionCooldown,
  CognitionQuestion,
  CognitionSession,
  CognitionTriggerType,
  PolicyDimension,
  ProductSurface,
  UserLearningSnapshot,
  UserModelRecord,
} from './types';
import { activeRecords } from './store';
import { QUESTION_BANK } from './cognition-skill/map';

export const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const DISMISS_MS = 72 * 60 * 60 * 1000;
/** §3.3: 连续 2 次无视后该维度降权 7 天（in-task 全路径不可触发）。 */
export const DEMOTE_MS = 7 * 24 * 60 * 60 * 1000;

/** Work-surface dimensions. On a Work task we never reach across to a Code
 *  dimension like `q_verify_scope` (spec §3.2). */
const WORK_DIMENSIONS: ReadonlySet<PolicyDimension> = new Set([
  'work_artifact_workflow',
  'tool_workflow',
  'product_ux_acceptance',
]);

export function isWorkDimension(dimension: PolicyDimension): boolean {
  return WORK_DIMENSIONS.has(dimension);
}

export function cooling(
  cooldowns: readonly CognitionCooldown[],
  dimension: PolicyDimension,
  now: number,
  key?: string,
): boolean {
  // With a key (team clarifications, conversation-level caps): only a
  // cooldown recorded for that exact key blocks — other dimensions'
  // cooldowns never do.
  if (key !== undefined) {
    return cooldowns.some((c) => c.key === key && c.until > now);
  }
  return cooldowns.some((c) => c.dimension === dimension && c.until > now);
}

/** Spec §3.2 (M4): the per-conversation 6h in-task card cap. Unlike the
 *  per-dimension cooldown above this is CONVERSATION-scoped: a card's
 *  resolve/dismiss starts a 6h window in which NO in-task card may be
 *  inserted into this conversation again, across all dimensions. Reuses the
 *  `CognitionCooldown` shape (spec M4: 同构复用, keyed
 *  `conversation:<id>`) and lands in the User Learning snapshot, so it
 *  survives a restart (an in-memory ref would make the cap useless). */
export function conversationCooldownKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function conversationCardCooling(
  cooldowns: readonly CognitionCooldown[],
  conversationId: string,
  now: number,
): boolean {
  return cooling(cooldowns, 'agent_autonomy', now, conversationCooldownKey(conversationId));
}

export function evaluateCognitionTrigger(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly prompt: string;
  readonly dissatisfaction?: boolean;
  readonly product?: ProductSurface;
  readonly intent?: 'in_task' | 'fifth_mode';
  readonly now?: number;
}): CognitionQuestion | null {
  const now = input.now ?? Date.now();
  if (input.dissatisfaction) {
    const q = QUESTION_BANK.find((item) => item.dimension === inferDimension(input.prompt)) ?? QUESTION_BANK[0]!;
    if (cooling(input.snapshot.cognitionCooldowns, q.dimension, now)) return null;
    return { ...q, trigger: 'explicit_dissatisfaction', prompt: '这次结果可能没有按你的预期走。是我对你的工程偏好理解错了，还是这次具体任务判断错了？你告诉我哪里最不对就可以。' };
  }
  const map = cognitionMap(input.snapshot, now);
  const conflict = map.find((item) => item.state === 'conflict' && !cooling(input.snapshot.cognitionCooldowns, item.dimension, now));
  if (conflict) {
    const q = QUESTION_BANK.find((item) => item.dimension === conflict.dimension) ?? QUESTION_BANK[0]!;
    return { ...q, trigger: 'model_conflict', prompt: `${q.prompt}\n\n我现在同时看到互相冲突的证据，需要你划清作用域。` };
  }
  const drift = map.find((item) => item.state === 'drift' && !cooling(input.snapshot.cognitionCooldowns, item.dimension, now));
  if (drift) {
    const q = QUESTION_BANK.find((item) => item.dimension === drift.dimension) ?? QUESTION_BANK[0]!;
    return { ...q, trigger: 'significant_drift', prompt: `${q.prompt}\n\n这个偏好最近看起来在变，想确认哪一边才是长期要求。` };
  }

  // §2.2 step 4 (NEW): strong-signal trigger. In-task only asks when THIS turn
  // carries an explicit preference strong signal AND that dimension is neither
  // cooled nor demoted. `extractPreferenceSignals` merges the old
  // dissatisfaction semantics, so pure gap ("还不懂") no longer triggers.
  const signals = extractPreferenceSignals(input.prompt ?? '', input.product ?? 'code');
  for (const sig of signals) {
    if (cooling(input.snapshot.cognitionCooldowns, sig.dimension, now)) continue;
    const q = questionForDimension(sig.dimension);
    if (!q) continue;
    return { ...q, trigger: 'explicit_signal' };
  }

  // §2.2 step 5: the missing-gap loop is DELETED for `in_task`. Gap-driven
  // asking now lives only in the user-opened fifth mode (`nextCognitionQuestion`,
  // which is gated separately and never routes through here).
  if (input.intent === 'in_task') return null;

  // Fifth-mode gap ordering (unchanged contract; only reachable by non-in-task
  // callers, since `in_task` returned null above — so the surface-relevance
  // flags are gone and the loop simply keeps per-surface isolation).
  const isWork = input.product === 'work';
  const models = activeRecords(input.snapshot.userModels);
  for (const question of questionOrder(input.product)) {
    if (cooling(input.snapshot.cognitionCooldowns, question.dimension, now)) continue;
    const has = models.some((m) => m.dimension === question.dimension && m.confidence.band !== 'low');
    if (has) continue;
    if (isWork) {
      if (!isWorkDimension(question.dimension)) continue;
    } else {
      if (isWorkDimension(question.dimension)) continue;
    }
    return question;
  }
  return null;
}

/** Resolve a trigger dimension to a concrete question, synthesising a generic
 *  one for dimensions without a QUESTION_BANK entry. */
function questionForDimension(dimension: PolicyDimension): CognitionQuestion | null {
  const banked = QUESTION_BANK.find((item) => item.dimension === dimension);
  if (banked) return banked;
  return {
    id: `q_signal_${dimension}`,
    dimension,
    trigger: 'explicit_signal',
    prompt: `你说到这个方面，想确认下对「${dimensionLabel(dimension)}」的偏好，好在之后每类任务里都用对。`,
    scopeHint: 'explicit signal',
  };
}

/** Finance-agnostic per-product question order (§3.3 shared selector): a Work
 *  surface surfaces Work dimensions first; Code keeps the engineering-first
 *  order in QUESTION_BANK (which already lists Work dimensions last). */
export function questionOrder(product?: ProductSurface): readonly CognitionQuestion[] {
  if (product === 'work') {
    const work = QUESTION_BANK.filter((q) => isWorkDimension(q.dimension));
    const rest = QUESTION_BANK.filter((q) => !isWorkDimension(q.dimension));
    return [...work, ...rest];
  }
  return QUESTION_BANK;
}

export function cognitionMap(
  snapshot: UserLearningSnapshot,
  now = Date.now(),
): readonly { dimension: PolicyDimension; state: 'missing' | 'conflict' | 'drift' | 'ok' }[] {
  void now;
  const models = activeRecords(snapshot.userModels);
  const conclusions = activeRecords(snapshot.conclusions);
  return QUESTION_BANK.map((question) => {
    const dim = question.dimension;
    const model = models.find((item) => item.dimension === dim);
    const related = conclusions.filter((item) => item.dimension === dim);
    if (related.some((item) => item.temporal.state === 'drifting')) {
      return { dimension: dim, state: 'drift' as const };
    }
    if (
      related.some((item) => item.temporal.state === 'disputed')
      || snapshot.conclusionRelations.some((rel) => rel.type === 'contradicts' && related.some((item) => item.id === rel.fromId || item.id === rel.toId))
    ) {
      return { dimension: dim, state: 'conflict' as const };
    }
    if (!model || model.confidence.band === 'low') {
      return { dimension: dim, state: 'missing' as const };
    }
    return { dimension: dim, state: 'ok' as const };
  });
}

export function openCognitionSession(input: {
  readonly userId: string;
  readonly question: CognitionQuestion;
  readonly trigger: CognitionTriggerType;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  /** Fifth mode is isolated per product (§3.4). Defaults to 'code'. */
  readonly product?: ProductSurface;
  /** The in-task conversation the card was inserted into (§3.2 M4). */
  readonly conversationId?: string;
  readonly now?: number;
  readonly opening?: string;
}): CognitionSession {
  const now = input.now ?? Date.now();
  const opening = input.opening?.trim();
  return {
    id: newId('cog', now),
    userId: input.userId,
    trigger: input.trigger,
    dimension: input.question.dimension,
    questions: [input.question],
    answers: [],
    messages: opening
      ? [{ id: newId('cmsg', now), role: 'assistant', text: opening, at: now }]
      : [],
    status: 'open',
    evidenceIds: [],
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    taskId: input.taskId,
    ...(input.product ? { product: input.product } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function bootstrapPrompt(): CognitionQuestion {
  return {
    id: 'q_bootstrap',
    dimension: 'agent_autonomy',
    trigger: 'bootstrap_optional',
    prompt: '普通低风险工作和核心路径，你对「直接做 / 先计划 / 验证深度」的要求一样吗？不一样的话，边界在哪？',
    options: [
      '普通工作直接做；核心先计划并保留最终验证',
      '以后再通过真实工作慢慢学习',
    ],
    scopeHint: 'bootstrap',
  };
}

/** Seed question for the fifth-mode chat. Not shown as a form. */
export function chatSeedQuestion(): CognitionQuestion {
  return {
    id: 'q_chat',
    dimension: 'agent_autonomy',
    trigger: 'user_opened',
    prompt: '这轮只聊你怎么跟我干活。',
    scopeHint: 'chat',
  };
}

export function cooldownFor(
  dimension: PolicyDimension,
  kind: CognitionCooldown['reason'],
  now = Date.now(),
): CognitionCooldown {
  const span = kind === 'snooze' ? SNOOZE_MS
    : kind === 'dont_ask_similar' ? DISMISS_MS
      : kind === 'dismiss' || kind === 'not_now' ? DISMISS_MS
        : kind === 'demoted' ? DEMOTE_MS
          : COOLDOWN_MS;
  return { dimension, until: now + span, reason: kind };
}

/** §3.3: 该维度 askLog 末尾**连续** `ignored` 条数。`answered` / `dismissed`
 *  （以及已降权改写后的 `ignored_demoted`）都会**重置**连击。 */
export function askStreak(
  askLog: readonly CognitionAskEntry[],
  dimension: PolicyDimension,
): number {
  let streak = 0;
  for (let i = askLog.length - 1; i >= 0; i -= 1) {
    const entry = askLog[i]!;
    if (entry.dimension !== dimension) continue;
    if (entry.outcome !== 'ignored') break;
    streak += 1;
  }
  return streak;
}

/** Spec §3.2 (M4): the per-conversation 6h top written when an in-task card
 *  resolves or is dismissed. Always exactly COOLDOWN_MS (6h) regardless of
 *  the dismiss kind — the card cap is a fixed conversation gap, not a
 *  dimension-level don't-ask-again. */
export function conversationCooldownFor(
  conversationId: string,
  kind: CognitionCooldown['reason'],
  now = Date.now(),
): CognitionCooldown {
  return {
    dimension: 'agent_autonomy',
    key: conversationCooldownKey(conversationId),
    until: now + COOLDOWN_MS,
    reason: kind,
  };
}

export function missingDimensions(models: readonly UserModelRecord[]): readonly PolicyDimension[] {
  const have = new Set(activeRecords(models).map((m) => m.dimension));
  return QUESTION_BANK.map((q) => q.dimension).filter((d) => !have.has(d));
}

export function nextCognitionQuestion(
  snapshot: UserLearningSnapshot,
  except?: PolicyDimension,
  now = Date.now(),
  product?: ProductSurface,
): CognitionQuestion | null {
  for (const question of questionOrder(product)) {
    if (question.dimension === except) continue;
    if (cooling(snapshot.cognitionCooldowns, question.dimension, now)) continue;
    const has = activeRecords(snapshot.userModels)
      .some((m) => m.dimension === question.dimension && m.confidence.band !== 'low');
    if (!has) return question;
  }
  return null;
}

export function isCognitionStop(text: string): 'dismiss' | 'snooze' | 'dont_ask_similar' | null {
  const t = text.trim();
  if (/^(现在不|先不|dismiss|not now)$/i.test(t)) return 'dismiss';
  if (/稍后|snooze/i.test(t)) return 'snooze';
  if (/别再问|don't ask/i.test(t)) return 'dont_ask_similar';
  return null;
}

// ── User Cognition Skill facade ────────────────────────────────────
// The "how to ask" methodology lives in cognition-skill/. Re-export the
// self-contained modules here so existing consumers (runtime.ts, App,
// user-learning/index.ts) keep a single stable import surface from
// './cognition'. claimFromCognitionAnswer moved into answer-resolution.ts
// but is re-exported unchanged. question-selector / stop import FROM
// '.' one-way (no cycle), so they are reached via cognition-skill/*.
export {
  claimFromCognitionAnswer,
  resolveAnswer,
  scopeBoundaryPrompt,
  type AnswerResolution,
  type CandidateAnswer,
  type AnswerFollowUp,
} from './cognition-skill/answer-resolution';
export {
  frameQuestion,
  scopeBoundaryQuestion,
} from './cognition-skill/question-strategy';
export { QUESTION_BANK } from './cognition-skill/map';
