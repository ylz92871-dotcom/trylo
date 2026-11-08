import type { CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import { identity } from "../../validation/json-shape.js";

export const CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX = "central-output-capacity-increase:";
export const CENTRAL_OUTPUT_CAPACITY_INCREASE_FEEDBACK_PREFIX = "central-output-capacity-increase-feedback:";

/** One slot belongs to the original operation, independently of later policy versions. */
export function centralOutputCapacityIncreaseOperationId(scope: string, budgetId: string, originalOperationId: string): string {
  return `${CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX}${contentHashOf([scope, budgetId, originalOperationId])}`;
}

/** Recognition fences recursive recovery; it is never evidence or funding authority. */
export function isCentralOutputCapacityIncreaseOperation(scope: string, operation: CentralLearningOperation): boolean {
  if (operation.kind !== "think" || !coordinationScopeValid(scope) || operation.sourceRefs.length < 3) return false;

  const [originalOperationId, budgetId, feedback] = operation.sourceRefs;

  return identity(originalOperationId) && !originalOperationId.startsWith(CENTRAL_OUTPUT_CAPACITY_INCREASE_PREFIX)
    && identity(budgetId) && typeof feedback === "string"
    && feedback.startsWith(CENTRAL_OUTPUT_CAPACITY_INCREASE_FEEDBACK_PREFIX)
    && /^[a-f0-9]{64}$/.test(feedback.slice(CENTRAL_OUTPUT_CAPACITY_INCREASE_FEEDBACK_PREFIX.length))
    && operation.operationId === centralOutputCapacityIncreaseOperationId(scope, budgetId, originalOperationId);
}
