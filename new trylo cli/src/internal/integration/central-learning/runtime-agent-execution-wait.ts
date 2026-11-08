import type { CentralLearningWait } from "../../learning/central/runtime/contracts.js";
import type { BoardState } from "../../learning/control/state.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { WorkflowResearchDispatch } from "./workflow.js";

/** Only typed owner handbacks and actual pending dependencies become waits.
 * Unknown receipts and prose are never interpreted as provider resource errors. */
export function runtimeAgentWait(board: BoardState, grantId: string, dispatch: FocusedLearningDispatch | undefined,
  progress: WorkflowResearchDispatch["workflowResearch"]): CentralLearningWait | undefined {
  if (progress?.handback.kind === "budget_boundary") return { kind: "resources", sourceRefs: progress.sourceRefs, reason: progress.handback.reason };

  if (progress?.handback.kind === "await_external_evidence") return { kind: "facts", sourceRefs: progress.sourceRefs, reason: progress.handback.reason };

  if (dispatch?.ok && dispatch.status === "waiting_dependency") {
    const pending = (board.learningDependencies ?? []).filter(row => row.grantId === grantId
      && (row.state.kind === "waiting" || row.state.kind === "unavailable"));
    if (pending.length > 0) return { kind: "facts", reason: "original_learning_dependencies_pending",
      sourceRefs: [...new Set(pending.flatMap(row => [row.dependencyId, row.correlationRef, ...(row.requestId === undefined ? [] : [row.requestId])]))] };
  }

  return undefined;
}
