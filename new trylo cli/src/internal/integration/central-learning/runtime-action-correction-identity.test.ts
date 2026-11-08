import assert from "node:assert/strict";
import test from "node:test";
import type { CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { centralActionCorrectionOperationId, isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";

const scope = "workspace:action-correction-identity", budgetId = "budget:original-root", originalOperationId = "operation:original-rejected";
const feedback = `central-action-correction-feedback:${contentHashOf("original-rejection-binding")}`, capability = "capability:reference-selection-v2";

function correction(): CentralLearningOperation {
  return { kind: "think", operationId: centralActionCorrectionOperationId(scope, budgetId, originalOperationId),
    purpose: "Correct the original rejected reference selection", expectedChange: "Return one supported revised decision",
    sourceRefs: [originalOperationId, budgetId, feedback, capability] };
}

test("correction identity binds the actual scope, root and original operation while accepting extra original context refs", () => {
  const operation = correction();

  assert.equal(isCentralActionCorrectionOperation(scope, operation), true);
  assert.equal(isCentralActionCorrectionOperation(scope, { ...operation, sourceRefs: [...operation.sourceRefs, "source:original-context"] }), true);
  assert.equal(centralActionCorrectionOperationId(scope, budgetId, originalOperationId), operation.operationId);
  assert.equal(isCentralActionCorrectionOperation("workspace:another", operation), false);

  for (const sourceRefs of [["operation:another-original", budgetId, feedback, capability],
    [originalOperationId, "budget:another-root", feedback, capability], [originalOperationId, feedback, budgetId, capability],
    [originalOperationId, budgetId, "feedback:an-unowned-rejection", capability], [originalOperationId, budgetId, feedback],
    [originalOperationId, budgetId, feedback, ""], [originalOperationId, budgetId, feedback, "invalid\ncapability"],
    [originalOperationId, budgetId, feedback, "x".repeat(257)]]) {
    assert.equal(isCentralActionCorrectionOperation(scope, { ...operation, sourceRefs }), false);
  }
});

test("a corrective operation is never another correction's original and non-think operations do not acquire this recovery fence", () => {
  const operation = correction(), nested = { ...operation,
    operationId: centralActionCorrectionOperationId(scope, budgetId, operation.operationId),
    sourceRefs: [operation.operationId, budgetId, feedback, capability] };

  assert.equal(isCentralActionCorrectionOperation(scope, nested), false);
  assert.equal(isCentralActionCorrectionOperation(scope, { ...operation, kind: "read", refs: ["source:original-context"], maximumChars: 1024 }), false);
  const wrongIdentity = { ...operation, operationId: centralActionCorrectionOperationId(scope, "budget:another-root", originalOperationId) };

  assert.equal(isCentralActionCorrectionOperation(scope, wrongIdentity), false);
});
