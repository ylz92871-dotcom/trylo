/**
 * User Cognition Skill — Stop Policy (Skill doc §14 / §15).
 *
 * Decides when to stop the cognition session. The core principle (§14):
 * "get enough to support Agent work, then stop". Implemented as two
 * helpers the host can call after each answer.
 */

import type { UserLearningSnapshot } from '../types';
import { isCognitionStop as rawIsStop, nextCognitionQuestion } from '../cognition';

export type CognitionStopKind = 'dismiss' | 'snooze' | 'dont_ask_similar' | null;

/**
 * Check if the user's text means "stop now" (Skill doc §14.1 / §15).
 * Returns the stop kind or null if the user wants to continue.
 */
export function checkStop(text: string): CognitionStopKind {
  return rawIsStop(text);
}

/**
 * Should the session stop after this answer? Returns true when the
 * question bank is exhausted (no further gaps worth filling) or the
 * marginal value of another question is too low (§14.1).
 */
export function shouldStopAfterAnswer(snapshot: UserLearningSnapshot): boolean {
  return nextCognitionQuestion(snapshot) === null;
}

/**
 * A cooldown-eligible stop decision. Returns the cooldown dimension.
 * The caller (surface) should call dismissCognition with the kind.
 */
export { cooldownFor } from '../cognition';