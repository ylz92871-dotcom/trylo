import type { CentralLearningGrant, CoordinateLearningCommand } from "./coordination-contract.js";
import { centralLearningSpent } from "./coordination-contract.js";
import type { CentralBudgetAction } from "./central-budget-contract.js";
import { MAX_CENTRAL_LEARNING_BUDGETS } from "./central-budget-contract.js";
import { centralBudgetProjection, grantResources, resourcesFit } from "./central-budget-state.js";
import { closeCentralGrant, commitCoordination } from "./coordination-state.js";
import type { BoardState } from "./state.js";
import type { ReasonCode } from "./reasons.js";
import { fail } from "./result.js";
import { applyCentralAccounting } from "./central-accounting-apply.js";

type Fund = Extract<CoordinateLearningCommand["action"], { kind: "fund" }>;

/** Admission only. Existing independently funded grants keep their original authorization. */
export function centralBudgetFundFailure(state: BoardState, scope: string, action: Fund): ReasonCode | undefined {
  const active = state.centralLearningBudgets?.find(item => item.scope === scope);

  if (action.budgetId === undefined) return active === undefined ? undefined : "learning_budget_required";

  if (active?.budgetId !== action.budgetId) return "learning_budget_binding";

  if (action.expectedSequence !== state.sequence) return "learning_budget_stale";

  const projection = centralBudgetProjection(state, action.budgetId);
  if (projection === undefined) return "invalid_learning_budget";

  if (projection.status === "held") return "learning_budget_held";

  return action.allowance.maxTokens > projection.available.tokens || action.allowance.maxCalls > projection.available.calls
    || action.allowance.maxSteps > projection.available.steps ? "learning_budget_exhausted" : undefined;
}

export function applyCentralBudget(state: BoardState, command: CoordinateLearningCommand & { readonly action: CentralBudgetAction }) {
  const action = command.action;
  if (action.kind === "reserve_budget_usage" || action.kind === "settle_budget_usage" || action.kind === "set_budget_limit") {
    return applyCentralAccounting(state, { ...command, action });
  }

  if (action.expectedSequence !== state.sequence) return fail(state, "learning_budget_stale", "board_sequence_changed");

  if (action.kind === "open_budget") {
    const budgets = state.centralLearningBudgets ?? [];
    if (budgets.length >= MAX_CENTRAL_LEARNING_BUDGETS) return fail(state, "learning_budget_capacity", action.budget.budgetId);

    if (budgets.some(item => item.budgetId === action.budget.budgetId || item.scope === action.budget.scope)) {
      return fail(state, "learning_budget_conflict", "one_explicit_authorization_period_per_scope");
    }

    return commitCoordination(state, command, { budget: { ...action.budget, mode: "exclusive_new_funding",
      openedAt: command.issuedAt, openedSequence: state.sequence + 1 } });
  }

  const grant = state.centralLearningGrants?.find(item => item.grantId === action.grantId);
  if (grant === undefined) return fail(state, "learning_grant_not_found", action.grantId);

  if (grant.budgetId === undefined) return fail(state, "learning_budget_binding", "independent_grants_are_not_rebound");

  const projection = centralBudgetProjection(state, grant.budgetId);
  if (projection === undefined || projection.budget.scope !== grant.scope) return fail(state, "learning_budget_binding", action.grantId);

  if (grant.status !== "open") return fail(state, "learning_grant_closed", action.grantId);

  if (action.kind === "close_investment") return closeInvestment(state, { ...command, action }, grant);

  if (grant.claim !== undefined || grant.reservations.some(item => item.state === "reserved")) {
    return fail(state, "learning_grant_unsettled", "rebudget_requires_a_confirmed_worker_boundary");
  }

  if (action.maxPromptChars !== undefined && action.maxPromptChars < grant.allowance.maxPromptChars) {
    return fail(state, "learning_budget_binding", "an_operation_can_narrow_its_prompt_without_shrinking_original_history");
  }

  if (!resourcesFit(centralLearningSpent(grant), action.limits)) return fail(state, "learning_budget_exhausted", "cannot_refund_charged_usage");

  const before = grantResources(grant), pureReduction = resourcesFit(action.limits, before);
  if (projection.status === "held" && !pureReduction) return fail(state, "learning_budget_held", projection.holdReason ?? "budget_held");

  const occupied = { tokens: projection.occupied.tokens - before.tokens + action.limits.tokens,
    calls: projection.occupied.calls - before.calls + action.limits.calls, steps: projection.occupied.steps - before.steps + action.limits.steps };

  // Late measured overrun may need several reductions to relieve. Never reject a safe reduction merely because a deficit remains.
  if (!pureReduction && !resourcesFit(occupied, projection.budget.limits)) return fail(state, "learning_budget_exhausted", grant.budgetId);

  return commitCoordination(state, command, { grant: { ...grant, authorizationRef: action.authorizationRef, planRef: action.planRef,
    allowance: { ...grant.allowance, maxTokens: action.limits.tokens, maxCalls: action.limits.calls, maxSteps: action.limits.steps,
      ...(action.maxPromptChars === undefined ? {} : { maxPromptChars: action.maxPromptChars }) } } });
}

function closeInvestment(state: BoardState, command: CoordinateLearningCommand & {
  readonly action: Extract<CentralBudgetAction, { kind: "close_investment" }> }, grant: CentralLearningGrant) {
  const action = command.action, job = state.jobs.find(item => item.jobId === grant.jobId);
  if (job === undefined) return fail(state, "job_not_found", grant.jobId);
  // This revokes future spending, not a remote execution receipt. Existing reservations retain their full conservative charge.
  const closed = { ...closeCentralGrant(grant, action.reason), authorizationRef: action.authorizationRef, planRef: action.planRef };
  const active = ["queued", "running", "waiting_evidence", "waiting_approval"].includes(job.state);
  return commitCoordination(state, command, { grant: closed, ...(active ? { job: { ...job, state: "cancelled" as const } } : {}) });
}
