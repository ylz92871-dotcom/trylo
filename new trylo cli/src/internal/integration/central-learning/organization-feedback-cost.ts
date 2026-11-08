import type { BoardState } from "../../learning/control/state.js";
import type { OrganizationFeedback, OrganizationProjection, OrganizationStored, OrganizationDecision } from "../../learning/central/organization/index.js";
import { contentHashOf } from "../../learning/control/hash.js";

export function organizationDecisionReferences(view: OrganizationProjection, decision: OrganizationDecision): readonly string[] {
  return [...new Set([...decision.sourceRefs, ...decision.issueRefs, ...decision.stageRefs,
    ...view.feedback.filter(row => row.value.decisionRef === decision.decisionRef && row.value.result.kind === "progress")
      .flatMap(row => [...row.value.sourceRefs, ...(row.value.result.kind === "progress" ? row.value.result.resultRefs : [])])])];
}

/** Uses actual original accounting. Unknown/reserved caps are never reported spend.
 * A shared grant without a unique decision binding remains attribution-unknown. */
export function projectOrganizationCosts(board: BoardState, view: OrganizationProjection,
  decision: OrganizationStored<OrganizationDecision>, references?: ReadonlyMap<string, readonly string[]>): readonly OrganizationFeedback[] {
  const original = (value: OrganizationDecision) => references?.get(value.decisionRef) ?? organizationDecisionReferences(view, value);
  const refs = new Set(original(decision.value)), feedback: OrganizationFeedback[] = [];

  for (const budget of board.centralLearningBudgets ?? []) {
    if (budget.scope !== view.scope || !refs.has(budget.budgetId)) continue;
    for (const reservation of budget.accounting ?? []) {
      if (!refs.has(reservation.reservationId)) continue;

      const usage = reservation.state === "settled" && reservation.usage.kind === "reported"
        ? { kind: "reported" as const, tokens: reservation.usage.totalTokens, calls: 1, steps: 1 }
        : { kind: "unknown" as const, reason: reservation.state === "settled" && reservation.usage.kind === "unknown"
          ? reservation.usage.reason : "original_reservation_unsettled" };

      feedback.push({ kind: "feedback", decisionRef: decision.value.decisionRef,
        unitRef: `original-root-cost:${contentHashOf([budget.budgetId, reservation.reservationId])}`, supersedes: null,
        sourceRefs: [budget.budgetId, reservation.reservationId], result: { kind: "cost", usage } });
    }
  }

  for (const grant of board.centralLearningGrants ?? []) {
    if (grant.scope !== view.scope || grant.budgetId === undefined || !refs.has(grant.budgetId)
      || !refs.has(grant.grantId) && !refs.has(grant.jobId)) continue;

    const owners = view.decisions.filter(row => original(row.value).includes(grant.grantId) || original(row.value).includes(grant.jobId));
    const reported = grant.reservations.filter(row => row.usage?.kind === "reported");
    const known = owners.length === 1 && grant.reservations.length > 0 && reported.length === grant.reservations.length;
    const usage = known ? { kind: "reported" as const, tokens: reported.reduce((sum, row) => sum + (row.usage?.kind === "reported" ? row.usage.totalTokens : 0), 0),
      calls: grant.reservations.length, steps: grant.steps }
      : { kind: "unknown" as const, reason: owners.length !== 1 ? "shared_grant_cost_not_identified_for_this_decision" : "original_grant_usage_unresolved" };

    feedback.push({ kind: "feedback", decisionRef: decision.value.decisionRef, unitRef: `original-grant-cost:${contentHashOf(grant.grantId)}`,
      supersedes: null, sourceRefs: [grant.grantId, grant.jobId], result: { kind: "cost", usage } });
  }

  return feedback;
}
