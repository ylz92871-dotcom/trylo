import type { CentralAccountingReservation } from "./central-accounting-contract.js";
import type { CentralLearningBudget, CentralLearningResources } from "./central-budget-contract.js";
import { sameCentralLearningResources } from "./central-learning-resources.js";

/** A pending or unknown request occupies its entire reservation. Calls/steps never refund. */
export function centralAccountingSpent(reservations: readonly CentralAccountingReservation[]): CentralLearningResources {
  return { tokens: reservations.reduce((sum, item) => sum + (item.state === "settled" && item.usage.kind === "reported"
    ? item.usage.totalTokens : item.maxTokens), 0), calls: reservations.length, steps: reservations.length };
}

export function centralAccountingOverrun(budget: CentralLearningBudget): boolean {
  return (budget.accounting ?? []).some(item => item.state === "settled" && item.usage.kind === "reported" && item.usage.totalTokens > item.maxTokens);
}

/** Shape guards run first. The reservation/change positions must belong to this root's lifetime. */
export function validCentralAccountingPrefix(budget: CentralLearningBudget, boardSequence: number): boolean {
  const reservations = budget.accounting ?? [], changes = budget.limitChanges ?? [];
  const positions = [...reservations.map(item => item.reservedSequence), ...changes.map(item => item.changedSequence)];
  if (new Set(positions).size !== positions.length || positions.some(value => value <= budget.openedSequence || value > boardSequence)) return false;

  if (reservations.some((item, index) => index > 0 && item.reservedSequence <= reservations[index - 1]!.reservedSequence)
    || changes.some((item, index) => index > 0 && item.changedSequence <= changes[index - 1]!.changedSequence)) return false;

  const last = changes.at(-1);

  return last === undefined || sameCentralLearningResources(last.limits, budget.limits);
}
