import { centralLearningSpent, type CentralLearningGrant } from "./coordination-contract.js";
import type { BoardState } from "./state.js";
import { MAX_CENTRAL_LEARNING_BUDGETS, type CentralBudgetProjection, type CentralLearningResources } from "./central-budget-contract.js";
import { isCentralLearningBudget } from "./central-budget-parse.js";
import { CENTRAL_LEARNING_RESOURCE_KEYS as centralResourceKeys, centralLearningResourcesFit as resourcesFit } from "./central-learning-resources.js";
import { centralAccountingOverrun, centralAccountingSpent, validCentralAccountingPrefix } from "./central-accounting-state.js";

export { CENTRAL_LEARNING_RESOURCE_KEYS as centralResourceKeys, centralLearningResourcesFit as resourcesFit } from "./central-learning-resources.js";

export const grantResources = (grant: CentralLearningGrant): CentralLearningResources => ({ tokens: grant.allowance.maxTokens,
  calls: grant.allowance.maxCalls, steps: grant.allowance.maxSteps });

function modelCapViolated(grant: CentralLearningGrant): boolean {
  return grant.closedReason === "model_token_overrun" || !resourcesFit(centralLearningSpent(grant), grantResources(grant))
    || grant.reservations.some(item => item.usage?.kind === "reported" && item.usage.totalTokens > item.maxTokens);
}

/** Derived from canonical grant commitments and peer request receipts in the same root. */
export function centralBudgetProjection(state: BoardState, budgetId: string): CentralBudgetProjection | undefined {
  const budget = state.centralLearningBudgets?.find(item => item.budgetId === budgetId);
  if (budget === undefined) return undefined;

  const linked = (state.centralLearningGrants ?? []).filter(item => item.budgetId === budgetId);
  const occupied = { ...centralAccountingSpent(budget.accounting ?? []) };

  for (const grant of linked) {
    const spent = centralLearningSpent(grant), commitment = grantResources(grant);
    // An open grant commits its allowance and any already reported excess.
    // Closed grants retain all actual costs and full unknown reservations.
    const cost = grant.status === "open" ? {
      tokens: Math.max(commitment.tokens, spent.tokens), calls: Math.max(commitment.calls, spent.calls),
      steps: Math.max(commitment.steps, spent.steps),
    } : spent;

    for (const key of centralResourceKeys) {
      occupied[key] += cost[key];
      if (!Number.isSafeInteger(occupied[key])) return undefined;
    }
  }

  const available = { tokens: budget.limits.tokens - occupied.tokens, calls: budget.limits.calls - occupied.calls,
    steps: budget.limits.steps - occupied.steps };
  const rootExceeded = !resourcesFit(occupied, budget.limits);
  const recordedOverrun = linked.some(modelCapViolated) || centralAccountingOverrun(budget);
  // A closed child has no further spending authority. Its overrun remains in
  // occupied and in the original ledger; it must not disable unrelated future
  // learning when the user's parent ceiling still covers that full exposure.
  const unresolvedOverrun = linked.some(grant => grant.status === "open" && modelCapViolated(grant));
  const holdReason = unresolvedOverrun || rootExceeded && recordedOverrun ? "model_cap_violated"
    : rootExceeded ? "budget_overcommitted" : undefined;

  return { budget, occupied, available, status: holdReason !== undefined ? "held"
    : centralResourceKeys.some(key => available[key] === 0) ? "exhausted" : "available",
    ...(holdReason === undefined ? {} : { holdReason }),
    historicalExternalGrantIds: (state.centralLearningGrants ?? []).filter(item => item.scope === budget.scope && item.budgetId === undefined).map(item => item.grantId) };
}

/** Grant guards run first; this validates budget ownership and admits honest, evidenced overruns. */
export function validCentralBudgetState(state: BoardState): boolean {
  const budgets = state.centralLearningBudgets === undefined ? [] : state.centralLearningBudgets;
  if (!Array.isArray(budgets) || budgets.length > MAX_CENTRAL_LEARNING_BUDGETS || !budgets.every(isCentralLearningBudget)
    || budgets.some(item => item.openedSequence > state.sequence || !validCentralAccountingPrefix(item, state.sequence))
    || new Set(budgets.map(item => item.budgetId)).size !== budgets.length || new Set(budgets.map(item => item.scope)).size !== budgets.length) return false;

  for (const grant of state.centralLearningGrants ?? []) {
    if (grant.budgetId !== undefined && !budgets.some(item => item.budgetId === grant.budgetId && item.scope === grant.scope)) return false;
  }

  return budgets.every(item => {
    const projected = centralBudgetProjection(state, item.budgetId);
    return projected !== undefined && projected.holdReason !== "budget_overcommitted";
  });
}
