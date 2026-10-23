import type { SubagentBudgetSnapshot } from "./types.js";

/** Continuation spends remaining allowance; parking never grants a fresh budget. */
export function accumulatedBudget(current: SubagentBudgetSnapshot | undefined,
  prior: SubagentBudgetSnapshot | undefined): SubagentBudgetSnapshot | undefined {
  if (current === undefined || prior === undefined) return current;
  return { ...current, tokenLimit: prior.tokensUsed + current.tokenLimit,
    tokensUsed: prior.tokensUsed + current.tokensUsed,
    timeoutMs: prior.timeoutMs - prior.timeRemainingMs + current.timeoutMs };
}
