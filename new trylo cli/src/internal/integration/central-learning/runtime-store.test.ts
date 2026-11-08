import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { createCentralRuntimeStore, type CentralRuntimeAppend } from "./runtime-store.js";
import { saveCentralRuntimeCheckpoint } from "./runtime-checkpoint.js";

const scope = "scope:runtime-store";

async function directory(t: TestContext) {
  const base = testScratchPath("central-runtime-store-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.ok(!path.relative(base, root).startsWith(".."));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("reopening the original Board preserves the full runtime snapshot and rejects stale predecessors", async t => {
  const boardRoot = await directory(t), store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const before = await store.read(scope);
  const operation = { kind: "dispatch" as const, operationId: "op:running", purpose: "Resolve the condition", expectedChange: "A narrower method", sourceRefs: ["source:original"],
    allowance: { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 100, maxCalls: 1, maxSteps: 1, maxPromptChars: 1000 } };
  const state = { ...before.state, intents: [{ intentId: "intent:one", subject: { plane: "agent" as const, domain: "prompt" as const, issueId: "issue:one" },
    goal: "Resolve the condition", rationale: "A difference was observed", conditions: [], knowledge: [], residual: ["The missing condition"],
    commitment: { purpose: "Understand", assumptions: [], reconsiderWhen: ["Original result arrives"] }, revisionReason: "Initial intent", sourceRefs: ["source:original"],
    continuation: { kind: "ready" as const, operation } }], running: [{ intentId: "intent:one", operation, workRef: "work:one", frame: { originalStage: "stage:one" } }],
    completed: [{ intentId: "intent:one", operation: { kind: "think" as const, operationId: "op:previous", purpose: "Prior thought", expectedChange: "Clarify the gap", sourceRefs: [] },
      outcome: "returned" as const, publicResult: "The gap remains", resultRefs: ["result:one"] }],
    materials: [{ ref: "feedback:one", kind: "feedback" as const, text: "A delayed source correction", sourceRefs: ["source:original"] }],
    consumedSourceRefs: ["source:original"] };
  const saved = await store.append({ expectedRevision: before.revision, previousRef: before.stateRef, state, reason: "Persist correction", sourceRefs: ["source:original"] });

  assert.equal(saved.status, "written");
  if (saved.status !== "written") return;

  const reopened = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const restored = await reopened.read(scope);

  assert.equal(restored.revision, saved.revision);
  assert.equal(restored.stateRef, saved.stateRef);
  assert.deepEqual(restored.state, state);
  assert.deepEqual(await reopened.append({ expectedRevision: saved.revision, previousRef: before.stateRef,
    state, reason: "Old head must not branch", sourceRefs: [] }), { status: "stale" });
  const other = await reopened.read("scope:other");
  assert.deepEqual(other.state, emptyCentralRuntimeState("scope:other"));
  assert.equal(other.revision, saved.revision);

  const board = createRewardV2BoardPort(boardRoot, () => true), attempts: CentralRuntimeAppend[] = [];
  let competingFacts = 1, factIndex = 0;
  const racing = { async read(requestedScope: string) {
    const current = await reopened.read(requestedScope);

    if (competingFacts > 0) {
      competingFacts -= 1;
      const written = await board.append(current.revision, { id: `unrelated:${factIndex++}`, scope: "scope:unrelated",
        algorithmVersion: "original-unrelated-fact-v1", kind: "projection", payloadJson: "{}" });
      assert.equal(written.status, "written");
    }

    return current;
  }, async append(input: CentralRuntimeAppend) {
    attempts.push(input);
    return reopened.append(input);
  } };
  const rebased = await saveCentralRuntimeCheckpoint(racing, restored, state, "Same result after unrelated PA write", ["source:original"]);

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(row => row.expectedRevision), [restored.revision, restored.revision + 1]);
  const facts = attempts.map(({ expectedRevision: _revision, ...record }) => buildCentralRuntimeRecord(record));

  assert.deepEqual(facts[0], facts[1],
    "only physical CAS revision changes; original state, predecessor, fact and command identity stay fixed");
  assert.deepEqual(rebased.state, state);
  assert.equal(rebased.revision, restored.revision + 2);

  const headRecord = { previousRef: rebased.stateRef, state, reason: "An exact same checkpoint won elsewhere", sourceRefs: ["source:original"] };
  let headReads = 0, headAppends = 0;

  await assert.rejects(saveCentralRuntimeCheckpoint({ async read(requestedScope) {
    const current = await reopened.read(requestedScope);
    if (++headReads === 1) assert.equal((await reopened.append({ ...headRecord, expectedRevision: current.revision })).status, "written");
    return current;
  }, async append(input) {
    headAppends += 1;
    return reopened.append(input);
  } }, rebased, state, headRecord.reason, headRecord.sourceRefs), /central_runtime_head_changed/);
  assert.equal(headAppends, 1);
  assert.equal(headReads, 2, "even the identical winning payload changes the canonical head and stops resubmission");

  const committed = await reopened.read(scope), unknown = new Error("original_append_acknowledgement_lost");
  let unknownReads = 0, unknownAppends = 0;

  await assert.rejects(saveCentralRuntimeCheckpoint({ async read(requestedScope) {
    unknownReads += 1;
    return reopened.read(requestedScope);
  },

    async append(input) {
      unknownAppends += 1;
      assert.equal((await reopened.append(input)).status, "written");
      throw unknown;
    },
  }, committed, state, "Original write with lost acknowledgement", []), error => error === unknown);
  assert.equal(unknownReads, 1);
  assert.equal(unknownAppends, 1, "a thrown unknown acknowledgement is never reread or retried");

  const exhausted = await reopened.read(scope), beforeExhaustion = attempts.length;
  competingFacts = 4;
  await assert.rejects(saveCentralRuntimeCheckpoint(racing, exhausted, state, "Only four mechanical CAS submissions", []), /central_runtime_write_stale/);
  assert.equal(attempts.length - beforeExhaustion, 4);
  assert.equal((await reopened.read(scope)).stateRef, exhausted.stateRef);
});

test("concurrent writers at the same prefix commit exactly one head through the original CAS", async t => {
  const boardRoot = await directory(t), store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const before = await store.read(scope);
  const results = await Promise.allSettled(["a", "b"].map(label => createCentralRuntimeStore({ boardRoot, enabled: () => true }).append({
    expectedRevision: before.revision, previousRef: before.stateRef, state: { ...before.state, consumedSourceRefs: [label] }, reason: label, sourceRefs: [label] })));

  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.status === "written").length, 1);

  for (const result of results) {
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof Error);
      assert.equal(result.reason.message, "multi_writer", "the original lock reports contention explicitly");
    } else assert.ok(result.value.status === "written" || result.value.status === "stale");
  }

  const after = await store.read(scope);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.state.consumedSourceRefs.length, 1);
});

test("disabled runtime operations perform zero filesystem I/O and never materialize a Board", async t => {
  const base = await directory(t), boardRoot = path.join(base, "must-not-exist"), store = createCentralRuntimeStore({ boardRoot, enabled: () => false });
  await assert.rejects(store.read(scope), /collect_disabled/);
  await assert.rejects(store.append({ expectedRevision: 0, previousRef: "unused", state: emptyCentralRuntimeState(scope), reason: "unused", sourceRefs: [] }), /collect_disabled/);
  await assert.rejects(store.lookup(scope, { kind: "material", ref: "unused" }), /collect_disabled/);
  await assert.rejects(access(boardRoot), { code: "ENOENT" });
});

test("a corrupt runtime head in the original opaque facts is surfaced and cannot be overwritten", async t => {
  const boardRoot = await directory(t), port = createRewardV2BoardPort(boardRoot, () => true);
  await port.append(0, { id: "bad:runtime", scope, algorithmVersion: "central-learning-runtime-v1", kind: "projection", payloadJson: "{}" });
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  await assert.rejects(store.read(scope), /central_runtime_record_corrupt/);
  await assert.rejects(store.append({ expectedRevision: 1, previousRef: "bad:runtime", state: emptyCentralRuntimeState(scope), reason: "Attempt overwrite", sourceRefs: [] }), /central_runtime_record_corrupt/);
  assert.equal((await port.read()).revision, 1);
});

test("compacted snapshots retain exact lookup and reject historical identity corruption before committing", async t => {
  const boardRoot = await directory(t), store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const operation = { kind: "think" as const, operationId: "op:archived", purpose: "Grounded question", expectedChange: "A public answer", sourceRefs: ["source:old"] };
  const state = { ...emptyCentralRuntimeState(scope), completed: [{ intentId: "intent:old", operation, outcome: "returned" as const,
    publicResult: "Original public answer", resultRefs: ["answer:old"] }],
    materials: [{ ref: "material:old", kind: "knowledge" as const, text: "Original knowledge", sourceRefs: ["source:old"] }], consumedSourceRefs: ["source:old"] };
  const first = await store.read(scope);
  const wrote = await store.append({ expectedRevision: first.revision, previousRef: first.stateRef, state, reason: "Record original result before compaction", sourceRefs: ["source:old"] });

  assert.equal(wrote.status, "written");
  if (wrote.status !== "written") return;

  await store.append({ expectedRevision: wrote.revision, previousRef: wrote.stateRef, state: emptyCentralRuntimeState(scope), reason: "Compact archived workset", sourceRefs: [] });
  const compact = await store.read(scope);
  assert.equal(compact.state.completed.length, 0);
  assert.equal(compact.history.operations.length, 1);
  assert.deepEqual(compact.history.consumedSourceRefs, ["source:old"]);
  const found = await store.lookup(scope, { kind: "material", ref: "material:old", factRef: wrote.stateRef });

  assert.equal(found.status, "found");
  if (found.status === "found") assert.deepEqual(found.value, state.materials[0]);

  await assert.rejects(store.append({ expectedRevision: compact.revision, previousRef: compact.stateRef, state: { ...state,
    completed: [{ ...state.completed[0]!, operation: { ...operation, purpose: "Silently changed old operation" } }] }, reason: "Attempt historical rewrite", sourceRefs: [] }), /central_runtime_operation_identity_conflict/);
  assert.equal((await store.read(scope)).stateRef, compact.stateRef, "invalid history never poisons the original Board chain");
});

test("a persistent snapshot cannot delete an unfinished intent even if the caller omits its entire workset", async t => {
  const boardRoot = await directory(t), store = createCentralRuntimeStore({ boardRoot, enabled: () => true }), before = await store.read(scope);
  const intent = { intentId: "intent:unfinished", subject: { plane: "agent" as const, domain: "prompt" as const, issueId: "issue:unfinished" },
    goal: "Original unresolved goal", rationale: "Original evidence", conditions: [], knowledge: [], residual: ["Original unknown"], commitment: {
      purpose: "Keep the goal", assumptions: [], reconsiderWhen: [] }, revisionReason: "Initial", sourceRefs: [],
    continuation: { kind: "waiting" as const, wait: { kind: "facts" as const, reason: "Missing original evidence", sourceRefs: [] } } };
  const saved = await store.append({ expectedRevision: before.revision, previousRef: before.stateRef,
    state: { ...before.state, intents: [intent] }, reason: "Retain original unresolved intent", sourceRefs: [] });

  assert.equal(saved.status, "written");
  if (saved.status !== "written") return;

  await assert.rejects(store.append({ expectedRevision: saved.revision, previousRef: saved.stateRef, state: emptyCentralRuntimeState(scope),
    reason: "Unsafe compaction", sourceRefs: [] }), /central_runtime_unfinished_intent_removed/);
  assert.deepEqual((await store.read(scope)).state.intents, [intent]);
});
