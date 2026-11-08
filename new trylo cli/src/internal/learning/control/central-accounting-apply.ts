import type { CentralAccountingAction } from "./central-accounting-contract.js";
import { MAX_CENTRAL_ACCOUNTING_RESERVATIONS, MAX_CENTRAL_BUDGET_LIMIT_CHANGES } from "./central-accounting-contract.js";
import { sameCentralAccountingOwner } from "./central-accounting-parse.js";
import { centralBudgetProjection, resourcesFit } from "./central-budget-state.js";
import { sameCentralLearningResources } from "./central-learning-resources.js";
import { commitCoordination } from "./coordination-state.js";
import type { CoordinateLearningCommand } from "./coordination-contract.js";
import { contentHashOf } from "./hash.js";
import { fail, replay } from "./result.js";
import type { BoardState } from "./state.js";

type Command<K extends CentralAccountingAction["kind"]> = CoordinateLearningCommand & {
  readonly action: Extract<CentralAccountingAction, { readonly kind: K }> };

export function applyCentralAccounting(state: BoardState, command: CoordinateLearningCommand & { readonly action: CentralAccountingAction }) {
  const action = command.action;
  switch (action.kind) {
    case "reserve_budget_usage": return reserve(state, { ...command, action });
    case "settle_budget_usage": return settle(state, { ...command, action });
    case "set_budget_limit": return setLimit(state, { ...command, action });
  }
}

function reserve(state: BoardState, command: Command<"reserve_budget_usage">) {
  const action = command.action, projection = centralBudgetProjection(state, action.budgetId);
  if (projection === undefined || projection.budget.scope !== action.scope) return fail(state, "learning_budget_binding", action.budgetId);

  const budget = projection.budget, accounting = budget.accounting ?? [];
  const previous = accounting.find(item => item.reservationId === action.reservationId);

  // Durable request identity precedes CAS. A replay is a receipt, never permission to dispatch again.
  if (previous !== undefined) return sameCentralAccountingOwner(previous.owner, action.owner) && previous.maxTokens === action.maxTokens
    ? replay(state) : fail(state, "learning_budget_conflict", "reservation_identity_conflict");

  if (action.expectedSequence !== state.sequence) return fail(state, "learning_budget_stale", "board_sequence_changed");

  if (accounting.length >= MAX_CENTRAL_ACCOUNTING_RESERVATIONS) return fail(state, "learning_budget_capacity", "accounting_receipt_capacity");

  if (projection.status === "held") return fail(state, "learning_budget_held", projection.holdReason ?? "budget_held");

  if (!resourcesFit({ tokens: action.maxTokens, calls: 1, steps: 1 }, projection.available)) return fail(state, "learning_budget_exhausted", action.budgetId);

  return commitCoordination(state, command, { budget: { ...budget, accounting: [...accounting, {
    reservationId: action.reservationId, owner: action.owner, maxTokens: action.maxTokens, state: "reserved",
    reservedAt: command.issuedAt, reservedSequence: state.sequence + 1,
  }] } });
}

function settle(state: BoardState, command: Command<"settle_budget_usage">) {
  const action = command.action, budget = state.centralLearningBudgets?.find(item => item.budgetId === action.budgetId);
  if (budget === undefined || budget.scope !== action.scope) return fail(state, "learning_budget_binding", action.budgetId);

  const previous = budget.accounting?.find(item => item.reservationId === action.reservationId);
  if (previous === undefined || !sameCentralAccountingOwner(previous.owner, action.owner)) return fail(state, "learning_budget_binding", "reservation_owner_mismatch");

  if (previous.state === "settled") {
    if (contentHashOf(previous.usage) === contentHashOf(action.usage)) return replay(state);
    if (previous.usage.kind !== "unknown" || action.usage.kind !== "reported") return fail(state, "learning_budget_conflict", "usage_already_known");
  }

  // Even an overrun is a bill. Store it honestly; the root projection then holds all new spending.
  return commitCoordination(state, command, { budget: { ...budget, accounting: budget.accounting!.map(item =>
    item.reservationId === action.reservationId ? { ...item, state: "settled" as const, usage: action.usage } : item) } });
}

function setLimit(state: BoardState, command: Command<"set_budget_limit">) {
  const action = command.action, projection = centralBudgetProjection(state, action.budgetId);
  if (projection === undefined) return fail(state, "learning_budget_binding", action.budgetId);

  const budget = projection.budget, changes = budget.limitChanges ?? [];
  const previous = changes.find(item => item.changeId === action.changeId);
  if (previous !== undefined) return previous.authorizationRef === action.authorizationRef && sameCentralLearningResources(previous.limits, action.limits)
    ? replay(state) : fail(state, "learning_budget_conflict", "authorization_change_identity_conflict");

  if (action.expectedSequence !== state.sequence) return fail(state, "learning_budget_stale", "board_sequence_changed");

  if (changes.length >= MAX_CENTRAL_BUDGET_LIMIT_CHANGES) return fail(state, "learning_budget_capacity", "authorization_change_capacity");

  if (!resourcesFit(projection.occupied, action.limits)) return fail(state, "learning_budget_exhausted", "cannot_refund_spent_or_committed_resources");

  return commitCoordination(state, command, { budget: { ...budget, limits: action.limits, limitChanges: [...changes, {
    changeId: action.changeId, limits: action.limits, authorizationRef: action.authorizationRef,
    changedAt: command.issuedAt, changedSequence: state.sequence + 1,
  }] } });
}
