import type { ProviderErrorClass } from "../ports/provider.js";

/**
 * Classifying a provider's own budget rejections (WP09.3 / L06).
 *
 * The port carries a provider refusal as an `error` event with a class and a
 * message. Inside that pair, a few message shapes name a *budget* refusal —
 * the prompt or an attachment, not the model's conduct — and each named shape
 * has exactly one honest answer:
 *
 *  - `prompt_too_long` — the request itself is over the provider's context
 *    window; a compaction is the answer, so the loop may force one and retry;
 *  - `media_too_large` — an attachment is over the provider's size limit;
 *    there is no honest recovery (dropping the attachment would drop the
 *    user's words), so the loop reports the classification and fails.
 *
 * Everything else is not a budget refusal and stays whatever the failure path
 * already makes of it. The patterns are inherited from the legacy runtime's
 * recovery branches (`trylo cli/src/query.ts` prompt-too-long handling) and
 * Codex's context-window errors; they match messages, because the wire has no
 * better code for this — the class alone (`invalid_request`) also covers
 * ordinary bad requests that no compaction can fix.
 */

export type BudgetRejectionKind = "prompt_too_long" | "media_too_large";

export type BudgetRejection = {
  readonly kind: BudgetRejectionKind;
  /** The provider's own sentence, redacted by the adapter; diagnostics only. */
  readonly message: string;
};

const PROMPT_TOO_LONG_PATTERNS: ReadonlyArray<RegExp> = [
  /prompt is too long/i,
  /maximum context length/i,
  /context length exceeds/i,
  /context_length_exceeded/i,
  /exceed[s]? the context window/i,
  /input length and `?max_tokens`? exceed/i,
  /request too large/i,
  /too many (input )?tokens/i,
  /reduce the length of (the|your) (prompt|messages)/i,
];

const MEDIA_TOO_LARGE_PATTERNS: ReadonlyArray<RegExp> = [
  /image (exceeds|is too large|too large)/i,
  /image exceeds maximum/i,
  /media (exceeds|is too large|too large)/i,
  /file (exceeds|is too large|too large) (the )?maximum/i,
  /asset (exceeds|is too large)/i,
];

/** Only these classes can carry a budget refusal; anything else is not one. */
const BUDGET_REJECTION_CLASSES: ReadonlyArray<ProviderErrorClass> = ["invalid_request"];

export function classifyBudgetRejection(
  errorClass: ProviderErrorClass,
  message: string,
): BudgetRejection | undefined {
  if (!BUDGET_REJECTION_CLASSES.includes(errorClass)) {
    return undefined;
  }

  if (MEDIA_TOO_LARGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "media_too_large", message };
  }

  if (PROMPT_TOO_LONG_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "prompt_too_long", message };
  }

  return undefined;
}
