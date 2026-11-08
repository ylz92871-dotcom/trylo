import { centralLearningRemaining, centralLearningSpent, type CoordinateLearningCommand } from "./coordination-contract.js";
import { coordinationForJob, commitCoordination, closeCentralGrant } from "./coordination-state.js";
import type { BoardState } from "./state.js";
import { contentHashOf } from "./hash.js";
import { fail, replay } from "./result.js";
import { centralBudgetProjection } from "./central-budget-state.js";

type Command<K extends CoordinateLearningCommand["action"]["kind"]> = CoordinateLearningCommand & {
  readonly action: Extract<CoordinateLearningCommand["action"], { kind: K }> };

export function applyCentralReserve(state: BoardState, command: Command<"reserve">) {
  const a = command.action, grant = state.centralLearningGrants?.find(g => g.grantId === a.grantId);
  if (grant === undefined) return fail(state, "learning_grant_not_found", a.grantId);

  const current = coordinationForJob(state, grant.jobId);
  if (current?.issue.decision.kind !== "focused_learning") return fail(state, "learning_issue_not_focused", grant.issueId);

  if (grant.status !== "open") return fail(state, "learning_grant_closed", a.grantId);

  if (current.job.state !== "running" || grant.claim?.claimId !== a.claimId || Date.parse(grant.claim.expiresAt) <= Date.parse(command.issuedAt)) {
    return fail(state, "learning_claim_conflict", "claim_is_not_current");
  }

  const previous = grant.reservations.find(r => r.reservationId === a.reservationId);
  if (previous !== undefined) return previous.claimId === a.claimId && previous.maxTokens === a.maxTokens
    ? replay(state) : fail(state, "learning_grant_conflict", a.reservationId);

  const remaining = centralLearningRemaining(grant);

  if (grant.budgetId !== undefined) {
    const budget = centralBudgetProjection(state, grant.budgetId);
    if (budget === undefined) return fail(state, "learning_budget_binding", grant.budgetId);
    if (budget.status === "held") return fail(state, "learning_budget_held", budget.holdReason ?? "budget_held");
  }

  if (remaining.calls < 1 || remaining.steps < 1 || a.maxTokens > remaining.tokens) return fail(state, "learning_grant_exhausted", grant.grantId);

  return commitCoordination(state, command, { grant: { ...grant, steps: grant.steps + 1,
    reservations: [...grant.reservations, { reservationId: a.reservationId, claimId: a.claimId, maxTokens: a.maxTokens, state: "reserved" }] } });
}

export function applyCentralSettlement(state: BoardState, command: Command<"settle">) {
  const a = command.action, previous = state.centralLearningGrants?.find(g => g.grantId === a.grantId);
  if (previous === undefined) return fail(state, "learning_grant_not_found", a.grantId);

  const reservation = previous.reservations.find(r => r.reservationId === a.reservationId);
  if (reservation === undefined) return fail(state, "learning_grant_conflict", "reservation_not_found");

  if (reservation.state === "settled") {
    if (contentHashOf(reservation.usage) === contentHashOf(a.usage)) return replay(state);
    // A late measured receipt may replace a conservative unknown charge, never a known receipt.
    if (reservation.usage?.kind !== "unknown" || a.usage.kind !== "reported") return fail(state, "learning_grant_conflict", "usage_already_known");
  }

  const grant = { ...previous, reservations: previous.reservations.map(r => r.reservationId === a.reservationId
    ? { ...r, state: "settled" as const, usage: a.usage } : r) };
  const overrun = centralLearningSpent(grant).tokens > grant.allowance.maxTokens
    || a.usage.kind === "reported" && a.usage.totalTokens > reservation.maxTokens;
  if (!overrun) return commitCoordination(state, command, { grant });

  const job = state.jobs.find(j => j.jobId === grant.jobId);

  return commitCoordination(state, command, { grant: closeCentralGrant(grant, "model_token_overrun"),
    ...(job !== undefined && ["queued", "running", "waiting_evidence", "waiting_approval"].includes(job.state)
      ? { job: { ...job, state: "failed" as const } } : {}) });
}
