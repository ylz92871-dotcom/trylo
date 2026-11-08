import type { BoardState } from "../../learning/control/state.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { readCentralPursuitObservations } from "../../integration/learning-allocation/pursuit-observations.js";

/** One canonical snapshot, no writer/provider/permission/worker construction. */
export function centralLearningReadModel(board: BoardState, scope: string) {
  const root = board.centralLearningBudgets?.find(row => row.scope === scope);
  const projection = root === undefined ? undefined : centralBudgetProjection(board, root.budgetId);
  const observations = readCentralPursuitObservations(board, scope);
  if (observations.status !== "ready") return { schemaVersion: 1, domain: "central", status: "failed", reason: observations.reason } as const;

  return { schemaVersion: 1 as const, domain: "central" as const, scope,
    budget: projection === undefined ? null : { budgetId: projection.budget.budgetId, limits: projection.budget.limits,
      occupied: projection.occupied, available: projection.available, status: projection.status,
      ...(projection.holdReason === undefined ? {} : { holdReason: projection.holdReason }) },
    issues: (board.learningIssues ?? []).filter(issue => issue.scope === scope).map(issue => {
      const job = board.jobs.find(row => row.jobId === issue.jobId);
      return { issueId: issue.issueId, owner: learningIssueOwner(issue), revision: issue.revision,
        decision: issue.decision.kind, ...(job === undefined ? {} : { jobState: job.state }),
        ...(issue.grantId === undefined ? {} : { grantId: issue.grantId }) };
    }),
    stages: observations.observations.map(row => ({ unitId: row.unitId, stageRef: row.stageRef,
      criterion: row.objective.criterion, outcome: row.outcome, sourceRef: row.sourceRef, sequence: row.sequence })),
  };
}
