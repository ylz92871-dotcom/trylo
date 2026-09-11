/**
 * User Cognition Skill — Question Selector (Skill doc §10 / §6).
 *
 * Decides "which uncertainty is worth eliminating right now", driven by
 * the Cognition Map + current User Model gaps + cooldowns. This is a thin
 *, ergonomic wrapper over cognition.ts's trigger evaluation so skill
 * consumers don't reach into trigger internals.
 */

import type { CognitionQuestion, ProductSurface, UserLearningSnapshot } from '../types';
import { evaluateCognitionTrigger, nextCognitionQuestion } from '../cognition';
import { bootstrapPrompt } from '../cognition';

export interface SelectQuestionInput {
  readonly snapshot: UserLearningSnapshot;
  /** Current real-task prompt, if any. */
  readonly prompt?: string;
  readonly dissatisfaction?: boolean;
  /** Surface context (TRYLO-DUAL-SURFACE-SPEC §3.3) — threaded all the way
   *  down so Work-thin ordering is one source of truth. */
  readonly product?: ProductSurface;
}

export function selectQuestion(
  input: SelectQuestionInput,
): CognitionQuestion | null {
  const triggered = evaluateCognitionTrigger({
    snapshot: input.snapshot,
    prompt: input.prompt ?? '',
    dissatisfaction: input.dissatisfaction,
    product: input.product,
    intent: 'fifth_mode',
  });
  if (triggered) return triggered;
  // No high-value trigger in flight next planned gap (already cooldown-aware).
  const gap = nextCognitionQuestion(input.snapshot, undefined, Date.now(), input.product);
  return gap ?? null;
}

export { bootstrapPrompt };

/** Convenience: is the user asking to stop / skip the current question? */
export { isCognitionStop } from '../cognition';