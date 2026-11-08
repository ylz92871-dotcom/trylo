import type { BoardState } from "../../../../control/state.js";
import type { CentralLearningGrant } from "../../../../control/coordination-contract.js";
import { workflowImprovementGrantSuffix } from "./improvement-identities.js";

/** One immutable input retains its request history across host run/budget prefixes. */
export function workflowSourceGrants(board: BoardState, centralScope: string, inputVersionId: string): readonly CentralLearningGrant[] {
  return board.centralLearningGrants?.filter(item => item.domain === "workflow" && item.scope === centralScope
    && item.grantId.endsWith(workflowImprovementGrantSuffix(inputVersionId))) ?? [];
}

/** Automatic central preparation never reopens a terminated source or repeats a sent/unknown request. */
export function dispatchedWorkflowSourceGrant(history: readonly CentralLearningGrant[]): CentralLearningGrant | undefined {
  return history.find(item => item.reservations.length > 0 || item.status === "closed");
}
