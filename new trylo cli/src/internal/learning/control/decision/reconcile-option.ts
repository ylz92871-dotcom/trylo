import { identity, sequence } from "../../../validation/json-shape.js";
import { applyCentralBudget } from "../central-budget-apply.js";
import { isCentralLearningBudget } from "../central-budget-parse.js";
import { centralBudgetProjection, grantResources, resourcesFit } from "../central-budget-state.js";
import type { CentralBudgetProjection } from "../central-budget-contract.js";
import { centralLearningSpent } from "../coordination-contract.js";
import { isCentralLearningGrant } from "../coordination-parse.js";
import { contentHashOf } from "../hash.js";
import type { BoardState } from "../state.js";

export type CentralReconcileSimulation = { readonly status: "ready"; readonly board: BoardState;
  readonly projection: CentralBudgetProjection } | { readonly status: "unavailable"; readonly reason: string };

/** Conditional original-reducer simulation only. Its returned Board is not a
 * confirmed release, spendable balance, authorization or persistence result. */
export function simulateCentralReconcile(board: BoardState, budgetId: string, grantId: string): CentralReconcileSimulation {
  if (board === null || typeof board !== "object" || !sequence(board.sequence) || !identity(budgetId) || !identity(grantId)
    || !Array.isArray(board.jobs) || !Array.isArray(board.centralLearningBudgets ?? []) || !Array.isArray(board.centralLearningGrants ?? [])) {
    return { status: "unavailable", reason: "reconcile_option_input" };
  }

  const root = board.centralLearningBudgets?.find(item => item.budgetId === budgetId);
  const grant = board.centralLearningGrants?.find(item => item.grantId === grantId);
  if (!isCentralLearningBudget(root) || !isCentralLearningGrant(grant) || grant.budgetId !== budgetId
    || grant.scope !== root.scope || grant.status !== "open") return { status: "unavailable", reason: "reconcile_option_managed_grant_required" };

  const job = board.jobs.find(item => item.jobId === grant.jobId);
  if (job === undefined || job.scope !== grant.scope || job.coordination?.grantId !== grantId
    || job.coordination.issueId !== grant.issueId) return { status: "unavailable", reason: "reconcile_option_job_binding" };

  if (grant.claim !== undefined || job.state === "running" || grant.reservations.some(item => item.state === "reserved")) {
    return { status: "unavailable", reason: "reconcile_option_worker_boundary_required" };
  }

  const limits = centralLearningSpent(grant), cap = grantResources(grant);
  if (!resourcesFit(limits, cap)) return { status: "unavailable", reason: "reconcile_option_not_reduction" };

  if (limits.tokens === cap.tokens && limits.calls === cap.calls && limits.steps === cap.steps) {
    return { status: "unavailable", reason: "reconcile_option_no_unused_commitment" };
  }

  const planRef = `central-reconcile-option:${contentHashOf([board.sequence, budgetId, grantId, limits])}`;
  const result = applyCentralBudget(board, { type: "coordinate_learning", commandId: planRef, issuedAt: root.openedAt,
    action: { kind: "rebudget", grantId, expectedSequence: board.sequence, limits, authorizationRef: root.authorizationRef, planRef } });
  if (!result.ok) return { status: "unavailable", reason: result.reason };

  const projection = centralBudgetProjection(result.state, budgetId);

  return projection === undefined ? { status: "unavailable", reason: "reconcile_option_projection" }
    : { status: "ready", board: result.state, projection };
}
