import type { ExperienceReviewRequest } from "../experience-port.js";
import type { CentralLearningRemaining } from "../../../../control/coordination-contract.js";
import { EXPERIENCE_REVIEW_INSTRUCTION } from "./review-instruction.js";
import { EXPERIENCE_MODEL_LIMITS as LIMITS } from "./experience-budget.js";
import { packReviewMaterial } from "./review-material.js";

export type ExperienceReviewEnvelope = {
  readonly ok: true; readonly material: string; readonly supplied: ExperienceReviewRequest;
  readonly maxOutputTokens: number; readonly maxTokens: number;
} | { readonly ok: false; readonly reason: string };

const MIN_REVIEW_OUTPUT_TOKENS = 768;

/** Prepare and execution share the same conservative UTF-8 envelope. This is an
 * engineering cap, never a learned price, future invoice or spending authority.
 */
export function prepareExperienceReviewEnvelope(request: ExperienceReviewRequest,
  remaining: CentralLearningRemaining, maxPromptChars: number): ExperienceReviewEnvelope {
  const charBudget = Math.min(LIMITS.promptChars, maxPromptChars) - EXPERIENCE_REVIEW_INSTRUCTION.length;
  const tokenBudget = Math.min(LIMITS.reservationTokens, remaining.tokens);
  const instructionBytes = new TextEncoder().encode(EXPERIENCE_REVIEW_INSTRUCTION).length;
  if (tokenBudget - instructionBytes - 256 < MIN_REVIEW_OUTPUT_TOKENS || remaining.calls < 1 || remaining.steps < 1) {
    return { ok: false, reason: "method_review_budget_exhausted" };
  }

  let packed = packReviewMaterial(request, charBudget, tokenBudget - instructionBytes - 256 - LIMITS.outputTokens);
  if (!packed.ok) packed = packReviewMaterial(request, charBudget, tokenBudget - instructionBytes - 256 - MIN_REVIEW_OUTPUT_TOKENS);

  if (!packed.ok) return packed;

  const inputReserve = new TextEncoder().encode(EXPERIENCE_REVIEW_INSTRUCTION + packed.material).length + 256;
  const maxOutputTokens = Math.min(LIMITS.outputTokens, tokenBudget - inputReserve);

  return maxOutputTokens < MIN_REVIEW_OUTPUT_TOKENS ? { ok: false, reason: "method_review_budget_exhausted" }
    : { ...packed, maxOutputTokens, maxTokens: inputReserve + maxOutputTokens };
}
