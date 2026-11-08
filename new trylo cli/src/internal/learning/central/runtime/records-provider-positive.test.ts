import { testScratchPath } from "../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { saveCentralRuntimeCheckpoint } from "../../../integration/central-learning/runtime-checkpoint.js";
import { createCentralRuntimeStore } from "../../../integration/central-learning/runtime-store.js";
import type { RewardV2Fact } from "../../reward/v2-facts.js";
import { providerPositiveAdmissionRef, type ProviderPositiveAdmission } from "./provider-positive.js";
import { buildCentralRuntimeRecord, centralOperationSignature, emptyCentralRuntimeState, initialCentralRuntimeRef,
  lookupCentralRuntimeRecord, readCentralRuntimeRecords, type CentralRuntimeRecordInput } from "./records.js";

const scope = "scope:provider-positive-records";
const operation = (operationId = "think:positive:one") => ({ kind: "think" as const, operationId,
  purpose: "Reconsider the original provider wait", expectedChange: "A grounded central response", sourceRefs: ["wait:one"] });
const issuedState = (operationId?: string) => ({ ...emptyCentralRuntimeState(scope), completed: [{ intentId: "central:agenda",
  operation: operation(operationId), outcome: "unknown" as const, publicResult: "Issued; the response remains unconfirmed", resultRefs: [] }] });
const admission = (noteRef = "normal-provider-success:one", operationId?: string, observedBoardSequence = 0): ProviderPositiveAdmission => ({
  schemaVersion: 1, ref: providerPositiveAdmissionRef(scope, noteRef), scope, budgetId: "budget:original", connectionRef: "connection:original",
  noteRef, waitRef: "wait:one", waitFactRef: "wait-fact:one", observedBoardSequence,
  operationId: operation(operationId).operationId, operationSignature: centralOperationSignature(operation(operationId)),
});
const fact = (sequence: number, input: CentralRuntimeRecordInput): RewardV2Fact => ({ ...buildCentralRuntimeRecord(input), sequence });

test("original checkpoint and cold Board replay retain admission and retirement after compaction without revising unknown work", async t => {
  const base = testScratchPath("central-provider-positive-record-tests");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));

  assert.ok(!path.relative(base, boardRoot).startsWith(".."));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const create = () => createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const original = create(), empty = await original.read(scope), admitted = admission();
  const state = { ...issuedState(), materials: [{ ref: "wait:one", kind: "feedback" as const, text: "Original provider wait", sourceRefs: [] }] };
  const issued = await saveCentralRuntimeCheckpoint(original, empty, state, "central_deliberation_issued", [], undefined, { admission: admitted });
  const firstLocator = { admission: admitted, factRef: issued.stateRef, sequence: issued.revision };

  assert.deepEqual((await create().read(scope)).history.providerPositiveAdmissions, [firstLocator]);
  const compact = await saveCentralRuntimeCheckpoint(create(), issued, emptyCentralRuntimeState(scope), "Compact archived work", [], undefined, { admission: admitted });
  const beforeConflict = await create().read(scope);

  await assert.rejects(create().append({ previousRef: beforeConflict.stateRef, expectedRevision: beforeConflict.revision,
    state: beforeConflict.state, reason: "An altered admission must not overwrite history", sourceRefs: [],
    providerRecoveryUpdate: { admission: { ...admitted, connectionRef: "connection:other" } } }), /central_runtime_provider_admission_identity_conflict/);
  assert.equal((await create().read(scope)).stateRef, beforeConflict.stateRef, "prospective replay rejects a conflicting record before the original append");
  const retired = await saveCentralRuntimeCheckpoint(create(), compact, compact.state, "central_deliberation_contract_rejected", [], undefined,
    { retiredWaitRefs: [admitted.waitRef] });
  const final = await saveCentralRuntimeCheckpoint(create(), retired, retired.state, "Later checkpoint", [], undefined,
    { retiredWaitRefs: [admitted.waitRef, "wait:other"] });
  const cold = await create().read(scope);

  assert.equal(cold.stateRef, final.stateRef);
  assert.deepEqual(cold.history.providerPositiveAdmissions, [firstLocator]);
  assert.deepEqual(cold.history.retiredProviderWaitRefs, ["wait:one", "wait:other"]);
  assert.deepEqual(cold.history.materials, [{ ref: "wait:one", factRef: issued.stateRef, sequence: issued.revision }]);
  assert.deepEqual(cold.state, emptyCentralRuntimeState(scope), "host metadata never enters working state");
  const unknown = await create().lookup(scope, { kind: "completed", operationId: admitted.operationId, factRef: issued.stateRef });

  assert.equal(unknown.status, "found");

  if (unknown.status === "found") {
    assert.ok("outcome" in unknown.value);
    assert.equal(unknown.value.outcome, "unknown");
  }
});

test("closed record metadata binds an issued operation and accepts a second note only from a newer wait observation", () => {
  const firstAdmission = admission(), first = fact(1, { previousRef: initialCentralRuntimeRef(scope), state: issuedState(),
    reason: "central_deliberation_issued", sourceRefs: [], providerRecoveryUpdate: { admission: firstAdmission } });
  const compact = fact(2, { previousRef: first.id, state: emptyCentralRuntimeState(scope), reason: "Compact", sourceRefs: [] });
  const laterAdmission = admission("normal-provider-success:two", "think:positive:two", 2);
  const later = fact(3, { previousRef: compact.id, state: issuedState(laterAdmission.operationId), reason: "central_deliberation_issued", sourceRefs: [],
    providerRecoveryUpdate: { admission: laterAdmission } });
  const history = readCentralRuntimeRecords([first, compact, later], scope, 3).history;

  assert.deepEqual(history.providerPositiveAdmissions?.map(row => row.admission.ref), [firstAdmission.ref, laterAdmission.ref]);
  const staleAdmission = admission("normal-provider-success:concurrent-old", "think:positive:three", 1);
  const stale = fact(4, { previousRef: later.id, state: issuedState(staleAdmission.operationId), reason: "central_deliberation_issued", sourceRefs: [],
    providerRecoveryUpdate: { admission: staleAdmission } });

  assert.throws(() => readCentralRuntimeRecords([first, compact, later, stale], scope, 4), /central_runtime_provider_wait_evidence_not_newer/);
  const invalidBinding = fact(1, { previousRef: initialCentralRuntimeRef(scope), state: issuedState(), reason: "central_deliberation_issued", sourceRefs: [],
    providerRecoveryUpdate: { admission: { ...firstAdmission, operationSignature: "a".repeat(64) } } });

  assert.throws(() => readCentralRuntimeRecords([invalidBinding], scope, 1), /central_runtime_provider_admission_binding/);
  const retired = fact(4, { previousRef: later.id, state: emptyCentralRuntimeState(scope), reason: "Complete response", sourceRefs: [],
    providerRecoveryUpdate: { retiredWaitRefs: [firstAdmission.waitRef] } });
  const afterRetirement = admission("normal-provider-success:late", "think:positive:late", 4);
  const resurrected = fact(5, { previousRef: retired.id, state: issuedState(afterRetirement.operationId), reason: "central_deliberation_issued", sourceRefs: [],
    providerRecoveryUpdate: { admission: afterRetirement } });

  assert.throws(() => readCentralRuntimeRecords([first, compact, later, retired, resurrected], scope, 5), /central_runtime_provider_wait_evidence_not_newer/);
  const base = { previousRef: initialCentralRuntimeRef(scope), state: emptyCentralRuntimeState(scope), reason: "Invalid closed metadata", sourceRefs: [] };

  for (const update of [{}, { retiredWaitRefs: ["wait:one", "wait:one"] }, { admission: firstAdmission, inventedPermission: true }]) {
    assert.throws(() => buildCentralRuntimeRecord({ ...base, providerRecoveryUpdate: update } as CentralRuntimeRecordInput), /central_runtime_record_invalid/);
  }

  assert.equal(lookupCentralRuntimeRecord([first, compact, later], scope, 3, { kind: "completed", operationId: firstAdmission.operationId }).status, "found");
});
