// Trylo Desktop — Work-surface Hermes dual-plane gate.
// TRYLO-DUAL-SURFACE-LEARNING-MATURITY-SPEC §2.3 / §2.4.
//
// User plane and Task plane share the same Agent loop but never the store,
// the proposals, or the auto-injected prompt slot. These helpers decide
// WHETHER a finished Work (or Code) turn may spawn a Hermes review /
// mirror — and in which `mode`.
//
// Two rules are frozen here so the UI and the observer can never disagree:
//   - a pending `learning_impact` card BLOCKS Hermes review (it already
//     `skipWork`/`skipAgent`s the run; when it resumes the card is gone);
//   - a pending in-task `cognition_prompt` card does NOT block Hermes —
//     Cognition is evidence-gathering, only Impact is blocking.
//
// `hermesWorkLearning` is scoped to Work only: `false` turns off BOTH the
// mirror and the review for Work turns, leaving Code and User Learning
// untouched. This is NOT a User Learning setting.

import type { ChatMessage } from '../components/chat/types';
import type { ConversationRecord } from '../host-adapter/conversation-history';
import type { CodeMode } from '../host-adapter/types';
import type { TryloSettings } from '../settings/settings-store';
import { planPostTerminal } from './learning-balance';

/** Hermes work-learning flag. `false` turns Work mirror + review off.
 *  Code and Work-less records are always allowed (flag is Work-scoped). */
export function workHermesEnabled(
  settings: TryloSettings,
  record: ConversationRecord | null,
): boolean {
  if (!record || record.session.kind !== 'work') return true;
  return settings.hermesWorkLearning !== false;
}

/** The review `mode` a finished turn should use. Derive it from the record —
 *  never hardcode `'agent'`. A Work conversation (or one whose session mode
 *  is already `office`) reviews as `'office'`; everything else as `'agent'`. */
export function deriveReviewMode(record: ConversationRecord): 'agent' | 'office' {
  return record.session.kind === 'work' || record.session.mode === 'office'
    ? 'office'
    : 'agent';
}

/** True when the conversation has a pending BLOCKING Impact card. Only
 *  `learning_impact` counts — a non-blocking `cognition_prompt` must never
 *  gate Hermes (Key Decision 3). */
export function pendingBlockingInterrupt(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (m) => m.kind === 'learning_impact' && 'status' in m && m.status === 'pending',
  );
}

/** Dual-plane gate for a finished turn's Hermes review. Reads the THIS
 *  conversation's record (never a global message ref) so concurrent /
 *  switched conversations cannot leak through.
 *
 *  Work turns ignore `codeMode === 'cognition'` (that skip is Code-only —
 *  a Work turn can never BE the fifth mode, which lives on its own surface).
 */
export function allowHermesReview(input: {
  readonly record: ConversationRecord;
  readonly settings: TryloSettings;
  readonly codeMode: CodeMode;
}): boolean {
  if (!workHermesEnabled(input.settings, input.record)) return false;
  const isWork = input.record.session.kind === 'work';
  return planPostTerminal({
    outcome: 'completed',
    userLearningEnabled: input.settings.userLearning.enabled,
    hermesEnabled: true,
    cognitionTurn: !isWork && input.codeMode === 'cognition',
    pendingUserInterrupt: pendingBlockingInterrupt(input.record.messages ?? []),
  }).hermesReview;
}

/** PR-5: Check if a deliverable praise/promote/template event can trigger an
 *  explicit Learn call. Returns `{ allowed, reasonCode }` matching the
 *  orchestrator's `checkExplicitLearn` semantics but aware of the Work surface.
 *
 *  A running agent (implicit is still flying) → `learn_explicit_skipped`;
 *  Evidence still writes. idle → allowed with `mode: 'office'`. */
export function checkExplicitLearn(input: {
  readonly agentRunning: boolean;
  readonly hasPendingReview: boolean;
  readonly processedHashes: readonly string[];
  readonly evidenceHash: string;
}): { allowed: boolean; reasonCode: string } {
  if (input.agentRunning) {
    return { allowed: false, reasonCode: 'EXPLICIT_AGENT_RUNNING' };
  }
  if (input.hasPendingReview) {
    return { allowed: false, reasonCode: 'EXPLICIT_REVIEW_PENDING' };
  }
  if (input.processedHashes.includes(input.evidenceHash)) {
    return { allowed: false, reasonCode: 'EXPLICIT_HASH_PROCESSED' };
  }
  return { allowed: true, reasonCode: 'EXPLICIT_OK' };
}