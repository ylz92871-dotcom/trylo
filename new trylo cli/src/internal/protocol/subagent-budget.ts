/** Additive budget facts shared by subagent results and the CLI stream. */
export type SubagentBudgetSnapshot = {
  readonly tokenLimit?: number | undefined;
  readonly tokensUsed: number;
  readonly tokensRemaining?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly timeRemainingMs?: number | undefined;
  readonly timeoutMode: "wall" | "active";
};

export function isSubagentBudgetSnapshot(value: unknown): value is SubagentBudgetSnapshot {
  if (value === null || typeof value !== "object") return false;

  const budget = value as Record<string, unknown>;
  const count = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0;

  return count(budget.tokensUsed)
    && ["tokenLimit", "tokensRemaining", "timeoutMs", "timeRemainingMs"]
      .every(key => budget[key] === undefined || count(budget[key]))
    && (budget.tokenLimit === undefined) === (budget.tokensRemaining === undefined)
    && (budget.timeoutMs === undefined) === (budget.timeRemainingMs === undefined)
    && (budget.timeoutMode === "wall" || budget.timeoutMode === "active");
}
