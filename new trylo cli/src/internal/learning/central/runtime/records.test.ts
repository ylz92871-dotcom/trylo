import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, contentHashOf } from "../../control/hash.js";
import type { RewardV2Fact } from "../../reward/v2-facts.js";
import { buildCentralRuntimeRecord, centralOperationSignature, CENTRAL_RUNTIME_ALGORITHM, emptyCentralRuntimeState, initialCentralRuntimeRef,
  lookupCentralRuntimeRecord, readCentralRuntimeRecords, readCentralRuntimePrefix } from "./records.js";

const scope = "scope:runtime-records";
const input = () => ({ previousRef: initialCentralRuntimeRef(scope), state: emptyCentralRuntimeState(scope), reason: "A deliberate state transition", sourceRefs: ["source:one"] });
const fact = (sequence: number, value = input()): RewardV2Fact => ({ ...buildCentralRuntimeRecord(value), sequence });

test("empty legacy Board has a stable scope-specific initial state and unrelated algorithms stay opaque", () => {
  const old: RewardV2Fact = { id: "old", scope, algorithmVersion: "other-v1", kind: "feedback", payloadJson: "{}", sequence: 1 };
  const a = readCentralRuntimeRecords([], scope, 0), b = readCentralRuntimeRecords([old], scope, 1);
  assert.equal(a.stateRef, b.stateRef);
  assert.equal(b.revision, 1);
  assert.deepEqual(b.state, a.state);
  assert.notEqual(a.stateRef, initialCentralRuntimeRef("scope:other"));
});

test("canonical full snapshots replay one predecessor chain without merging state from other scopes", () => {
  const first = fact(1), nextState = { ...input().state,
    materials: [{ ref: "material:1", kind: "knowledge" as const, text: "Original source text", sourceRefs: ["source:one"] }], consumedSourceRefs: ["source:one"] };
  const second = fact(3, { ...input(), previousRef: first.id, state: nextState });
  const other: RewardV2Fact = { ...first, id: "other:corrupt-runtime", scope: "scope:unrelated", sequence: 2 };
  const read = readCentralRuntimeRecords([first, other, second], scope, 4);

  assert.equal(read.stateRef, second.id);
  assert.equal(read.revision, 4);
  assert.deepEqual(read.state, nextState);
  assert.deepEqual(readCentralRuntimeRecords([first], scope, 1).state, emptyCentralRuntimeState(scope), "the old immutable snapshot is still readable");
  const prefix = readCentralRuntimePrefix([first, other, second], scope, 4);
  assert.deepEqual(prefix.map(row => row.factRef), [first.id, second.id]);
  const earlier = prefix[0]!.state;
  Object.assign(earlier, { materials: [...earlier.materials, { ref: "caller:local", kind: "source", text: "Caller-owned copy", sourceRefs: [] }] });
  assert.deepEqual(prefix[0]!.state, emptyCentralRuntimeState(scope), "historical reads remain independent of a caller's mutations");
  assert.deepEqual(prefix[1]!.state, nextState, "an exact historical body is decoded from its original immutable bytes");
});

test("replay rejects forks, edited identities, noncanonical payloads and cross-scope snapshots", () => {
  const first = fact(1), fork = fact(2, { ...input(), reason: "A fork from the old empty head" });

  assert.throws(() => readCentralRuntimeRecords([first, fork], scope, 2), /central_runtime_chain_corrupt/);
  assert.throws(() => readCentralRuntimeRecords([{ ...first, id: "forged" }], scope, 1), /central_runtime_record_corrupt/);
  assert.throws(() => readCentralRuntimeRecords([{ ...first, kind: "feedback" }], scope, 1), /central_runtime_record_corrupt/);
  assert.throws(() => readCentralRuntimeRecords([{ ...first, payloadJson: `${first.payloadJson} ` }], scope, 1), /central_runtime_record_corrupt/);
  const changedScope = { ...input(), state: emptyCentralRuntimeState("scope:other") };

  assert.throws(() => readCentralRuntimeRecords([{ ...fact(1, changedScope), scope }], scope, 1), /central_runtime_chain_corrupt/);
  const body = { ...JSON.parse(first.payloadJson), permission: "allow" }, payloadJson = canonicalJson(body);

  assert.throws(() => readCentralRuntimeRecords([{ ...first, id: `central-runtime-state:${contentHashOf(payloadJson)}`, payloadJson }], scope, 1), /central_runtime_record_corrupt/);
  assert.throws(() => readCentralRuntimeRecords([{ ...first, algorithmVersion: CENTRAL_RUNTIME_ALGORITHM, payloadJson: "{bad" }], scope, 1), /central_runtime_prefix_invalid/);
});

test("facts outside the declared Board prefix and duplicate IDs are rejected rather than filtered away", () => {
  const first = fact(1);
  assert.throws(() => readCentralRuntimeRecords([first], scope, 0), /central_runtime_prefix_invalid/);
  assert.throws(() => readCentralRuntimeRecords([first, { ...first, sequence: 2 }], scope, 2), /central_runtime_prefix_invalid/);
});

test("more than 256 bounded workset cycles retain exact archived operations, materials, ended intents and consumed sources", () => {
  const facts: RewardV2Fact[] = [];
  let previousRef = initialCentralRuntimeRef(scope);

  for (let index = 0; index < 300; index++) {
    const sourceRef = `source:${index}`, operation = { kind: "think" as const, operationId: `operation:${index}`, purpose: "Resolve the next grounded condition",
      expectedChange: "A source-specific answer", sourceRefs: [sourceRef] };
    const ended = { intentId: `intent:${index}`, subject: { plane: "agent" as const, domain: "prompt" as const, issueId: `issue:${index}` },
      goal: "Resolve this original condition", rationale: "A real source changed", conditions: [], knowledge: [], residual: [], commitment: {
        purpose: "Resolve the condition", assumptions: [], reconsiderWhen: [] }, revisionReason: "The source was answered", sourceRefs: [sourceRef],
      continuation: { kind: "ended" as const, goalState: "answered" as const, reason: "Original answer recorded" } };
    const state = { ...emptyCentralRuntimeState(scope), intents: [ended], completed: [{ intentId: ended.intentId, operation,
      outcome: "returned" as const, resultRefs: [`result:${index}`], publicResult: `The source-specific result ${index}` }],
      materials: [{ ref: `material:${index}`, kind: "knowledge" as const, text: `The grounded public result ${index}`, sourceRefs: [sourceRef] }], consumedSourceRefs: [sourceRef] };
    const next = { ...buildCentralRuntimeRecord({ previousRef, state, reason: "Compact only earlier archived completed work", sourceRefs: [sourceRef] }), sequence: index + 1 };

    facts.push(next);
    previousRef = next.id;
  }

  const read = readCentralRuntimeRecords(facts, scope, 300);

  assert.equal(read.state.completed.length, 1);
  assert.equal(read.state.materials.length, 1);
  assert.equal(read.state.intents.length, 1);
  assert.equal(read.history.operations.length, 300);
  assert.equal(read.history.materials.length, 300);
  assert.equal(read.history.endedIntents.length, 300);
  assert.equal(read.history.consumedSourceRefs.length, 300);
  assert.deepEqual(read.history.endedIntents[0]?.subject, { plane: "agent", domain: "prompt", issueId: "issue:0" });
  const original = lookupCentralRuntimeRecord(facts, scope, 300, { kind: "completed", operationId: "operation:0" });

  assert.equal(original.status, "found");
  if (original.status !== "found") return;

  assert.ok("operation" in original.value);
  assert.equal(read.history.operations[0]?.signature, centralOperationSignature({ ...original.value.operation, operationId: "renamed:old-operation" }),
    "an exact old computation remains identifiable after its workset receipt is compacted");
  assert.equal(lookupCentralRuntimeRecord(facts, scope, 300, { kind: "material", ref: "material:0", factRef: facts[0]!.id }).status, "found");
  assert.equal(lookupCentralRuntimeRecord(facts, scope, 300, { kind: "ended_intent", intentId: "intent:0" }).status, "found");
  assert.deepEqual(lookupCentralRuntimeRecord(facts, scope, 300, { kind: "completed", operationId: "operation:unknown" }), { status: "missing" });
});

test("exact snapshot lookup retains an earlier unknown receipt separately from its later returned revision", () => {
  const operation = { kind: "think" as const, operationId: "operation:late", purpose: "Resolve the condition", expectedChange: "An answer", sourceRefs: [] };
  const completed = { intentId: "intent:past", operation, outcome: "unknown" as const, resultRefs: [], publicResult: "The response was not confirmed" };
  const first = fact(1, { ...input(), state: { ...input().state, completed: [completed] } });
  const second = fact(2, { ...input(), previousRef: first.id, state: { ...input().state, completed: [{ ...completed,
    outcome: "returned", publicResult: "The original response returned", resultRefs: ["result:late"] }] } });
  const compact = fact(3, { ...input(), previousRef: second.id });
  const facts = [first, second, compact];
  const earlier = lookupCentralRuntimeRecord(facts, scope, 3, { kind: "completed", operationId: operation.operationId, factRef: first.id });
  const latest = lookupCentralRuntimeRecord(facts, scope, 3, { kind: "completed", operationId: operation.operationId });

  assert.equal(earlier.status, "found");
  assert.equal(latest.status, "found");

  if (earlier.status === "found" && latest.status === "found") {
    assert.ok("outcome" in earlier.value && "outcome" in latest.value);
    assert.equal(earlier.value.outcome, "unknown");
    assert.equal(latest.value.outcome, "returned");
  }
});
