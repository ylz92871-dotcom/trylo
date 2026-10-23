/** Additive budget facts shared by subagent results and the CLI stream. */
export type SubagentBudgetSnapshot = {
  readonly tokenLimit: number;
  readonly tokensUsed: number;
  readonly tokensRemaining: number;
  readonly timeoutMs: number;
  readonly timeRemainingMs: number;
  readonly timeoutMode: "wall" | "active";
};

export function isSubagentBudgetSnapshot(value: unknown): value is SubagentBudgetSnapshot {
  if (value === null || typeof value !== "object") return false;
  const budget = value as Record<string, unknown>;
  return ["tokenLimit", "tokensUsed", "tokensRemaining", "timeoutMs", "timeRemainingMs"]
    .every(key => { const count = budget[key]; return typeof count === "number" && Number.isFinite(count) && count >= 0; })
    && (budget.timeoutMode === "wall" || budget.timeoutMode === "active");
}
