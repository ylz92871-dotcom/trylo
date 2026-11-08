import type { CoordinateLearningCommand } from "./coordination-contract.js";
import { isCoordinationAction } from "./coordination-parse.js";
import { applyIssueDecision, applyIssueFunding, applyIssueReport } from "./apply-coordination-issue.js";
import { applyCentralClaim, applyCentralRenewal, applyCentralFinish, applyDependencyObservation } from "./apply-coordination-work.js";
import { applyCentralReserve, applyCentralSettlement } from "./apply-coordination-funding.js";
import type { BoardState } from "./state.js";
import { fail } from "./result.js";
import { applyCentralBudget } from "./central-budget-apply.js";
import { applyIncompleteCollaborationContinuation } from "./apply-collaboration-continuation.js";

export function applyLearningCoordination(state: BoardState, command: CoordinateLearningCommand) {
  if (!isCoordinationAction(command.action) || !Number.isFinite(Date.parse(command.issuedAt))) {
    return fail(state, "invalid_learning_coordination", "invalid_coordination_command");
  }

  const action = command.action;

  switch (action.kind) {
    case "resume_incomplete": return applyIncompleteCollaborationContinuation(state, { ...command, action });
    case "open_budget":
    case "reserve_budget_usage":
    case "settle_budget_usage":
    case "set_budget_limit":
    case "close_investment":
    case "rebudget": return applyCentralBudget(state, { ...command, action });
    case "report": return applyIssueReport(state, { ...command, action });
    case "decide": return applyIssueDecision(state, { ...command, action });
    case "fund": return applyIssueFunding(state, { ...command, action });
    case "claim": return applyCentralClaim(state, { ...command, action });
    case "renew": return applyCentralRenewal(state, { ...command, action });
    case "finish": return applyCentralFinish(state, { ...command, action });
    case "dependency": return applyDependencyObservation(state, { ...command, action });
    case "reserve": return applyCentralReserve(state, { ...command, action });
    case "settle": return applyCentralSettlement(state, { ...command, action });
  }
}
