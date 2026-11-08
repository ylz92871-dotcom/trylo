import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createCentralScopeOwner } from "../../adapters/central-learning-runtime/owner.js";
import { isRuntimeIntent, type RuntimeIntent } from "../../adapters/central-learning-runtime/files.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import type { CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralLearningDriverProgress, CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { isCentralLearningRuntimeState } from "../../learning/central/runtime/validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC,
  readCentralReferenceSelectionCapability } from "./change-reference-contract.js";
import { CENTRAL_SINGLE_ACTION_VERSION } from "./change-single-action-version.js";
import { isCentralChangeStructureRejection } from "./change-structure-rejection.js";
import { createCentralModelDeliberation, CentralDeliberationError } from "./deliberation.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { assertCentralActionCorrectionDelivery } from "./runtime-action-correction.js";
import { isCentralActionCorrectionOperation } from "./runtime-action-correction-identity.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";

type Scenario = "synthetic_unknown_action" | "legacy_generic_invalid" | "root_unexpected";

type AccountingRow = NonNullable<CentralBudgetProjection["budget"]["accounting"]>[number];

const sourceRef = "source:original-structure-research", initial = Date.parse("2026-11-06T08:00:00.000Z");
const privateBadValue = "PRIVATE_BAD_VALUE_MUST_NOT_BECOME_DIAGNOSTIC_KNOWLEDGE";
// Synthetic protocol fixture only: C24's actual rejected action string was not retained and is unknown.
const syntheticUnknownAction = "fixture_unknown_top_level_action";

function response(value: unknown): Response {
  const frames = [{ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } }];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function fixture(t: TestContext, scenario: Scenario) {
  const base = testScratchPath("central-structure-correction-tests");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), base);
    await rm(boardRoot, { recursive: true, force: true });
  });
  const scope = boardRoot, enabled = () => true;
  let clock = initial, fetchCalls = 0, timers = 0;
  const now = () => new Date(clock).toISOString(), allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 300000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 };
  const root = await ensureCentralLearningBudget({ boardRoot, scope, allowance, authorizationRef: "host:original-structure-root", enabled, now });

  assert.ok(root.ok, JSON.stringify(root));
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "configuration:original-structure",
    authorizationRef: "host:original-structure-root", allowance, rootRef: root.rootRef };
  const store = createCentralRuntimeStore({ boardRoot, enabled });
  const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope, budgetId: root.rootRef.budgetId,
    owner: { kind: "central_deliberation", ownerId: root.rootRef.budgetId }, enabled, now });
  const source: CentralRuntimeSourcePort = { async snapshot() {
    return { boardSequence: (await store.read(scope)).revision, opportunities: [], sourceRefs: [sourceRef], materials: [{
      ref: sourceRef, kind: "source", text: "An original research condition remains unresolved; choosing the useful inquiry belongs to the central learner.", sourceRefs: [] }] };
  }, async read() { throw new Error("This refusal does not manufacture a business read"); } };
  const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No consultation was selected"); },
    async prepare() { throw new Error("No domain work was selected"); }, async execute() { throw new Error("No worker was selected"); }, async recover() { return null; } };
  const requests: CentralDeliberationRequest[] = [], failures: CentralDeliberationError[] = [];
  let firstCharge: AccountingRow | undefined;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://local-structure.invalid/chat/completions", model: "local-action-model",
    apiKey: "local-only-key", responseFormats: ["json_object"], maxAttemptsBeforeHeaders: 1, fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      assert.ok(fetchCalls <= 2, "a correction of the correction must never purchase a third response");
      const wire = JSON.parse(String(init?.body));
      assert.deepEqual(wire.response_format, { type: "json_object" });
      assert.equal(wire.tools, undefined);
      assert.ok(wire.messages.some((message: { readonly role: string; readonly content: string }) => message.role === "system"
        && message.content.startsWith(CENTRAL_SINGLE_ACTION_VERSION)), "the actual default action_json page must be used");
      const views = wire.messages.flatMap((message: { readonly role: string; readonly content: string }) => {
        if (message.role !== "user" || !message.content.startsWith("{")) return [];
        const value = JSON.parse(message.content);
        return value.role === "central_learning_public_input" ? [value] : [];
      });

      assert.equal(views.length, 1);
      const view = views[0];
      assert.equal(typeof view.checkpoint, "string");
      assert.equal(view.referenceSelection.contractRef, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);

      return response(scenario === "synthetic_unknown_action"
        ? { checkpoint: view.checkpoint, action: syntheticUnknownAction, why: "Keep the original uncertainty." }
        : scenario === "root_unexpected"
        ? { checkpoint: view.checkpoint, changes: [], explanation: "Keep the original uncertainty.", unknown_private_key: privateBadValue }
        : { checkpoint: view.checkpoint, changes: privateBadValue, explanation: "Keep the original uncertainty." });
    } });
  const model = createCentralModelDeliberation({ provider, model: "local-action-model", funding, enabled, maxOutputTokens: 512,
    secrets: ["local-only-key"] });
  const makeDriver = () => createCentralLearningDriver({ boardRoot, scope, source, execution, enabled, now,
    deliberation: { ...model, async deliberate(request, signal, constraints) {
      requests.push(request);
      try { return await model.deliberate(request, signal, constraints); }
      catch (error) {
        assert.ok(error instanceof CentralDeliberationError);
        // A legacy owner could preserve only its old reason. The original model
        // still owns this actual response, terminal boundary and reported charge.
        const surfaced = scenario === "legacy_generic_invalid" ? new CentralDeliberationError("central_learning_change_invalid", "returned", error.reservationId) : error;

        failures.push(surfaced);

        if (firstCharge === undefined) {
          const current = await funding.inspect();
          assert.ok(current.ok);
          firstCharge = structuredClone(current.projection.budget.accounting![0]!);
        }

        throw surfaced;
      }
    } } });
  const driver = makeDriver(), results: CentralLearningDriverProgress[] = [], ownerErrors: string[] = [];
  const ownerScope = { scopeKey: "scope:original-structure-owner", homeRoot: boardRoot, workspaceRoot: boardRoot };
  let intent: RuntimeIntent = { schemaVersion: 1, homeRoot: ownerScope.homeRoot, workspaceRoot: ownerScope.workspaceRoot, enabled: true,
    configuration: {}, wakeSequence: 1, consumedSequence: 0, wakeReason: "original_pending_wake", sourceRefs: [sourceRef] };
  const owner = createCentralScopeOwner({ scope: ownerScope, ownerId: "owner:original-structure", intent, now: () => clock,
    store: { owns: () => true, writeIntent(value) {
      assert.ok(isRuntimeIntent(value));
      intent = value;
      return { ok: true };
    } },

    schedule() {
      timers += 1;
      throw new Error("A timer may not buy this correction");
    },

    driver: { async drive(input) {
      assert.ok(results.length < 2, "the original owner must stop after the sole correction");
      try {
        const result = await driver.drive({ scope, configuration, wake: input.wake, signal: input.signal, publish() {} });
        results.push(result);
        return result;
      } catch (error) {
        ownerErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
        throw error;
      }
    }, close: () => driver.close!() } });

  t.after(() => owner.close("stop"));
  const input: CentralLearningDriveInput = { scope, configuration, wake: { reason: "original_checkpoint", sourceRefs: [sourceRef] },
    signal: new AbortController().signal, publish() {} };

  return { scope, root, model, requests, failures, results, ownerErrors, owner, store, funding, makeDriver, input,
    fetchCalls: () => fetchCalls, timers: () => timers, firstCharge: () => firstCharge, intent: () => intent,
    advance() { clock += 100000; } };
}

async function runOriginalPendingWake(f: Awaited<ReturnType<typeof fixture>>) {
  f.owner.start();
  const abort = new AbortController();

  try {
    let current = f.owner.snapshot();
    while (current.state !== "failed" && !(current.state === "waiting" && current.consumedSequence === current.wakeSequence && f.results.length > 0)) {
      await f.owner.wait(current.revision, abort.signal);
      current = f.owner.snapshot();
    }
    assert.equal(current.state, "waiting", JSON.stringify({ owner: current, errors: f.ownerErrors }));
    return current;
  } finally { abort.abort(); }
}

test("normal owner immediately funds one concrete structure correction for a synthetic unknown action, then stops", { timeout: 15000 }, async t => {
  const f = await fixture(t, "synthetic_unknown_action"), idle = await runOriginalPendingWake(f);

  assert.equal(f.fetchCalls(), 2, "the sole pending wake must continue its actionable structure refusal without an external wake");
  assert.deepEqual(f.results.map(row => row.state), ["ready", "waiting"]);
  assert.equal(f.timers(), 0);
  assert.equal(idle.wakeSequence, 2);
  assert.equal(idle.consumedSequence, 2);
  assert.equal(f.intent().wakeReason, "driver_continuation");
  const original = f.requests[0]!, correction = f.requests[1]!, diagnostic = f.model.receipts()[0]!.structureRejection;

  assert.ok(isCentralChangeStructureRejection(diagnostic));
  assert.deepEqual(diagnostic, {
    schemaVersion: 1, stage: "shape", field: "/action", expected: "enum", actual: "string", cause: "value" });
  assert.deepEqual(f.failures[0]!.structureRejection, diagnostic);
  assert.deepEqual(f.model.receipts()[1]!.structureRejection, diagnostic);
  assert.equal(original.budgetId, correction.budgetId);
  assert.equal(correction.budgetId, f.root.rootRef.budgetId);
  assert.ok(isCentralActionCorrectionOperation(f.scope, correction.operation));
  assert.notEqual(correction.operation.operationId, original.operation.operationId);
  const bindings = assertCentralActionCorrectionDelivery(correction, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);

  assert.ok(bindings);
  const feedback = correction.materials.find(row => row.ref === bindings.feedbackRef), oldRefusal = correction.materials.find(row => row.ref === bindings.rejectionRef);

  assert.ok(feedback && oldRefusal);
  const body = JSON.parse(feedback.text);

  assert.deepEqual(body.knowledge, { kind: "typed_structure_rejection", value: diagnostic });
  assert.deepEqual(JSON.parse(oldRefusal.text).structureRejection, diagnostic);
  assert.equal(body.rejectionHash, contentHashOf(oldRefusal.text));
  assert.ok(!feedback.text.includes(syntheticUnknownAction) && !oldRefusal.text.includes(syntheticUnknownAction));
  const capability = correction.materials.find(row => row.ref === bindings.capabilityRef);
  assert.ok(capability);
  assert.equal(readCentralReferenceSelectionCapability(capability)?.contractRef, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);
  const changed = { ...body, knowledge: { kind: "typed_structure_rejection", value: { ...diagnostic, field: "/explanation", expected: "text", actual: "number" } } };
  const tampered = { ...feedback, text: canonicalJson(changed), ref: `central-action-correction-feedback:${contentHashOf([f.scope, correction.budgetId, changed])}` };
  const forgedRequest = { ...correction, operation: { ...correction.operation,
    sourceRefs: correction.operation.sourceRefs.map(ref => ref === feedback.ref ? tampered.ref : ref) },
    materials: correction.materials.map(row => row.ref === feedback.ref ? tampered : row) };

  assert.throws(() => assertCentralActionCorrectionDelivery(forgedRequest, CENTRAL_REFERENCE_SELECTION_CONTRACT_SPEC.inputVersion,
    CENTRAL_REFERENCE_SELECTION_CONTRACT_REF), /central_action_correction_contract_unavailable/, "a canonical/hash-consistent substituted field cannot replace the original compiler diagnostic");
  const accounting = await f.funding.inspect();
  assert.ok(accounting.ok);
  if (!accounting.ok) return;

  assert.equal(accounting.projection.budget.accounting!.length, 2);
  assert.equal(accounting.projection.occupied.calls, 2);
  assert.ok(accounting.projection.budget.accounting!.every(row => row.state === "settled" && row.usage?.kind === "reported"));
  assert.deepEqual(accounting.projection.budget.accounting![0], f.firstCharge());
  assert.notEqual(centralDeliberationReservation(original), centralDeliberationReservation(correction));
  await f.owner.close("restart");
  f.advance();
  const cold = f.makeDriver();
  t.after(() => cold.close?.());

  for (let index = 0; index < 2; index += 1) assert.equal((await cold.drive(f.input)).wakeAt, undefined);

  assert.equal(f.fetchCalls(), 2);
  assert.equal(f.timers(), 0);
  const cursor = await f.store.read(f.scope);
  assert.ok(isCentralLearningRuntimeState(cursor.state));
  assert.equal(cursor.history.operations.filter(row => row.operationId.startsWith("central-action-correction:")).length, 1);
  assert.equal(cursor.state.completed.find(row => row.operation.operationId === correction.operation.operationId)?.outcome, "failed");
  const afterRestart = await f.funding.inspect();
  assert.ok(afterRestart.ok);
  if (afterRestart.ok) assert.deepEqual(afterRestart.projection.budget.accounting, accounting.projection.budget.accounting);
});

test("legacy generic invalid without a structural diagnostic never authorizes a correction", { timeout: 15000 }, async t => {
  for (const scenario of ["legacy_generic_invalid"] as const) await t.test(scenario, async child => {
    const f = await fixture(child, scenario), idle = await runOriginalPendingWake(f);

    assert.equal(f.fetchCalls(), 1);
    assert.deepEqual(f.results.map(row => row.state), ["waiting"]);
    assert.equal(idle.wakeSequence, 1);
    assert.equal(idle.consumedSequence, 1);
    assert.equal(f.timers(), 0);
    assert.equal(f.failures[0]!.structureRejection, undefined);
    const billed = await f.funding.inspect();
    assert.ok(billed.ok);
    if (!billed.ok) return;

    assert.equal(billed.projection.budget.accounting!.length, 1);
    assert.equal(billed.projection.budget.accounting![0]!.usage?.kind, "reported");
    await f.owner.close("restart");
    f.advance();
    const cold = f.makeDriver();
    child.after(() => cold.close?.());
    assert.equal((await cold.drive(f.input)).wakeAt, undefined);
    assert.equal(f.fetchCalls(), 1);
    const cursor = await f.store.read(f.scope);
    assert.ok(isCentralLearningRuntimeState(cursor.state));
    assert.equal(cursor.history.operations.some(row => row.operationId.startsWith("central-action-correction:")), false);
    assert.equal(cursor.state.materials.some(row => row.ref.startsWith("central-action-correction-feedback:")), false);
    const unchanged = await f.funding.inspect();
    assert.ok(unchanged.ok);
    if (unchanged.ok) assert.deepEqual(unchanged.projection.budget.accounting, billed.projection.budget.accounting);
  });
});
