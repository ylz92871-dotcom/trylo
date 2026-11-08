import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import type { CentralDeliberationOutput, CentralDeliberationPort, CentralDeliberationRequest, CentralLearningConfiguration,
  CentralLearningDriveInput, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import type { CentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";
import { blocksAutomaticSemanticRecovery, semanticAttemptMaterial, semanticRecovery, semanticRecoveryAt,
  semanticRecoveryBlock, semanticResourceCondition } from "./runtime-recovery.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";

const scope = "workspace:local-timeout-recovery", configurationRef = "configuration:local-timeout";
const issuedAt = Date.parse("2026-11-05T12:00:00.000Z"), delay = 50;
const operation: CentralLearningOperation = { kind: "think", operationId: "thought:original-local-timeout",
  purpose: "Interpret the original source", expectedChange: "Choose a useful next inquiry", sourceRefs: ["source:original"] };
const limits = { tokens: 10000, calls: 4, steps: 4 };
const budget: CentralBudgetProjection = { budget: { schemaVersion: 1, budgetId: "budget:local-timeout", scope,
  unit: "total_model_tokens", limits, authorizationRef: "host:local-timeout", mode: "exclusive_new_funding",
  openedAt: new Date(issuedAt).toISOString(), openedSequence: 1 }, occupied: { tokens: 40, calls: 1, steps: 1 },
  available: { tokens: 9960, calls: 3, steps: 3 }, status: "available", historicalExternalGrantIds: [] };
const capacityDiagnostics: CentralDeliberationOutputDiagnostics = { schemaVersion: 1,
  rejectionReason: "central_deliberation_incomplete", cause: "length_termination", argumentChars: 0, toolStarts: 0,
  invalidTools: 0, requestedOutputTokens: 256, finishReason: "length", usageObserved: true, streamExhausted: true, usageTailComplete: true };

function unknownState() {
  const state = emptyCentralRuntimeState(scope);
  return { ...state, completed: [{ intentId: "central:agenda", operation, outcome: "unknown" as const,
    resultRefs: [], publicResult: "The original dispatched response remains unconfirmed." }],
  materials: [semanticAttemptMaterial(state, operation, issuedAt, delay)] };
}

test("a client timeout or cancellation with unknown delivery blocks timed paid recovery without changing the original unknown operation", () => {
  for (const reason of ["central_deliberation_timeout", "central_deliberation_cancelled"] as const) {
    const state = unknownState(), before = canonicalJson(state), error = new CentralDeliberationError(reason, "unknown", "reservation:original");

    assert.equal(blocksAutomaticSemanticRecovery(error), true);
    const blocked: CentralLearningRuntimeState = { ...state, materials: [...state.materials, semanticRecoveryBlock(operation.operationId, error, budget, configurationRef)] };

    assert.equal(semanticRecoveryAt(blocked, issuedAt), undefined, "no timer may schedule another paid computation for the same unconfirmed input");
    assert.equal(semanticRecovery(blocked, issuedAt + delay + 100000), null);
    assert.equal(blocked.completed[0]?.outcome, "unknown");
    assert.deepEqual(blocked.completed[0]?.operation, operation);
    assert.equal(canonicalJson(state), before);
    assert.deepEqual(budget.occupied, { tokens: 40, calls: 1, steps: 1 });
  }
});

test("the narrow local rule does not reinterpret not-sent or untyped transport errors", () => {
  assert.equal(blocksAutomaticSemanticRecovery(new CentralDeliberationError("central_deliberation_timeout", "not_sent")), false);
  assert.equal(blocksAutomaticSemanticRecovery(new CentralDeliberationError("central_deliberation_timeout", "returned")), false);
  assert.equal(blocksAutomaticSemanticRecovery(Object.assign(new Error("central_deliberation_timeout"), { failureClass: "transport" })), false,
    "an error message alone is not the typed local delivery boundary");
  assert.equal(blocksAutomaticSemanticRecovery(new CentralDeliberationError("central_deliberation_cancelled", "not_sent")), true,
    "the pre-existing cancelled failure-class contract remains unchanged");
});

test("provider timeout recovery and typed provider not-before retain their independent contracts", () => {
  const state = unknownState(), remote = new CentralDeliberationError("central_deliberation_provider_timeout", "unknown", "reservation:remote",
    { class: "timeout", retryable: true });

  assert.equal(blocksAutomaticSemanticRecovery(remote), false);
  assert.equal(semanticRecoveryAt(state, issuedAt), issuedAt + delay);
  assert.ok(semanticRecovery(state, issuedAt + delay)?.operation.operationId.startsWith("central-recover-thought:"));
  const limited = new CentralDeliberationError("central_deliberation_provider_rate_limit", "unknown", "reservation:limited",
    { class: "rate_limit", retryable: true, recovery: { kind: "after", delayMs: 750, source: "retry_after" } });
  const marker = semanticRecoveryBlock(operation.operationId, limited, budget, configurationRef,
    { state, operation, now: issuedAt, recoveryDelayMs: delay });
  const waiting = { ...state, materials: [...state.materials, marker] };
  const before = semanticResourceCondition(waiting, budget, configurationRef, issuedAt + 749);

  assert.equal(before.blocked, true);
  assert.equal(before.wakeAt, issuedAt + 750);
  const due = semanticResourceCondition(waiting, budget, configurationRef, issuedAt + 750);

  assert.equal(due.blocked, false);
  assert.ok(due.recovery?.operation.operationId.startsWith("central-provider-recovery:"));
});

async function driverFixture(t: TestContext, failure: "timeout" | "capacity" = "timeout") {
  const parent = testScratchPath("central-local-timeout-recovery");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  let clock = issuedAt, changed = false, receiptAvailable = false;
  const enabled = () => true, now = () => new Date(clock).toISOString(), store = createCentralRuntimeStore({ boardRoot, enabled });
  const requests: CentralDeliberationRequest[] = [], returned: CentralDeliberationOutput = { schemaVersion: 1, intents: [],
    publicExplanation: "Wait for an actual external condition.", sourceRefs: ["source:original"] };
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef, generationRef: "generation:original", authorizationRef: "host:local-timeout",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: limits.tokens, maxCalls: limits.calls, maxSteps: limits.steps, maxPromptChars: 10000 } };
  const fundingFor = (request: CentralDeliberationRequest) => createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: request.budgetId,
    owner: { kind: "central_deliberation", ownerId: "central:local-timeout-test" }, enabled, now });
  const source: CentralRuntimeSourcePort = { async snapshot() {
    const current = await store.read(scope), refs = changed ? ["source:original", "source:actual-new-feedback"] : ["source:original"];
    return { boardSequence: current.revision, opportunities: [], sourceRefs: refs,
      materials: refs.map(ref => ({ ref, kind: "source" as const, text: ref === "source:original" ? "The original condition is unresolved." : "A new external receiver result arrived.", sourceRefs: [] })) };
  }, async read() { throw new Error("This test does not request a source read"); } };
  const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No consultation requested"); },
    async prepare() { throw new Error("No dispatch requested"); }, async execute() { throw new Error("No worker requested"); }, async recover() { return null; } };
  const deliberation: CentralDeliberationPort = { async deliberate(request) {
    requests.push(request);
    const funding = fundingFor(request), reservationId = `reservation:${request.operation.operationId}`;
    const reserved = await funding.reserve({ reservationId, maxTokens: failure === "capacity" ? 1000 : 40 });
    assert.ok(reserved.ok);
    assert.equal(reserved.status, "reserved");
    const settled = await funding.settle({ reservationId, usage: requests.length === 1
      ? failure === "capacity" ? { kind: "reported", totalTokens: 356, inputTokens: 100, outputTokens: 256 }
        : { kind: "unknown", reason: "central_deliberation_timeout" } : { kind: "reported", totalTokens: 0 } });
    assert.ok(settled.ok);

    if (requests.length === 1) throw failure === "capacity"
      ? new CentralDeliberationError("central_deliberation_incomplete", "returned", reservationId, undefined, undefined, capacityDiagnostics)
      : new CentralDeliberationError("central_deliberation_timeout", "unknown", reservationId);

    return returned;
  }, async inspect(input) {
    const request = requests[0];
    return receiptAvailable && request !== undefined && input.operationId === request.operation.operationId
      ? { status: "returned", request, output: returned, deliveryRef: "delivery:original-late-result", sourceRefs: [] }
      : { status: "unknown", sourceRefs: [] };
  } };
  const makeDriver = () => createCentralLearningDriver({ boardRoot, scope, enabled, now, source, execution, deliberation, semanticRecoveryDelayMs: delay });
  const input: CentralLearningDriveInput = { scope, configuration, wake: { reason: "original_source_available", sourceRefs: ["source:original"] },
    signal: new AbortController().signal, publish() {} };

  return { requests, input, makeDriver, store, fundingFor, advance() { clock += 100000; }, newFeedback() { changed = true; }, lateReceipt() { receiptAvailable = true; } };
}

test("a local timeout preserves its unknown reservation across cold quiet wakes, passively recovers the original receipt, and permits real new feedback", async t => {
  const f = await driverFixture(t), first = f.makeDriver();
  const failed = await first.drive(f.input);
  assert.equal(failed.state, "waiting");
  assert.equal(failed.wakeAt, undefined);
  assert.equal(f.requests.length, 1);
  const original = f.requests[0]!;

  await first.close?.();
  f.advance();
  const cold = f.makeDriver();

  await cold.drive(f.input);
  await cold.drive(f.input);
  assert.equal(f.requests.length, 1, "elapsed time and repeated old notices do not buy a second operation");
  const before = await f.fundingFor(original).inspect();
  assert.ok(before.ok);
  assert.deepEqual(before.projection.occupied, { tokens: 40, calls: 1, steps: 1 });
  assert.equal((await f.store.read(scope)).state.completed.find(row => row.operation.operationId === original.operation.operationId)?.outcome, "unknown");
  f.lateReceipt();
  await cold.drive(f.input);
  assert.equal(f.requests.length, 1, "original receipt recovery sends no new request");
  assert.equal((await f.store.read(scope)).state.completed.find(row => row.operation.operationId === original.operation.operationId)?.outcome, "returned");
  f.newFeedback();
  await cold.drive({ ...f.input, wake: { reason: "actual_external_feedback", sourceRefs: ["source:actual-new-feedback"] } });
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[1]!.operation.operationId, original.operation.operationId);
  assert.equal(f.requests[1]!.operation.operationId.startsWith("central-recover-thought:"), false);
  assert.ok(f.requests[1]!.operation.sourceRefs.includes("source:actual-new-feedback"));
  const after = await f.fundingFor(original).inspect();
  assert.ok(after.ok);
  assert.deepEqual(after.projection.occupied, { tokens: 40, calls: 2, steps: 2 });
  const originalCharge = after.projection.budget.accounting?.find(row => row.reservationId === `reservation:${original.operation.operationId}`);

  assert.equal(originalCharge?.state, "settled");
  assert.equal(originalCharge?.usage?.kind, "unknown");
  await cold.close?.();
});

test("only a fully observed returned zero-tool length result is an output-capacity failure; credit and labels do not repair it", () => {
  const error = new CentralDeliberationError("central_deliberation_incomplete", "returned", "reservation:known", undefined, undefined, capacityDiagnostics);

  assert.equal(error.failureClass, "resources");

  for (const changed of [{ ...capacityDiagnostics, streamExhausted: false }, { ...capacityDiagnostics, usageTailComplete: false },
    { ...capacityDiagnostics, usageObserved: false }, { ...capacityDiagnostics, toolStarts: 1 }]) {
    assert.equal(new CentralDeliberationError("central_deliberation_incomplete", "unknown", "reservation:known", undefined, undefined, changed).failureClass, "transport");
    assert.equal(new CentralDeliberationError("central_deliberation_incomplete", "returned", "reservation:known", undefined, undefined, changed).failureClass, "transport");
  }

  assert.equal(new CentralDeliberationError("central_deliberation_incomplete", "unknown", "reservation:known", undefined, undefined, capacityDiagnostics).failureClass, "transport");
  const state = unknownState(), blocked = { ...state, materials: [...state.materials, semanticRecoveryBlock(operation.operationId, error, budget, configurationRef,
    { state, operation, now: issuedAt, recoveryDelayMs: delay, generationRef: "generation:original" })] };
  const credit = { ...budget, budget: { ...budget.budget, limits: { ...limits, tokens: 999999 } }, available: { tokens: 999999, calls: 4, steps: 4 } };

  assert.equal(semanticResourceCondition(blocked, credit, "configuration:label-only", issuedAt + 999999, undefined, undefined,
    { generationRef: "generation:original" }).blocked, true);
  assert.equal(semanticResourceCondition(blocked, credit, configurationRef, issuedAt, undefined, undefined,
    { generationRef: "generation:actually-different" }).blocked, false);
});

test("a known exhausted decision preserves paid usage across cold quiet wakes and admits only changed generation or real research input", async t => {
  for (const change of ["generation", "research_input"] as const) await t.test(change, async child => {
    const f = await driverFixture(child, "capacity"), first = f.makeDriver();

    assert.equal((await first.drive(f.input)).state, "waiting");
    const original = f.requests[0]!;
    const failure = (await f.store.read(scope)).state.completed.find(row => row.operation.operationId === original.operation.operationId);

    assert.ok(failure);
    assert.equal(failure.outcome, "failed");
    assert.match(failure.publicResult, /没有可用语义决定/);
    await first.close?.();
    f.advance();
    const cold = f.makeDriver();

    await cold.drive(f.input);
    await cold.drive(f.input);
    assert.equal(f.requests.length, 1);
    const paid = await f.fundingFor(original).inspect();
    assert.ok(paid.ok);
    assert.equal(paid.projection.occupied.tokens, 356);

    if (change === "generation") await cold.drive({ ...f.input,
      configuration: { ...f.input.configuration, generationRef: "generation:actually-different" } });
    else {
      f.newFeedback();
      await cold.drive(f.input);
    }

    assert.equal(f.requests.length, 2);
    assert.notEqual(f.requests[1]!.operation.operationId, original.operation.operationId);
    const after = await f.fundingFor(original).inspect();
    assert.ok(after.ok);
    assert.equal(after.projection.occupied.tokens, 356);
    assert.equal(after.projection.budget.accounting?.find(row => row.reservationId === `reservation:${original.operation.operationId}`)?.usage?.kind, "reported");
    await cold.close?.();
  });
});
