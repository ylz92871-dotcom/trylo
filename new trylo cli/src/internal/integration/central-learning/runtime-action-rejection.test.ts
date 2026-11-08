import assert from "node:assert/strict";
import test from "node:test";
import type { CentralCompletedOperation, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, lookupCentralRuntimeRecord, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import type { CentralLearningUsage } from "../../learning/control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import type { CentralChangeReferenceRejection } from "./change-reference-contract.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { CENTRAL_ACTION_CORRECTION_PREFIX, readCentralActionRejection, type CentralActionRejection } from "./runtime-action-rejection.js";
import { centralActionCorrection } from "./runtime-action-correction.js";
import { centralActionCorrectionOperationId } from "./runtime-action-correction-identity.js";
import { semanticRecoveryBlock } from "./runtime-recovery.js";

const scope = "workspace:original-action-rejection", now = "2026-11-06T00:00:00.000Z";

function fixture(options: { readonly archived?: boolean; readonly versioned?: boolean; readonly operationId?: string;
  readonly outcome?: CentralCompletedOperation["outcome"]; readonly ownerId?: string; readonly usage?: CentralLearningUsage;
  readonly body?: (body: Record<string, unknown>) => Record<string, unknown>; readonly sourceRefs?: readonly string[] } = {}) {
  const operation: CentralLearningOperation = { kind: "think", operationId: options.operationId ?? "thought:original-action",
    purpose: "Compare the original alternatives", expectedChange: "Choose an original read", sourceRefs: ["source:original"] };
  const reservationId = centralDeliberationReservation({ scope, budgetId: "budget:original-action", operationId: operation.operationId });
  const budget: CentralBudgetProjection = { budget: { schemaVersion: 1, budgetId: "budget:original-action", scope,
    unit: "total_model_tokens", limits: { tokens: 10000, calls: 4, steps: 4 }, authorizationRef: "host:original-action",
    mode: "exclusive_new_funding", openedAt: now, openedSequence: 1, accounting: [{ reservationId,
      owner: { kind: "central_deliberation", ownerId: options.ownerId ?? "budget:original-action" }, maxTokens: 1000,
      reservedAt: now, reservedSequence: 2, state: "settled", usage: options.usage ?? { kind: "reported", totalTokens: 80 } }] },
    occupied: { tokens: 80, calls: 1, steps: 1 }, available: { tokens: 9920, calls: 3, steps: 3 },
    status: "available", historicalExternalGrantIds: [] };
  const original = semanticRecoveryBlock(operation.operationId,
    new CentralDeliberationError("central_learning_change_handle_unbound", "returned", reservationId), budget, "configuration:original-action");
  const body = JSON.parse(original.text) as Record<string, unknown>;
  const text = canonicalJson(options.body?.(body) ?? body);
  const block: CentralRuntimeMaterial = { ...original, ref: options.versioned ? `${original.ref}:${contentHashOf(text)}` : original.ref,
    text, sourceRefs: options.sourceRefs ?? original.sourceRefs };
  const state: CentralLearningRuntimeState = { ...emptyCentralRuntimeState(scope),
    completed: [{ intentId: "central:agenda", operation, outcome: options.outcome ?? "failed", resultRefs: [], publicResult: "The original compiler rejected its change." }],
    materials: [block], consumedSourceRefs: ["source:previously-delivered"] };
  const first: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state,
    reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [block.ref] }), sequence: 3 };
  const compacted: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: { ...state, materials: [] },
    reason: "central_runtime_working_set_compacted", sourceRefs: [] }), sequence: 4 };
  const facts = options.archived ? [first, compacted] : [first], revision = options.archived ? 4 : 3;
  const cursor = readCentralRuntimeRecords(facts, scope, revision), reads: { ref: string; factRef: string }[] = [];
  const input = { state: cursor.state, history: cursor.history, budget,

    async lookupMaterial(ref: string, factRef: string) {
      reads.push({ ref, factRef });
      const found = lookupCentralRuntimeRecord(facts, scope, revision, { kind: "material", ref, factRef });
      return found.status === "found" && isCentralRuntimeMaterial(found.value) ? found.value : undefined;
    } };

  return { input, cursor, block, first, operation, reservationId, reads };
}

test("original reported compiler rejection remains exactly readable after compaction without inventing missing legacy error values", async () => {
  for (const archived of [false, true]) {
    const f = fixture({ archived, versioned: archived }), before = canonicalJson(f.input);

    assert.equal(Object.hasOwn(JSON.parse(f.block.text), "reservationId"), false, "the original C18 shape did not persist the reservation");
    const selected = await readCentralActionRejection(f.input);
    assert.ok(selected);
    assert.equal(selected.completed, f.input.state.completed[0]);
    assert.equal(selected.operation, f.input.state.completed[0]!.operation);
    assert.deepEqual(selected.rejection, f.block);
    assert.equal(selected.rejectionRef, f.block.ref);
    assert.equal(selected.rejectionFactRef, f.first.id);
    assert.equal(selected.reservationId, f.reservationId);
    assert.equal(selected.reason, "central_learning_change_handle_unbound");
    assert.equal(Object.hasOwn(selected, "semanticRejection"), false);
    assert.equal(canonicalJson(f.input), before, "selection cannot mutate the checkpoint, history or original charge");
    assert.deepEqual(f.reads, archived ? [{ ref: f.block.ref, factRef: f.first.id }] : []);
  }

  const semanticRejection: CentralChangeReferenceRejection = { schemaVersion: 1, field: "/checkpoint",
    expected: ["checkpoint"], actual: "unknown", cause: "checkpoint_missing" };
  const checkpoint = fixture({ body: body => ({ ...body, reason: "central_learning_change_invalid", semanticRejection }) });
  const selected = await readCentralActionRejection(checkpoint.input);
  assert.ok(selected);
  assert.equal(selected.reason, "central_learning_change_invalid");
  assert.deepEqual(selected.semanticRejection, semanticRejection);
});

test("unknown, correction, foreign or unproven compiler failures never become an original action correction", async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { outcome: "unknown" },
    { operationId: `${CENTRAL_ACTION_CORRECTION_PREFIX}already-attempted` },
    { usage: { kind: "unknown", reason: "Original settlement remains unknown" } },
    { ownerId: "budget:another-owner" },
    { sourceRefs: ["thought:another"] },
    { body: body => ({ ...body, operationId: "thought:another" }) },
    { body: body => ({ ...body, reservationId: "reservation:another" }) },
    { body: body => ({ ...body, reason: "central_learning_change_invalid" }) },
    { body: body => ({ ...body, reason: "central_learning_change_invalid", semanticRejection: {
      schemaVersion: 1, field: "/inspect/refs/0", expected: ["read"], actual: "source", cause: "kind_mismatch", handle: "b1" } }) },
    { body: body => ({ ...body, semanticRejection: { inventedErrorValue: "not observed" } }) },
    { body: body => ({ ...body, inventedErrorValue: "not observed" }) },
  ];

  for (const options of cases) {
    const f = fixture(options), before = canonicalJson(f.input);
    assert.equal(await readCentralActionRejection(f.input), undefined);
    assert.equal(canonicalJson(f.input), before);
  }

  const f = fixture();

  assert.equal(await readCentralActionRejection({ ...f.input, budget: { ...f.input.budget,
    budget: { ...f.input.budget.budget, scope: "workspace:another" } } }), undefined);
  assert.equal(await readCentralActionRejection({ ...f.input, history: { ...f.input.history,
    operations: f.input.history.operations.map(row => ({ ...row, signature: "unbound-signature" })) } }), undefined);
  const archived = fixture({ archived: true });

  await assert.rejects(readCentralActionRejection({ ...archived.input,
    async lookupMaterial() { throw new Error("original_archive_io_unconfirmed"); } }), /original_archive_io_unconfirmed/);
});

test("a compacted correction fence does not hide an older unused original rejection", async () => {
  const older = fixture({ operationId: "thought:older-unused", body: body => ({ ...body,
    reason: "central_derived_intent_citation_unread_or_not_unique" }) });
  const newer = fixture({ operationId: "thought:newer-attempted" });
  const attempted = fixture({ operationId: centralActionCorrectionOperationId(scope,
    older.input.budget.budget.budgetId, newer.operation.operationId) });
  const state: CentralLearningRuntimeState = { ...older.input.state,
    completed: [older.input.state.completed[0]!, newer.input.state.completed[0]!, attempted.input.state.completed[0]!],
    materials: [older.block, newer.block, attempted.block] };
  const first: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state,
    reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [] }), sequence: 8 };
  const compactedState = { ...state, completed: state.completed.slice(0, 2), materials: [] };
  const compacted: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: compactedState,
    reason: "central_runtime_working_set_compacted", sourceRefs: [] }), sequence: 9 };
  const facts = [first, compacted];
  const budget: CentralBudgetProjection = { ...older.input.budget,
    budget: { ...older.input.budget.budget, accounting: [
      ...older.input.budget.budget.accounting!, ...newer.input.budget.budget.accounting!, ...attempted.input.budget.budget.accounting!] },
    occupied: { tokens: 240, calls: 3, steps: 3 }, available: { tokens: 9760, calls: 1, steps: 1 } };
  const inputFor = (revision: number) => {
    const cursor = readCentralRuntimeRecords(facts, scope, revision);
    return { state: cursor.state, history: cursor.history, budget,

      async lookupMaterial(ref: string, factRef: string) {
        const found = lookupCentralRuntimeRecord(facts, scope, revision, { kind: "material", ref, factRef });
        return found.status === "found" && isCentralRuntimeMaterial(found.value) ? found.value : undefined;
      },

      canCorrect: (original: CentralActionRejection) => centralActionCorrection(cursor.state, cursor.history,
        budget.budget.budgetId, original) !== undefined };
  };
  const input = inputFor(9), before = canonicalJson(input);

  assert.ok(!input.state.completed.some(row => row.operation.operationId === attempted.operation.operationId));
  assert.ok(input.history.operations.some(row => row.operationId === attempted.operation.operationId));
  const selected = await readCentralActionRejection(input);

  assert.equal(selected?.operation.operationId, older.operation.operationId);
  assert.equal(Object.hasOwn(selected!, "citationRejection"), false, "legacy values remain unknown");
  assert.equal(canonicalJson(input), before, "selection is read-only");
  const correction = centralActionCorrection(input.state, input.history, budget.budget.budgetId, selected!);

  assert.ok(correction);
  const issued: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: compacted.id,
    state: { ...compactedState, completed: [...compactedState.completed, { intentId: "central:agenda",
      operation: correction.operation, outcome: "unknown", resultRefs: [], publicResult: "Issued, not confirmed." }] },
    reason: "central_deliberation_issued", sourceRefs: [] }), sequence: 10 };
  const compactedAgain: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: issued.id, state: compactedState,
    reason: "central_runtime_working_set_compacted", sourceRefs: [] }), sequence: 11 };

  facts.push(issued, compactedAgain);
  assert.equal(await readCentralActionRejection(inputFor(11)), undefined, "each original keeps its one issued correction slot");
});
