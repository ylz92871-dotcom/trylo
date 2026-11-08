import type { SubagentBudgetSnapshot } from "./types.js";

/** Continuation spends remaining allowance; parking never grants a fresh budget. */
export function accumulatedBudget(current: SubagentBudgetSnapshot | undefined,
  prior: SubagentBudgetSnapshot | undefined): SubagentBudgetSnapshot | undefined {
  if (current === undefined || prior === undefined) return current;
  return { ...current, tokensUsed: prior.tokensUsed + current.tokensUsed,
    ...(current.tokenLimit === undefined ? {} : { tokenLimit: prior.tokensUsed + current.tokenLimit }),
    ...(current.timeoutMs === undefined ? {} : { timeoutMs:
      (prior.timeoutMs === undefined || prior.timeRemainingMs === undefined ? 0 : prior.timeoutMs - prior.timeRemainingMs) + current.timeoutMs }) };
}
