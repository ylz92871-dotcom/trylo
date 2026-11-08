import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC } from "./change-reference-contract.js";
import { assertCentralActionCorrectionDelivery } from "./runtime-action-correction.js";
import { isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";
import { packCentralDeliberationContext } from "./deliberation-context.js";
import { createCentralScopeOwner } from "../../adapters/central-learning-runtime/owner.js";

const scope = "workspace:action-correction", initial = Date.parse("2026-11-06T04:00:00.000Z");
const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "configuration:original",
  authorizationRef: "host:original", allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20000,
    maxCalls: 8, maxSteps: 8, maxPromptChars: 30000 } };

async function fixture(t: TestContext, failure: "compiler" | "provider", typedFirst = false) {
  const base = testScratchPath("central-action-correction-tests");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), base);
    await rm(boardRoot, { recursive: true, force: true });
  });
  let clock = initial;
  const now = () => new Date(clock).toISOString(), enabled = () => true, requests: CentralDeliberationRequest[] = [];
  const store = createCentralRuntimeStore({ boardRoot, enabled });
  const source: CentralRuntimeSourcePort = { async snapshot() {
    return { boardSequence: (await store.read(scope)).revision, opportunities: [], sourceRefs: ["source:original"],
      materials: [{ ref: "source:original", kind: "source", text: "The same original research condition remains unresolved.", sourceRefs: [] }] };
  }, async read() { throw new Error("No new business or original read is manufactured by this fixture"); } };
  const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("not_requested"); },
    async prepare() { throw new Error("not_requested"); }, async execute() { throw new Error("not_requested"); }, async recover() { return null; } };
  const funding = (request: CentralDeliberationRequest) => createCentralAccountingFundingAtRoot({ boardRoot, scope,
    budgetId: request.budgetId, owner: { kind: "central_deliberation", ownerId: request.budgetId }, enabled, now });
  const makeDriver = () => createCentralLearningDriver({ boardRoot, scope, enabled, now, source, execution, semanticRecoveryDelayMs: 10,
    deliberation: { async prepareDelivery(request) {
      return packCentralDeliberationContext(request, candidate => {
        assertCentralActionCorrectionDelivery(candidate, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);
        return true;
      });
    }, async deliberate(request) {
      requests.push(request);
      const port = funding(request), reservationId = centralDeliberationReservation(request);
      const reserved = await port.reserve({ reservationId, maxTokens: 1000 });
      assert.ok(reserved.ok);
      assert.equal(reserved.status, "reserved");
      const settled = await port.settle({ reservationId, usage: requests.length === 1 || failure === "compiler"
        ? { kind: "reported", totalTokens: 356, inputTokens: 100, outputTokens: 256 }
        : { kind: "unknown", reason: "central_deliberation_provider_rate_limit" } });
      assert.ok(settled.ok);

      if (requests.length === 1) throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned", reservationId,
        undefined, undefined, undefined, typedFirst ? { schemaVersion: 1, field: "/inspect/refs/0", expected: ["read"],
          actual: "source", cause: "kind_mismatch", handle: "b1" } : undefined);

      assert.equal(isCentralActionCorrectionOperation(scope, request.operation), true);
      assertCentralActionCorrectionDelivery(request, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);

      if (failure === "compiler") throw new CentralDeliberationError("central_learning_change_handle_unbound", "returned", reservationId,
        undefined, undefined, undefined, { schemaVersion: 1, field: "/inspect/refs/0", expected: ["read"], actual: "source", cause: "kind_mismatch", handle: "b1" });

      throw new CentralDeliberationError("central_deliberation_provider_rate_limit", "unknown", reservationId,
        { class: "rate_limit", retryable: true, recovery: { kind: "after", delayMs: 10, source: "retry_after" } });
    }, async inspect() { return { status: "unknown", sourceRefs: [] }; } } });
  const input: CentralLearningDriveInput = { scope, configuration, wake: { reason: "original_checkpoint", sourceRefs: ["source:original"] },
    signal: new AbortController().signal, publish() {} };

  return { makeDriver, input, requests, store, funding, advance() { clock += 100000; } };
}

test("one original refused action receives one real-contract correction, never another correction or provider/timer purchase", async t => {
  for (const failure of ["compiler", "provider"] as const) await t.test(failure, async child => {
    const f = await fixture(child, failure), first = f.makeDriver();

    await first.drive(f.input);
    assert.equal(f.requests.length, 1);
    await first.close?.();
    const original = f.requests[0]!, cold = f.makeDriver();

    await cold.drive(f.input);
    assert.equal(f.requests.length, 2);
    const correction = f.requests[1]!;

    assert.notEqual(correction.operation.operationId, original.operation.operationId);
    assert.equal(correction.operation.sourceRefs[0], original.operation.operationId);
    const feedback = correction.materials.find(row => row.ref === correction.operation.sourceRefs[2]);
    assert.ok(feedback);
    const body = JSON.parse(feedback.text);
    assert.deepEqual(body.knowledge, { kind: "legacy_reason_only" });
    assert.equal(body.reason, "central_learning_change_handle_unbound");
    assert.equal(Object.hasOwn(body, "semanticRejection"), false);
    const wrong = { ...correction, materials: correction.materials.filter(row => row.ref !== feedback.ref) };

    assert.throws(() => assertCentralActionCorrectionDelivery(wrong, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion,
      CENTRAL_REFERENCE_SELECTION_CONTRACT_REF), /contract_unavailable/);
    assert.throws(() => assertCentralActionCorrectionDelivery(correction, "central-learning-change-input-v3",
      CENTRAL_REFERENCE_SELECTION_CONTRACT_REF), /contract_unavailable/);
    f.advance();
    await cold.drive(f.input);
    await cold.close?.();
    const restarted = f.makeDriver();

    await restarted.drive(f.input);
    await restarted.drive(f.input);
    assert.equal(f.requests.length, 2);
    const cursor = await f.store.read(scope), block = cursor.state.materials.map(row => {
      try { return JSON.parse(row.text); } catch { return {}; }
    }).find(row => row.operationId === correction.operation.operationId && row.failureClass);

    assert.ok(block);
    assert.equal(Object.hasOwn(block, "providerRecovery"), false, "Retry-After does not authorize a second corrected computation");

    if (failure === "compiler") assert.equal(block.semanticRejection.field, "/inspect/refs/0");

    const accounting = await f.funding(original).inspect();
    assert.ok(accounting.ok);
    assert.equal(accounting.projection.occupied.calls, 2);
    assert.equal(accounting.projection.budget.accounting?.find(row => row.reservationId === centralDeliberationReservation(original))?.usage?.kind, "reported");
    assert.equal(cursor.history.operations.filter(row => row.operationId.startsWith("central-action-correction:")).length, 1);
    await restarted.close?.();
  });
});

test("the normal owner continues its first concrete refusal without an external wake and stops after one refused correction", async t => {
  const f = await fixture(t, "compiler", true), driver = f.makeDriver(), results: string[] = [];
  const ownerScope = { scopeKey: "scope:action-correction-owner", homeRoot: "D:/readonly-owner-fixture", workspaceRoot: scope };
  const owner = createCentralScopeOwner({ scope: ownerScope, ownerId: "owner:action-correction", now: () => initial,
    intent: { schemaVersion: 1, homeRoot: ownerScope.homeRoot, workspaceRoot: scope, enabled: true,
      configuration: {}, wakeSequence: 1, consumedSequence: 0, wakeReason: "original_pending_wake", sourceRefs: ["source:original"] },
    store: { owns: () => true, writeIntent: () => ({ ok: true }) },
    schedule() { throw new Error("No timer may create this correction"); },
    driver: { async drive(input) {
      assert.ok(results.length < 2, "the owner must stop after the one correction");
      const result = await driver.drive({ ...f.input, wake: input.wake, signal: input.signal });
      results.push(result.state);
      if (results.length === 1) assert.equal(result.state, "ready", "the recorded concrete refusal supplies its own continuation");
      return result;
    }, close: () => driver.close!() } });

  t.after(() => owner.close("stop"));
  owner.start();
  const abort = new AbortController();
  t.after(() => abort.abort());
  let observed = owner.snapshot();

  while (observed.state !== "failed" && (results.length < 2 || observed.state !== "waiting" || observed.consumedSequence !== observed.wakeSequence)) {
    await owner.wait(observed.revision, abort.signal);
    observed = owner.snapshot();
  }

  assert.equal(observed.state, "waiting");
  assert.deepEqual(results, ["ready", "waiting"]);
  assert.equal(f.requests.length, 2);
  assert.equal(observed.wakeSequence, 2);
  assert.equal(observed.consumedSequence, 2);
  const accounting = await f.funding(f.requests[0]!).inspect();
  assert.ok(accounting.ok);
  assert.equal(accounting.projection.occupied.calls, 2);
});
