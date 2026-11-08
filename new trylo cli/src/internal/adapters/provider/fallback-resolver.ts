import type { ProviderErrorClass } from "../../ports/provider.js";

/**
 * Model fallback on transient provider failure (WP18.2: L05).
 *
 * Reuse: legacy `services/api/withRetry.ts` (foreground/background retry
 * discipline, `FallbackTriggeredError`) and `query.ts:692,912` (switch
 * `currentModel` to `fallbackModel` and retry the attempt), narrowed to a pure
 * decision plus the one validation legacy performs in `main.tsx:1385`.
 *
 * The loop this serves is deliberately *not* in this file: the decision of
 * "this error class may move to the fallback" is pure and testable, while the
 * act of re-running a turn already has exactly one owner
 * (`surface/cli/run-one-turn.ts`), which calls back into this module.
 */

export type FallbackDeclaration = {
  /** The model the run started on. */
  readonly primary: string;
  /** The model to move to. Absent means no fallback is configured. */
  readonly fallback?: string;
};

export type FallbackValidation =
  | { readonly ok: true; readonly declaration: FallbackDeclaration }
  | { readonly ok: false; readonly code: "same_model"; readonly detail: string };

/**
 * Validate a `--fallback-model` value the way legacy does: a fallback that is
 * the primary is a usage error, not a silent second attempt at the same model.
 * An absent or blank fallback is "not configured", never an error.
 */
export function validateFallback(primary: string, fallback: string | undefined): FallbackValidation {
  const wanted = fallback?.trim() ?? "";
  if (wanted.length === 0) {
    return { ok: true, declaration: { primary } };
  }

  if (wanted === primary) {
    return {
      ok: false,
      code: "same_model",
      detail: "fallback model cannot be the same as the main model; specify a different model for --fallback-model",
    };
  }

  return { ok: true, declaration: { primary, fallback: wanted } };
}

/** Error classes a fallback may rescue, mirroring the TEMPORARY exit mapping. */
const FALLBACK_RESCUABLE: ReadonlySet<ProviderErrorClass> = new Set([
  "rate_limit",
  "server",
  "network",
  "timeout",
]);

export function isFallbackRescuable(errorClass: ProviderErrorClass): boolean {
  return FALLBACK_RESCUABLE.has(errorClass);
}

export type FallbackDecision =
  | { readonly action: "stay" }
  | { readonly action: "switch"; readonly model: string };

/**
 * After a failed primary attempt, decide whether to move.
 *
 * `alreadyFellBack` is the once-per-turn latch: legacy retries the attempt a
 * single time on the fallback (`attemptWithFallback` runs at most twice), and
 * a second failure on the fallback is the turn's failure, not a reason to
 * ping-pong. Auth, invalid requests and other terminal classes never move —
 * retrying those on another model spends the user's budget to learn the same
 * refusal twice.
 */
export function decideFallback(
  declaration: FallbackDeclaration,
  errorClass: ProviderErrorClass,
  alreadyFellBack: boolean,
): FallbackDecision {
  const target = declaration.fallback;
  if (target === undefined || alreadyFellBack) {
    return { action: "stay" };
  }

  if (!isFallbackRescuable(errorClass)) {
    return { action: "stay" };
  }

  return { action: "switch", model: target };
}
