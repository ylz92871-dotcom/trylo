import assert from "node:assert/strict";
import test from "node:test";
import type { CentralLearningConfiguration, CentralLearningIntentDraft, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, lookupCentralRuntimeRecord, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { CENTRAL_RESOURCE_WAIT_PREFIX } from "../../learning/central/runtime/resource-waits.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import type { CentralLearningUsage } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import type { CentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { semanticRecoveryBlock } from "./runtime-recovery.js";
import { recoverCentralOutputCapacityFailures } from "./runtime-output-capacity-recovery.js";

const scope = "workspace:original-output-capacity", now = "2026-11-06T00:00:00.000Z";
const operation: CentralLearningOperation = { kind: "think", operationId: "thought:original-capacity",
  purpose: "Resolve the original comparison", expectedChange: "Choose the next original inquiry", sourceRefs: ["source:original"] };
const configuration: CentralLearningConfiguration & { readonly generationRef?: string } = {
  schemaVersion: 1, configurationRef: "configuration:original", authorizationRef: "host:original", generationRef: "generation:original",
  allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10000, maxCalls: 4, maxSteps: 4, maxPromptChars: 32768 } };
const diagnostics: CentralDeliberationOutputDiagnostics = { schemaVersion: 1, rejectionReason: "central_deliberation_incomplete",
  cause: "length_termination", argumentChars: 0, toolStarts: 0, invalidTools: 0, requestedOutputTokens: 8192,
  finishReason: "length", usageObserved: true, streamExhausted: true, usageTailComplete: true };

function fixture(options: { readonly archived?: boolean; readonly usage?: CentralLearningUsage;
  readonly ownerId?: string; readonly body?: (body: Record<string, unknown>) => Record<string, unknown>; readonly sourceRefs?: readonly string[] } = {}) {
  const reservationId = centralDeliberationReservation({ scope, budgetId: "budget:original", operationId: operation.operationId });
  const budget: CentralBudgetProjection = { budget: { schemaVersion: 1, budgetId: "budget:original", scope,
    unit: "total_model_tokens", limits: { tokens: 10000, calls: 4, steps: 4 }, authorizationRef: "host:original",
    mode: "exclusive_new_funding", openedAt: now, openedSequence: 1, accounting: [{ reservationId,
      owner: { kind: "central_deliberation", ownerId: options.ownerId ?? "budget:original" }, maxTokens: 9000,
      reservedAt: now, reservedSequence: 2, state: "settled", usage: options.usage ?? { kind: "reported", totalTokens: 8272, inputTokens: 80, outputTokens: 8192 } }] },
    occupied: { tokens: 8272, calls: 1, steps: 1 }, available: { tokens: 1728, calls: 3, steps: 3 },
    status: "available", historicalExternalGrantIds: [] };
  const original = semanticRecoveryBlock(operation.operationId,
    new CentralDeliberationError("central_deliberation_incomplete", "returned", reservationId, undefined, undefined, diagnostics),
    budget, configuration.configurationRef);
  const body = { ...JSON.parse(original.text), failureClass: "transport" } as Record<string, unknown>;
  const block: CentralRuntimeMaterial = { ...original, text: canonicalJson(options.body?.(body) ?? body), sourceRefs: options.sourceRefs ?? original.sourceRefs };
  const intent: CentralLearningIntentDraft = { intentId: "intent:original", subject: { plane: "agent", domain: "collaboration", issueId: "issue:original" },
    goal: "Compare the original alternatives", rationale: "A real comparison remains unresolved", conditions: ["Original source remains available"],
    knowledge: [], residual: ["The comparison remains unresolved"], commitment: { purpose: "Resolve the original comparison",
      assumptions: ["Keep original receipts"], reconsiderWhen: ["A relevant original fact changes"] },
    revisionReason: "Retain the original residual", sourceRefs: ["source:original"], continuation: { kind: "ready", operation } };
  const state: CentralLearningRuntimeState = { ...emptyCentralRuntimeState(scope), intents: [intent],
    agendaRead: { kind: "read", operationId: "read:independent", purpose: "Read the other original source",
      expectedChange: "Inspect its original condition", sourceRefs: ["source:independent"], refs: ["source:independent"], maximumChars: 1024 },
    completed: [{ intentId: intent.intentId, operation, outcome: "unknown", resultRefs: ["receipt:original-marker"], publicResult: "Original response unconfirmed" }],
    materials: [block], consumedSourceRefs: ["source:already-delivered"] };
  const first: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state,
    reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [block.ref] }), sequence: 3 };
  const compacted: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: { ...state, materials: [] },
    reason: "central_runtime_working_set_compacted", sourceRefs: [] }), sequence: 4 };
  const facts = options.archived ? [first, compacted] : [first], revision = options.archived ? 4 : 3;
  const cursor = readCentralRuntimeRecords(facts, scope, revision), reads: string[] = [];
  const input = { state: cursor.state, history: cursor.history, budget, configuration,

    async lookupMaterial(ref: string, factRef: string) {
      reads.push(ref);
      const found = lookupCentralRuntimeRecord(facts, scope, revision, { kind: "material", ref, factRef });
      return found.status === "found" && isCentralRuntimeMaterial(found.value) ? found.value : undefined;
    } };

  return { input, block, facts, cursor, reads, reservationId };
}

test("cold complete length with its original reported settlement becomes failed once without interpreting or acknowledging sources", async () => {
  for (const archived of [false, true]) {
    const f = fixture({ archived }), before = canonicalJson(f.input);
    const recovered = await recoverCentralOutputCapacityFailures(f.input);
    assert.ok(recovered);
    assert.equal(canonicalJson(f.input), before, "the original checkpoint and accounting remain immutable");
    assert.equal(recovered.state.completed[0]?.outcome, "failed");
    assert.deepEqual(recovered.state.completed[0]?.operation, operation);
    assert.equal(recovered.state.completed[0]?.intentId, f.input.state.completed[0]?.intentId);
    assert.deepEqual(recovered.state.completed[0]?.resultRefs, ["receipt:original-marker"]);
    assert.deepEqual(recovered.state.consumedSourceRefs, f.input.state.consumedSourceRefs);
    assert.equal(recovered.state.agendaRead, f.input.state.agendaRead);
    assert.equal(recovered.state.running, f.input.state.running);
    const intent = recovered.state.intents[0]!;

    assert.deepEqual(intent.residual, f.input.state.intents[0]!.residual);
    assert.equal(intent.continuation.kind, "waiting");

    if (intent.continuation.kind === "waiting") {
      assert.equal(intent.continuation.wait.kind, "resources");
      assert.equal(intent.continuation.wait.reason, "central_deliberation_output_capacity_exhausted");
      assert.deepEqual(intent.continuation.wait.sourceRefs, [f.block.ref, f.reservationId, operation.operationId]);
    }

    assert.deepEqual(recovered.state.materials.find(row => row.ref === f.block.ref), f.block);
    const replacement = recovered.state.materials.at(-1)!;

    assert.equal(replacement.ref, `${CENTRAL_RESOURCE_WAIT_PREFIX}${contentHashOf(operation.operationId)}:${contentHashOf(replacement.text)}`);
    const body = JSON.parse(replacement.text);

    assert.equal(body.failureClass, "resources");
    assert.equal(body.reason, "central_deliberation_incomplete");
    assert.equal(body.priorWaitRef, f.block.ref);
    assert.equal(body.generationRef, configuration.generationRef);
    assert.deepEqual(body.outputDiagnostics, diagnostics);
    assert.equal(body.reservationId, f.reservationId);
    assert.deepEqual(f.reads, archived ? [f.block.ref] : []);
    assert.equal(await recoverCentralOutputCapacityFailures({ ...f.input, state: recovered.state }), undefined);
    const final: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: f.cursor.stateRef, state: recovered.state,
      reason: "central_original_output_capacity_failure_recovered", sourceRefs: recovered.sourceRefs }), sequence: f.cursor.revision + 1 };
    const cold = readCentralRuntimeRecords([...f.facts, final], scope, final.sequence);

    assert.equal(cold.state.completed[0]?.outcome, "failed");
    assert.deepEqual(cold.history.pendingSemanticSourceRefs, ["source:original"]);
  }

  const f = fixture();
  const changed = await recoverCentralOutputCapacityFailures({ ...f.input,
    configuration: { ...configuration, configurationRef: "configuration:changed" } });
  assert.ok(changed);
  assert.equal(Object.hasOwn(JSON.parse(changed.state.materials.at(-1)!.text), "generationRef"), false,
    "a current generation identity cannot be backfilled into a different original configuration");
  const ended = { ...f.input.state.intents[0]!, continuation: { kind: "ended" as const, goalState: "withdrawn" as const, reason: "PA withdrew it" } };
  const withdrawn = await recoverCentralOutputCapacityFailures({ ...f.input, state: { ...f.input.state, intents: [ended] } });
  assert.ok(withdrawn);
  assert.equal(withdrawn.state.intents[0], ended, "mechanical failure recovery cannot revive a withdrawn purpose");
});

test("missing or mismatched original length and accounting proof keeps the original operation unknown", async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { body: body => {
      const { outputDiagnostics: _diagnostics, ...rest } = body;
      return rest;
    } },
    { usage: { kind: "unknown", reason: "Original usage tail is unknown" } },
    { usage: { kind: "reported", totalTokens: 80 } },
    { usage: { kind: "reported", totalTokens: 4176, inputTokens: 80, outputTokens: 4096 } },
    { ownerId: "central:another-owner" },
    { body: body => ({ ...body, operationId: "thought:another" }) },
    { body: body => ({ ...body, reservationId: "reservation:another" }) },
    { body: body => ({ ...body, outputDiagnostics: { ...diagnostics, finishReason: null } }) },
    { body: body => ({ ...body, outputDiagnostics: { ...diagnostics, usageTailComplete: false } }) },
    { body: body => ({ ...body, authorization: "unrecognized extension" }) },
    { sourceRefs: ["thought:another"] },
  ];

  for (const options of cases) {
    const f = fixture(options), before = canonicalJson(f.input.state);
    assert.equal(await recoverCentralOutputCapacityFailures(f.input), undefined);
    assert.equal(canonicalJson(f.input.state), before);
    assert.equal(f.input.state.completed[0]?.outcome, "unknown");
  }

  const archived = fixture({ archived: true });

  await assert.rejects(recoverCentralOutputCapacityFailures({ ...archived.input,
    async lookupMaterial() { throw new Error("original_archive_io_unconfirmed"); } }), /original_archive_io_unconfirmed/);
});
