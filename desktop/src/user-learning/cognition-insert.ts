// Trylo Desktop — in-task Cognition insertion policy.
// TRYLO-DUAL-SURFACE-LEARNING-MATURITY-SPEC §3.1 / §3.2, as superseded by
// TRYLO-COGNITION-PROACTIVE-REDESIGN-2026-09-06 (触发层改强信号驱动).
//
// A pure gate that decides whether a NON-blocking in-task Cognition card (now
// a corner BADGE, §4) may be shown on a send. It replaces the old
// `clarificationRequired && enforced` branch (which wrongly coupled an
// Impact-classification card to a Shadow-disabled injection). Shadow is NOT a
// condition here — the card is evidence-gathering under Shadow, and only a
// pending Impact (or an already-visible cognition/impact card on THIS
// conversation) suppresses a card.
//
// NOTE (2026-09-06): in-task triggering is now STRONG-SIGNAL driven
// (§2.2). The `inTaskCodeRelevant` / `inTaskWorkRelevant` predicates are NO
// LONGER in-task trigger conditions; they are retained only as pure helpers
// for tests and fifth-mode ordering reuse.

import type { UserLearningSettings, PolicyDimension } from './types';
import type { CognitionQuestion } from './types';
import type { PrepareStart } from './decision-governor';
import { CORE_PATH_MARKERS } from './cognition-skill/map';
import { classifyTaskContext } from './task-context';
import {
  WORK_ARTIFACT_RE,
  WORK_UX_RE,
  WORK_TOOL_RE,
  WORK_REDO_RE,
} from './work-signals';

export interface ShouldInsertInTaskCognitionInput {
  readonly settings: UserLearningSettings;
  readonly preparedStart: PrepareStart;
  /** Whether THIS conversation already carries a pending in-task Cognition
   *  BADGE (or a `learning_impact` card) — one civic question at a time per
   *  conversation. With the §4 redesign the shipped artifact is a corner
   *  badge, not a `cognition_prompt` message card; the gate still means
   *  "one pending cognition session on this conversation". */
  readonly pendingCardOnThisConversation: boolean;
  readonly question: CognitionQuestion | null;
}

/** §3.1 frozen gate: idle + Cognition enabled + no pending card + a question
 *  the trigger actually produced. Shadow-off must not suppress the card. */
export function shouldInsertInTaskCognition(
  input: ShouldInsertInTaskCognitionInput,
): boolean {
  return input.settings.enabled
    && input.settings.cognitionEnabled
    && input.preparedStart === 'ready'
    && !input.pendingCardOnThisConversation
    && input.question !== null;
}

/** Code in-task relevance (historical §3.2); RE-EXPORTED for tests and
 *  fifth-mode ordering reuse. Since 2026-09-06 it is NO LONGER an in-task
 *  trigger condition (triggering is strong-signal driven). Real engineering
 *  prompts (a core-path / persistent / migration change, or an explicit
 *  review/verify request) signal relevance; a bare greeting never.
 *  NOTE: `task-context.ts`'s private CORE_RE / PLAN_RE are NOT referenced —
 *  we compose only the exported CORE_PATH_MARKERS + classifyTaskContext. */
export function inTaskCodeRelevant(prompt: string, dimension?: PolicyDimension): boolean {
  const t = prompt.trim();
  if (!t) return false;
  if (/^(你好|您好|hi|hello|hey|hola|早上好|\u2026)$/i.test(t)) return false;
  // Verification-adjacent wording always counts for the audit dimension.
  if (/审核|review|验证|test|检验|检查/i.test(t)) return true;
  const ctx = classifyTaskContext({ prompt: t, product: 'code' });
  if (ctx.corePath) return true;
  if (ctx.changeType === 'migration' || ctx.changeType === 'core_runtime') return true;
  // Direct mention of a core-path marker counts even without a classifier hit.
  if (CORE_PATH_MARKERS.some((m) => t.toLowerCase().includes(m.toLowerCase()))) return true;
  void dimension;
  return false;
}

/** Work in-task relevance (§3.2). A Work prompt routes toward Work questions
 *  (`q_work_artifact` / `q_tool_workflow` / `q_product_ux`); it must NEVER be
 *  asked a Code `q_verify_scope`. Work-thin is decided by the caller via
 *  `workIsThin(snapshot)` (it needs a snapshot, unavailable here). */
export function inTaskWorkRelevant(prompt: string): boolean {
  const t = prompt.trim();
  return WORK_ARTIFACT_RE.test(t)
    || WORK_UX_RE.test(t)
    || WORK_TOOL_RE.test(t)
    || WORK_REDO_RE.test(t);
}