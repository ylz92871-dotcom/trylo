/**
 * Iteration decision contract.
 *
 * A turn is a loop of iterations; each iteration is one provider stream plus the
 * tool calls it produced. `finish` from a provider only ends the *stream*.
 * Whether the *turn* may end is decided here, by one pure function with one
 * owner, so the rule cannot be re-implemented in the runner, the CLI and the
 * projection at three different strengths.
 */

export const ITERATION_CONTINUE_REASONS = [
  "tool_results_pending",
  "provider_follow_up",
  /**
   * A message from the person driving the run is waiting (WP D 波 §5.2). It
   * outranks `complete` for the same reason unsettled tools do: a turn with an
   * unread user message is not finished, it is merely idle.
   */
  "user_input_pending",
  "goal_active",
] as const;

export type IterationContinueReason = (typeof ITERATION_CONTINUE_REASONS)[number];

export const ITERATION_WAIT_REASONS = ["approval", "user_input"] as const;

export type IterationWaitReason = (typeof ITERATION_WAIT_REASONS)[number];

export const ITERATION_FAILURE_REASONS = [
  "provider_error",
  "tool_failed",
  "tool_unknown",
  "permission_denied",
  "permission_failed",
  "iterations_exhausted",
  "output_tokens_exhausted",
  "budget_usd_exhausted",
  "context_limit",
  "cancelled",
] as const;

export type IterationFailureReason = (typeof ITERATION_FAILURE_REASONS)[number];

export type IterationDecision =
  | { readonly kind: "complete" }
  | { readonly kind: "continue"; readonly reason: IterationContinueReason }
  | { readonly kind: "wait"; readonly reason: IterationWaitReason }
  | { readonly kind: "fail"; readonly reason: IterationFailureReason };

/**
 * Everything the end-of-iteration gate is allowed to look at.
 * Every field is a fact the loop already owns; nothing here is inferred.
 */
export type IterationObservation = {
  /** Provider delivered a terminal reason for this stream. */
  readonly providerFinished: boolean;
  /** Tool input blocks started but never closed (truncated stream). */
  readonly unsettledToolInputCount: number;
  /** Tool calls issued but not yet settled (running or awaiting permission). */
  readonly unsettledToolCallCount: number;
  /** Contract requires another provider request even without new tool results. */
  readonly requiresFollowUp: boolean;
  /** A hard budget verdict was reached before this decision. */
  readonly budgetVerdict: BudgetVerdict;
  /**
   * User messages still waiting to be promoted (WP D 波 §5.2). Absent means
   * none, so every existing caller keeps its behaviour without a second thought.
   */
  readonly pendingUserInputCount?: number;
};

export type IterationBudget = {
  /** Explicit request ceiling; absent leaves ordinary execution uncapped. */
  readonly maxIterations?: number;
  /** Opt-in: reserve the last provider request for a report, not more actions. */
  readonly finalRequest?: "report_only";
  readonly maxOutputTokens?: number;
  /** Context ceiling; reaching it terminates explicitly, never silently trims. */
  readonly contextTokenLimit?: number;
  /**
   * The dollar ceiling (WP09.3/L07). Present, the accumulated priced usage is
   * compared against it after every iteration; reaching it terminates the turn
   * with an explicit `budget_usd_exhausted`, never a silently truncated run.
   */
  readonly maxCostUsd?: number;
};

/**
 * What pricing a run's usage needs (WP09.3/L07). Stated by the caller — the
 * surface resolves it from configuration, the loop only multiplies. Prices
 * are per million tokens, matching how providers quote them.
 */
export type UsagePricing = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
};

export type BudgetVerdict =
  | { readonly kind: "within_budget" }
  | { readonly kind: "iterations_exhausted"; readonly used: number; readonly limit: number }
  | { readonly kind: "output_tokens_exhausted"; readonly used: number; readonly limit: number }
  | { readonly kind: "budget_usd_exhausted"; readonly used: number; readonly limit: number }
  | { readonly kind: "context_limit"; readonly used: number; readonly limit: number };

export type IterationUsage = {
  readonly iterations: number;
  readonly outputTokens: number;
  readonly promptTokens: number;
  /** The run's accumulated priced cost in USD, when the caller prices usage. */
  readonly costUsd?: number;
};

/** The dollar cost of one stream's usage under the run's pricing. */
export function streamCostUsd(
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  pricing: UsagePricing | undefined,
): number {
  if (pricing === undefined) {
    return 0;
  }
  return (
    (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000
  );
}

export function evaluateBudget(usage: IterationUsage, budget: IterationBudget): BudgetVerdict {
  const outputLimit = budget.maxOutputTokens;
  if (outputLimit !== undefined && usage.outputTokens >= outputLimit) {
    return { kind: "output_tokens_exhausted", used: usage.outputTokens, limit: outputLimit };
  }

  const costLimit = budget.maxCostUsd;
  if (costLimit !== undefined && (usage.costUsd ?? 0) >= costLimit) {
    return { kind: "budget_usd_exhausted", used: usage.costUsd ?? 0, limit: costLimit };
  }

  const contextLimit = budget.contextTokenLimit;
  if (contextLimit !== undefined && usage.promptTokens >= contextLimit) {
    return { kind: "context_limit", used: usage.promptTokens, limit: contextLimit };
  }

  const iterationLimit = budget.maxIterations;
  if (iterationLimit !== undefined && usage.iterations >= iterationLimit) {
    return { kind: "iterations_exhausted", used: usage.iterations, limit: iterationLimit };
  }

  return { kind: "within_budget" };
}

/**
 * The single termination gate. All six conditions must hold to complete;
 * wait and failure outrank completion so a turn can never end while something
 * is still owed.
 */
export function decideIterationEnd(observation: IterationObservation): IterationDecision {
  if (observation.budgetVerdict.kind !== "within_budget") {
    return { kind: "fail", reason: observation.budgetVerdict.kind };
  }

  if (observation.unsettledToolInputCount > 0) {
    // A stream that ended mid-tool-input is a transport failure, not a finish.
    return { kind: "fail", reason: "provider_error" };
  }

  if (observation.unsettledToolCallCount > 0) {
    return { kind: "continue", reason: "tool_results_pending" };
  }

  // 反方 #21: a queued user message keeps the turn open. Placed after the tool
  // checks because a tool result is owed to the model first, and before
  // `complete` because an unread message means the turn is idle, not done.
  if ((observation.pendingUserInputCount ?? 0) > 0) {
    return { kind: "continue", reason: "user_input_pending" };
  }

  if (observation.requiresFollowUp) {
    return { kind: "continue", reason: "provider_follow_up" };
  }

  if (observation.providerFinished) {
    return { kind: "complete" };
  }

  // Stream ended without a terminal reason and nothing else explains it.
  return { kind: "fail", reason: "provider_error" };
}

export function isIterationDecision(value: unknown): value is IterationDecision {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  switch (record.kind) {
    case "complete":
      return true;
    case "continue":
      return (ITERATION_CONTINUE_REASONS as readonly unknown[]).includes(record.reason);
    case "wait":
      return (ITERATION_WAIT_REASONS as readonly unknown[]).includes(record.reason);
    case "fail":
      return (ITERATION_FAILURE_REASONS as readonly unknown[]).includes(record.reason);
    default:
      return false;
  }
}
