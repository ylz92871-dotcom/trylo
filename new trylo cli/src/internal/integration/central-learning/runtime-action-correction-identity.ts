import type { CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import { identity } from "../../validation/json-shape.js";

const PREFIX = "central-action-correction:";
const feedbackRef = /^central-action-correction-feedback:[a-f0-9]{64}$/;

export function centralActionCorrectionOperationId(scope: string, budgetId: string, originalOperationId: string): string {
  return `${PREFIX}${contentHashOf([scope, budgetId, originalOperationId])}`;
}

/** Recognition only fences automatic recovery. It supplies no evidence of a
 * rejection, funding, capability or authority to issue the corrective thought. */
export function isCentralActionCorrectionOperation(scope: string, operation: CentralLearningOperation): boolean {
  if (operation.kind !== "think" || operation.sourceRefs.length < 4 || !coordinationScopeValid(scope)) return false;
  const [originalOperationId, budgetId, feedback, capability] = operation.sourceRefs;
  return identity(originalOperationId) && !originalOperationId.startsWith(PREFIX) && identity(budgetId)
    && typeof feedback === "string" && feedbackRef.test(feedback) && identity(capability)
    && operation.operationId === centralActionCorrectionOperationId(scope, budgetId, originalOperationId);
}
