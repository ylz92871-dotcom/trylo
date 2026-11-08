import assert from "node:assert/strict";
import test from "node:test";
import type { CentralCompletedOperation, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { centralOperationSignature, emptyCentralRuntimeState, type CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import { CENTRAL_RESOURCE_WAIT_PREFIX } from "../../learning/central/runtime/resource-waits.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { authenticatedCentralOutputCapacityIncrease, centralOutputCapacityIncreaseOriginalOperation,
  readCentralOutputCapacityIncrease } from "./runtime-output-capacity-increase.js";
import { isCentralOutputCapacityIncreaseOperation } from "./runtime-output-capacity-increase-identity.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";

const scope = "workspace:capacity-increase", budgetId = "budget:capacity-increase";

function fixture(archived = false) {
  const operation = { kind: "think" as const, operationId: "thought:original", purpose: "Assess the original unresolved problem",
    expectedChange: "Choose a useful next inquiry", sourceRefs: ["source:original"], maxOutputTokens: 8192 };
  const completed: CentralCompletedOperation = { intentId: "intent:original", operation, outcome: "failed",
    resultRefs: [], publicResult: "Complete length response has no semantic action" };
  const reservationId = centralDeliberationReservation({ scope, budgetId, operationId: operation.operationId });
  const body = { interpretation: "explicit_failure_requires_actual_condition_change_not_extra_paid_deliberation",
    operationId: operation.operationId, configurationRef: "configuration:original", limits: { tokens: 200000, calls: 4, steps: 4 },
    available: { tokens: 191728, calls: 3, steps: 3 }, failureClass: "resources", reason: "central_deliberation_incomplete", reservationId,
    outputDiagnostics: { schemaVersion: 1, rejectionReason: "central_deliberation_incomplete", cause: "length_termination",
      argumentChars: 0, toolStarts: 0, invalidTools: 0, requestedOutputTokens: 8192, finishReason: "length",
      usageObserved: true, streamExhausted: true, usageTailComplete: true } };
  const text = canonicalJson(body), waitRef = `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operation.operationId)}:${contentHashOf(text)}`;
  const block: CentralRuntimeMaterial = { ref: waitRef, kind: "feedback", text, sourceRefs: [operation.operationId] };
  const root = { budgetId, scope, openedSequence: 1, authorizationRef: "authorization:original" };
  const budget: CentralBudgetProjection = { budget: { ...root, schemaVersion: 1, unit: "total_model_tokens", limits: body.limits,
    mode: "exclusive_new_funding", openedAt: "2026-11-06T00:00:00.000Z", accounting: [{ reservationId,
      owner: { kind: "central_deliberation", ownerId: budgetId }, maxTokens: 9000, state: "settled",
      reservedAt: "2026-11-06T00:00:00.000Z", reservedSequence: 2,
      usage: { kind: "reported", totalTokens: 8272, inputTokens: 80, outputTokens: 8192 } }] },
    occupied: { tokens: 8272, calls: 1, steps: 1 }, available: body.available, status: "available", historicalExternalGrantIds: [] };
  const intent: CentralLearningIntentDraft = { intentId: completed.intentId, subject: { plane: "agent", domain: "collaboration", issueId: "issue:original" },
    goal: "Resolve the original problem", rationale: "Original feedback remains relevant", conditions: [], knowledge: [], residual: ["A question remains"],
    commitment: { purpose: "Investigate", assumptions: [], reconsiderWhen: [] }, revisionReason: "Retain the original purpose",
    sourceRefs: ["source:original"], continuation: { kind: "waiting", wait: { kind: "resources", reason: "capacity", sourceRefs: [waitRef] } } };
  const state = { ...emptyCentralRuntimeState(scope), intents: [intent], completed: archived ? [] : [completed], materials: archived ? [] : [block] };
  const history: CentralRuntimeHistory = { operations: [{ operationId: operation.operationId, intentId: intent.intentId,
    signature: centralOperationSignature(operation), factRef: "fact:operation" }],
    materials: [{ ref: waitRef, factRef: "fact:wait", sequence: 3 }], endedIntents: [], consumedSourceRefs: [] };
  const configuration = { configurationRef: "configuration:current", rootRef: root,
    generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 } };
  const reads: string[] = [];
  const input = { state, history, budget, configuration, waitRef,

    async lookupMaterial(ref: string, factRef: string) {
      reads.push(`material:${ref}:${factRef}`);
      return ref === block.ref && factRef === "fact:wait" ? block : undefined;
    },

    async lookupCompleted(operationId: string, factRef: string) { reads.push(`completed:${operationId}:${factRef}`);
      return operationId === operation.operationId && factRef === "fact:operation" ? completed : undefined; } };

  return { input, completed, body, block, reads };
}

test("a certified complete length purchases one larger requested cap without changing the original result or root", async () => {
  const f = fixture(), before = canonicalJson(f.input);
  const selected = await readCentralOutputCapacityIncrease(f.input);
  assert.ok(selected);
  assert.equal(isCentralUnreadNavigationMaterial(selected.materials[0]!), true, "lineage is control feedback, never business citation evidence");
  assert.equal(selected.operation.maxOutputTokens, 16384);
  assert.ok(isCentralOutputCapacityIncreaseOperation(scope, selected.operation));
  assert.equal(selected.operation.purpose, f.completed.operation.purpose);
  assert.equal(selected.operation.expectedChange, f.completed.operation.expectedChange);
  assert.equal(canonicalJson(f.input), before);
  const state = { ...f.input.state, materials: [...f.input.state.materials, ...selected.materials] };

  assert.equal(authenticatedCentralOutputCapacityIncrease(state, f.input.history, f.input.budget, f.input.configuration, selected.operation), true);
  const packing = { scope, budgetId, operation: selected.operation }, checkpointCopy = selected.materials.map(row => ({ ...row }));

  assert.deepEqual(centralOutputCapacityIncreaseOriginalOperation(packing, checkpointCopy), f.completed.operation,
    "only the actual verified operation retains its packing identity across a canonical checkpoint material copy");
  assert.equal(centralOutputCapacityIncreaseOriginalOperation({ ...packing, operation: { ...selected.operation } }, checkpointCopy), undefined);
  assert.equal(centralOutputCapacityIncreaseOriginalOperation(packing, checkpointCopy.map(row => ({ ...row, text: row.text + " " }))), undefined);
  assert.equal(authenticatedCentralOutputCapacityIncrease(state, f.input.history, f.input.budget,
    { ...f.input.configuration, generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 32768 } }, selected.operation), false);
  // The real driver freezes its failed operation and resource block in one fact.
  const sharedHistory = { ...f.input.history, operations: f.input.history.operations.map(row => ({ ...row, factRef: "fact:wait" })) };
  const shared = await readCentralOutputCapacityIncrease({ ...f.input, history: sharedHistory,
    lookupCompleted: async (_operationId, factRef) => factRef === "fact:wait" ? f.completed : undefined });

  assert.ok(shared, "one failed checkpoint must not make the lineage's provenance references invalid duplicates");
  assert.equal(shared.materials[0]!.sourceRefs.length, new Set(shared.materials[0]!.sourceRefs).size);
  assert.equal(authenticatedCentralOutputCapacityIncrease({ ...f.input.state, materials: [...f.input.state.materials, ...shared.materials] },
    sharedHistory, f.input.budget, f.input.configuration, shared.operation), true);
});

test("archived original facts survive compaction and the original slot stays spent after any issued recovery", async () => {
  const f = fixture(true), selected = await readCentralOutputCapacityIncrease(f.input);
  assert.ok(selected);
  assert.ok(f.reads.some(row => row.startsWith("completed:")));
  assert.ok(f.reads.some(row => row.startsWith("material:")));
  const history = { ...f.input.history, operations: [...f.input.history.operations, { operationId: selected.operation.operationId,
    intentId: f.completed.intentId, signature: centralOperationSignature(selected.operation), factRef: "fact:recovery-issued" }] };

  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, history }), undefined);
  const state = { ...f.input.state, materials: [...selected.materials] };

  assert.equal(authenticatedCentralOutputCapacityIncrease(state, history, f.input.budget, f.input.configuration, selected.operation), false);
});

test("unknown, network, partial and missing-usage originals do not authorize a capacity increase", async () => {
  const f = fixture();

  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, state: { ...f.input.state,
    completed: [{ ...f.completed, outcome: "unknown" }] }, lookupCompleted: async () => ({ ...f.completed, outcome: "unknown" }) }), undefined);

  for (const diagnostics of [{ ...f.body.outputDiagnostics, finishReason: "stop" },
    { ...f.body.outputDiagnostics, argumentChars: 1 }, { ...f.body.outputDiagnostics, usageTailComplete: false }]) {
    const text = canonicalJson({ ...f.body, outputDiagnostics: diagnostics }), block = { ...f.block, text,
      ref: `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(f.completed.operation.operationId)}:${contentHashOf(text)}` };
    assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, waitRef: block.ref,
      state: { ...f.input.state, materials: [block] }, history: { ...f.input.history, materials: [{ ref: block.ref, factRef: "fact:wait" }] } }), undefined);
  }

  const budget = { ...f.input.budget, budget: { ...f.input.budget.budget, accounting: f.input.budget.budget.accounting!.map(row => {
    assert.ok(row.state === "settled", "the fixture requires the original settled reservation");
    return { ...row, usage: { kind: "reported" as const, totalTokens: 8272 } };
  }) } };

  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, budget }), undefined);
  const mismatched = { ...f.input.budget, budget: { ...f.input.budget.budget, accounting: f.input.budget.budget.accounting!.map(row => {
    assert.ok(row.state === "settled", "the fixture requires the original settled reservation");
    return { ...row, usage: { kind: "reported" as const, totalTokens: 8273, inputTokens: 80, outputTokens: 8193 } };
  }) } };

  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, budget: mismatched }), undefined);
});

test("later withdrawal, another blocking wait and a forged numeric lineage never reopen the old purpose", async () => {
  const f = fixture();
  const ended = { ...f.input.state.intents[0]!, continuation: { kind: "ended" as const, goalState: "withdrawn" as const, reason: "PA withdrew" } };

  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, state: { ...f.input.state, intents: [ended] } }), undefined);
  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, waitRef: "central-resource-wait:another" }), undefined);
  const selected = await readCentralOutputCapacityIncrease(f.input);
  assert.ok(selected);
  const copied = { ...selected.materials[0]!, sourceRefs: [...selected.materials[0]!.sourceRefs] };

  assert.equal(authenticatedCentralOutputCapacityIncrease({ ...f.input.state, materials: [f.block, copied] },
    f.input.history, f.input.budget, f.input.configuration, selected.operation), false,
  "a perfectly copied audit record cannot mint fresh source authentication");
  const replacedBody = { ...f.block, text: canonicalJson({ ...f.body, outputDiagnostics: { ...f.body.outputDiagnostics, requestedOutputTokens: 4096 } }) };

  assert.equal(await readCentralOutputCapacityIncrease({ ...f.input, state: { ...f.input.state, materials: [replacedBody] } }), undefined,
    "a caller cannot replace a deterministic base-address body while its original fact remains unchanged");
  const forged = { ...selected.materials[0]!, text: canonicalJson({ originalRequestedOutputTokens: 8192, requestedOutputTokens: 16384 }) };

  assert.equal(authenticatedCentralOutputCapacityIncrease({ ...f.input.state, materials: [f.block, forged] },
    f.input.history, f.input.budget, f.input.configuration, selected.operation), false);
});
