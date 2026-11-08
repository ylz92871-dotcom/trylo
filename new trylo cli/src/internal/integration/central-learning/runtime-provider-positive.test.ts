import assert from "node:assert/strict";
import test from "node:test";
import type { CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { providerPositiveNoteRef, providerWaitObservationHash, type ProviderWaitObservation,
  type VerifiedProviderPositiveNote } from "../../learning/central/runtime/provider-positive.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { ProviderErrorClass } from "../../ports/provider.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { latestProviderWait, providerPositiveAdmissionMaterial, providerWaitForPositiveObservation, readProviderPositiveAdmissionMaterial,
  selectProviderPositiveAdmission } from "./runtime-provider-positive.js";
import { semanticRecoveryBlock, semanticResourceCondition } from "./runtime-recovery.js";

const scope = "workspace:provider-positive", budgetId = "budget:provider-positive";
const connectionRef = `central-learning-provider-connection:${contentHashOf("original resolved connection")}`;
const at = "2026-11-06T00:00:00.000Z", now = Date.parse(at);
const budget: CentralBudgetProjection = { budget: { schemaVersion: 1, budgetId, scope, unit: "total_model_tokens",
  limits: { tokens: 10000, calls: 4, steps: 4 }, authorizationRef: "host:original", mode: "exclusive_new_funding", openedAt: at, openedSequence: 1 },
  occupied: { tokens: 100, calls: 1, steps: 1 }, available: { tokens: 9900, calls: 3, steps: 3 }, status: "available", historicalExternalGrantIds: [] };
const selected: CentralLearningOperation = { kind: "think", operationId: "central-agenda:real-new",
  purpose: "Review a real new business result", expectedChange: "Choose the original useful next step", sourceRefs: ["business:real-new"] };

function fixture(cause: ProviderErrorClass = "network", until = false) {
  const original: CentralLearningOperation = { kind: "think", operationId: "thought:original-provider",
    purpose: "Review the original work", expectedChange: "Choose useful research", sourceRefs: ["business:old"] };
  const empty = emptyCentralRuntimeState(scope);
  const oldWait = semanticRecoveryBlock(original.operationId, new CentralDeliberationError("central_deliberation_provider_rate_limit",
    "unknown", "reservation:old", { class: "rate_limit", retryable: true, recovery: { kind: "after", delayMs: 1000, source: "retry_after" } }),
  budget, "configuration:original", { state: empty, operation: original, now, recoveryDelayMs: 1000, providerConnectionRef: connectionRef });
  const firstState: CentralLearningRuntimeState = { ...empty, materials: [oldWait],
    completed: [{ intentId: "central:agenda", operation: original, outcome: "unknown", resultRefs: [], publicResult: "Original response unknown" }] };
  const first: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: firstState,
    reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [oldWait.ref] }), sequence: 9 };
  const retry: CentralLearningOperation = { ...original, operationId: `central-provider-recovery:${contentHashOf(oldWait.ref)}`,
    sourceRefs: [oldWait.ref, ...original.sourceRefs] };
  const newWait = semanticRecoveryBlock(retry.operationId, new CentralDeliberationError(`central_deliberation_provider_${cause}`,
    "unknown", "reservation:retry", { class: cause, retryable: false }), budget, "configuration:original",
  { state: firstState, operation: retry, now: now + 1000, recoveryDelayMs: 1000, providerConnectionRef: connectionRef });
  const second: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: { ...firstState, materials: [oldWait, newWait],
    completed: [...firstState.completed, { intentId: "central:agenda", operation: retry, outcome: "failed", resultRefs: [], publicResult: "Provider recovery exhausted" }] },
  reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [newWait.ref] }), sequence: 10 };
  const facts = until ? [first] : [first, second], last = facts.at(-1)!;
  const cursor = readCentralRuntimeRecords(facts, scope, last.sequence);
  const history = { ...cursor.history, materials: cursor.history.materials.map(row => ({ ...row,
    sequence: facts.find(fact => fact.id === row.factRef)!.sequence })) };
  const material = until ? oldWait : newWait;

  return { facts, cursor, history, oldWait, material,
    input: { state: cursor.state, history, scope, budgetId, connectionRef, boardSequence: last.sequence, now: now + 2000,
      wait: { material, factRef: last.id, sequence: last.sequence }, selectedOperation: selected,
      freshBusinessRefs: ["business:real-new"], notes: [] as readonly VerifiedProviderPositiveNote[] } };
}

function note(f: { readonly material: CentralRuntimeMaterial; readonly input: {
  readonly boardSequence: number; readonly wait: { readonly factRef: string } } }, attempt = 1,
boardSequence = f.input.boardSequence): VerifiedProviderPositiveNote {
  const capture: ProviderWaitObservation = { schemaVersion: 1, scope, budgetId, connectionRef, sessionId: "session:normal",
    turnId: `turn:${attempt}`, model: "model:original", wait: { ref: f.material.ref, factRef: f.input.wait.factRef, boardSequence } };
  const body = { capture, returned: { schemaVersion: 1 as const, captureHash: providerWaitObservationHash(capture),
    attemptId: `attempt:${attempt}`, model: capture.model, finishReason: "stop" as const, reportedTotalTokens: 3 },
  request: { sequence: attempt * 2 + 1, at }, finish: { sequence: attempt * 2 + 2, at } };
  return { ...body, ref: providerPositiveNoteRef(body) };
}

test("a verified normal return admits only the selected new computation and its mandatory control is bound to the original operation", () => {
  const f = fixture(), receipt = note(f), input = { ...f.input, notes: [receipt] }, before = canonicalJson(input);
  const admitted = selectProviderPositiveAdmission(input);
  assert.ok(admitted);
  assert.equal(canonicalJson(input), before);
  assert.equal(admitted.admission.operationId, selected.operationId);
  assert.deepEqual(admitted.material.sourceRefs, [f.material.ref, receipt.ref]);
  assert.deepEqual(providerPositiveAdmissionMaterial(admitted.admission), admitted.material);
  assert.deepEqual(readProviderPositiveAdmissionMaterial(admitted.material, selected, scope), admitted.admission);
  assert.equal(readProviderPositiveAdmissionMaterial(admitted.material, { ...selected, purpose: "A different operation" }, scope), undefined);
  assert.equal(readProviderPositiveAdmissionMaterial(admitted.material, selected, "workspace:foreign"), undefined);
  assert.deepEqual(providerWaitForPositiveObservation(f.input.state, f.history, connectionRef, budgetId, f.input.boardSequence),
    { scope, budgetId, connectionRef, wait: { ref: f.material.ref, factRef: f.input.wait.factRef, boardSequence: f.input.boardSequence } });
  const reordered = { ...f.input.state, materials: [...f.input.state.materials].reverse() };

  assert.equal(latestProviderWait(reordered, f.history)?.ref, f.material.ref, "original sequence wins over carried material order");
  const retired = { ...f.history, retiredProviderWaitRefs: [f.material.ref] };

  assert.equal(providerWaitForPositiveObservation(reordered, retired, connectionRef, budgetId, f.input.boardSequence), undefined,
    "retiring the newest wait never resurrects its older predecessor");
  assert.equal(selectProviderPositiveAdmission({ ...input, history: retired }), undefined);
});

test("issued consumption fences old concurrent notes while forbidden causes and unbound receipt metadata never reopen a provider gate", () => {
  const f = fixture(), receipt = note(f), input = { ...f.input, notes: [receipt] };
  const admitted = selectProviderPositiveAdmission(input);
  assert.ok(admitted);
  const issued: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: f.cursor.stateRef,
    state: { ...f.input.state, completed: [...f.input.state.completed,
      { intentId: "central:agenda", operation: selected, outcome: "unknown", resultRefs: [], publicResult: "Issued with original admission" }] },
    reason: "central_deliberation_issued", sourceRefs: selected.sourceRefs, providerRecoveryUpdate: { admission: admitted.admission } }), sequence: 11 };
  const cold = readCentralRuntimeRecords([...f.facts, issued], scope, 12);
  const nextOperation = { ...selected, operationId: "central-agenda:next-real-new", sourceRefs: ["business:next-real-new"] };
  const nextInput = { ...input, state: cold.state, history: cold.history, boardSequence: 12, selectedOperation: nextOperation,
    freshBusinessRefs: nextOperation.sourceRefs };

  assert.equal(selectProviderPositiveAdmission({ ...nextInput, notes: [receipt] }), undefined);
  assert.equal(selectProviderPositiveAdmission({ ...nextInput, notes: [note(f, 2, 10)] }), undefined,
    "a second call captured before the first issued claim cannot buy another computation");
  assert.ok(selectProviderPositiveAdmission({ ...nextInput, notes: [note(f, 3, 12)] }), "a later natural capture has a distinct causal proof");

  for (const cause of ["auth", "quota", "invalid_request", "protocol", "unknown"] as const) {
    const denied = fixture(cause);
    assert.equal(selectProviderPositiveAdmission({ ...denied.input, notes: [note(denied)] }), undefined);
  }

  const limited = fixture("rate_limit", true);

  assert.equal(selectProviderPositiveAdmission({ ...limited.input, now: now + 999, notes: [note(limited)] }), undefined);
  assert.equal(selectProviderPositiveAdmission({ ...input, selectedOperation: null }), undefined);
  assert.equal(selectProviderPositiveAdmission({ ...input, freshBusinessRefs: [] }), undefined);
  assert.equal(selectProviderPositiveAdmission({ ...input, selectedOperation: { ...selected, operationId: "central-action-correction:old" } }), undefined);
  assert.equal(selectProviderPositiveAdmission({ ...input, wait: { ...input.wait, factRef: "fact:another" } }), undefined);
  assert.equal(selectProviderPositiveAdmission({ ...input, notes: [{ ...receipt, ref: "normal-provider-success:forged" }] }), undefined);
  const invalidTime = { ...receipt, request: { ...receipt.request, at: "not-an-ISO-instant" } };
  const { ref: _ref, ...body } = invalidTime;

  assert.equal(selectProviderPositiveAdmission({ ...input, notes: [{ ...invalidTime, ref: providerPositiveNoteRef(body) }] }), undefined);
});

test("a newly admitted transport refusal retains its real not-before without buying an automatic retry", () => {
  const f = fixture();
  const block = semanticRecoveryBlock(selected.operationId, new CentralDeliberationError("central_deliberation_provider_server", "unknown",
    "reservation:new", { class: "server", retryable: true, recovery: { kind: "after", delayMs: 1000, source: "retry_after" } }),
  budget, "configuration:original", { state: f.input.state, operation: selected, now: now + 2000, recoveryDelayMs: 1000,
    providerConnectionRef: connectionRef, positiveAdmission: true });

  assert.deepEqual(JSON.parse(block.text).providerRecovery, { kind: "exhausted", cause: "server", notBefore: now + 3000 });
  const state = { ...f.input.state, materials: [...f.input.state.materials, block], completed: [...f.input.state.completed,
    { intentId: "central:agenda", operation: selected, outcome: "failed" as const, resultRefs: [], publicResult: "New transport failure" }] };
  const fact: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: f.cursor.stateRef, state,
    reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [block.ref] }), sequence: 11 };
  const cold = readCentralRuntimeRecords([...f.facts, fact], scope, 11);
  const next = { ...selected, operationId: "central-agenda:later-business", sourceRefs: ["business:later"] };
  const later = { ...f, material: block, input: { ...f.input, state: cold.state, history: cold.history, boardSequence: 11,
    wait: { material: block, factRef: fact.id, sequence: 11 }, selectedOperation: next, freshBusinessRefs: next.sourceRefs } };
  const receipt = note(later);

  assert.equal(selectProviderPositiveAdmission({ ...later.input, now: now + 2999, notes: [receipt] }), undefined);
  assert.ok(selectProviderPositiveAdmission({ ...later.input, now: now + 3000, notes: [receipt] }));
  const condition = semanticResourceCondition(cold.state, budget, "configuration:original", now + 3000, cold.history, connectionRef);

  assert.equal(condition.blocked, true);
  assert.equal(condition.wakeAt, undefined);
  assert.equal(condition.recovery, undefined);
});
