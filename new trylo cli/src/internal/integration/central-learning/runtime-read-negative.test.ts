import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import type { CentralLearningConfiguration, CentralLearningDriveInput, CentralLearningIntentDraft,
  CentralLearningOperation, CentralRuntimeExecutionPort } from "../../learning/central/runtime/contracts.js";
import type { TaskSourcePageReader } from "../learning-content/task-source-pages.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeSource, CentralRuntimeSourceError } from "./runtime-source.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { readOperationRefusal } from "./runtime-read-operation.js";

test("an original single-owner read refusal survives revised operation wording and cold compaction without blocking another purpose or swallowing hard failures", async t => {
  const parent = path.resolve(tmpdir()), boardRoot = await mkdtemp(path.join(parent, "trylo-read-refusal-"));
  const drivers: ReturnType<typeof createCentralLearningDriver>[] = [];

  t.after(async () => {
    for (const driver of drivers) await driver.close?.();
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    assert.ok(path.basename(boardRoot).startsWith("trylo-read-refusal-"));
    await rm(boardRoot, { recursive: true, force: true });
  });
  const scope = "workspace:read-negative", now = () => "2026-11-05T00:00:00.000Z";
  const badRef = "original-page:ambiguous:v1", goodRef = "original-page:other-purpose:v1", revisedRef = "original-page:ambiguous:v2";
  const crossOwnerRef = "original-page:two-owners:v1", ioRef = "original-page:io-failure:v1";
  const goodText = "The separate original purpose has an available source.", revisedText = "The original owner exposes a distinct, available version two.";
  const pageCalls: string[] = [], ioFailure = Object.assign(new Error("fixture_original_source_io_failure"), { code: "EIO" });
  const pageReader: TaskSourcePageReader = { async read(ref, signal, start = 0, maximumChars = 8192) {
    assert.equal(signal.aborted, false);
    pageCalls.push(ref);

    if (ref === badRef) return { ok: false, reason: "content_material_ambiguous" };

    if (ref === ioRef) throw ioFailure;

    const text = ref === goodRef ? goodText : ref === revisedRef ? revisedText : undefined;
    assert.ok(text);
    const end = Math.min(text.length, start + maximumChars);

    return { ok: true, value: { ref, originalRef: ref, originalScope: scope, owner: "board", origin: "execution_result",
      start, end, totalChars: text.length, text: text.slice(start, end), sourceHash: contentHashOf(text),
      coordinate: { runId: ref, sequence: ref === revisedRef ? 2 : 1 } } };
  } };
  const peer = () => ({
    async snapshot() { return { boardSequence: 0, opportunities: [], materials: [], sourceRefs: [] }; },
    owns(_scope: string, ref: string) { return ref === crossOwnerRef; },
    async read(): Promise<never> { throw new Error("A cross-owner collision must not select either source body"); },
  });
  let paidCalls = 0;
  const unexpected = async (): Promise<never> => { throw new Error("A local read contract cannot dispatch or consult a worker"); };
  const execution: CentralRuntimeExecutionPort = { consult: unexpected, prepare: unexpected, execute: unexpected, async recover() { return null; } };
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "config:original-read-contract",
    authorizationRef: "test-only:original-read-contract", allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 1000, maxCalls: 4, maxSteps: 4, maxPromptChars: 4000 } };
  const longRefs = Array.from({ length: 64 }, (_, index) => `original-page:${index}:` + "x".repeat(440));
  const batch = { kind: "read" as const, operationId: "read:bounded-negative-batch", purpose: "Read original addressed material",
    expectedChange: "Obtain the actual originals", sourceRefs: [], refs: longRefs, maximumChars: 8192 };
  const negative = readOperationRefusal({ scope, operation: batch, materials: [], history: { operations: [], materials: [], endedIntents: [], consumedSourceRefs: [] },
    error: new CentralRuntimeSourceError("content_material_missing") });
  assert.ok(negative);
  const bounded = JSON.parse(negative.result.publicResult);

  assert.equal(bounded.targetCount, 64);
  assert.equal(bounded.targets.length, 2);
  assert.ok(negative.result.publicResult.length < 2500);
  const changedBatch = readOperationRefusal({ scope, operation: { ...batch, refs: [...longRefs.slice(0, -1), "original-page:changed-last"] }, materials: [],
    history: { operations: [], materials: [], endedIntents: [], consumedSourceRefs: [] }, error: new CentralRuntimeSourceError("content_material_missing") });

  assert.ok(changedBatch);
  assert.notEqual(JSON.parse(changedBatch.result.publicResult).targetHash, bounded.targetHash,
    "all original targets, including ones omitted from the public representatives, determine the failure condition");
  const signal = new AbortController().signal;
  const input: CentralLearningDriveInput = { scope, configuration, signal,
    wake: { reason: "original_committed_read_program", sourceRefs: [] }, publish() {} };
  const createDriver = () => {
    const source = createCentralRuntimeSource({ boardRoot, scope, ports: [], enabled: () => true,
      pageReader, peerSources: [peer(), peer()] });
    const driver = createCentralLearningDriver({ boardRoot, scope, enabled: () => true, now, source, execution,
      deliberation: { async deliberate() {
        paidCalls += 1;
        throw new Error("No catalog or new source permits a paid interpretation in this case");
      } } });
    drivers.push(driver);
    return driver;
  };
  const read = (operationId: string, ref: string, purpose = "Read the original source for this purpose"): CentralLearningOperation => ({
    kind: "read", operationId, purpose, expectedChange: "Retain only the original available source body", sourceRefs: [], refs: [ref], maximumChars: 4096,
  });
  const intent = (id: string, operation: CentralLearningOperation): CentralLearningIntentDraft => ({
    intentId: id, subject: { plane: "agent", domain: "prompt", issueId: `issue:${id}` }, goal: `Keep original purpose ${id}`,
    rationale: "A committed local source read preserves this unresolved question", conditions: ["Use the original source owner"],
    knowledge: [], residual: ["The original uncertainty is still open"],
    commitment: { purpose: "Resolve this original question", assumptions: ["Only original source content can resolve it"], reconsiderWhen: ["A real source version or available path changes"] },
    revisionReason: "Test-only original committed program fixture; no model or publication claim", sourceRefs: [],
    continuation: { kind: "ready", operation },
  });
  const firstRead = read("read:original-ambiguous", badRef), otherRead = read("read:other-purpose", goodRef);
  const firstIntent = intent("purpose:original", firstRead), otherIntent = intent("purpose:other", otherRead);
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const replaceProgram = async (intents: readonly CentralLearningIntentDraft[], compact = false) => {
    const current = await store.read(scope);
    const saved = await store.append({ expectedRevision: current.revision, previousRef: current.stateRef,
      state: { ...current.state, intents, ...(compact ? { completed: [], materials: [] } : {}) },
      reason: "test_only_original_program_revision", sourceRefs: [] });
    assert.equal(saved.status, "written");
  };
  const initial = await store.read(scope);

  assert.deepEqual(initial.state, emptyCentralRuntimeState(scope));
  await replaceProgram([firstIntent, otherIntent]);
  const driver = createDriver();

  assert.equal((await driver.drive(input)).state, "ready", "the other original purpose remains runnable");
  const refused = await store.read(scope), failure = refused.state.completed.find(row => row.operation.operationId === firstRead.operationId);

  assert.ok(failure);
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.wait?.kind, "facts");
  const body = JSON.parse(failure.publicResult);

  assert.equal(body.schema, "central-read-failure/v1");
  assert.equal(canonicalJson(body), failure.publicResult);
  assert.equal(body.reason, "content_material_ambiguous");
  assert.deepEqual(body.alternatives, []);
  assert.deepEqual(body.targets.map((target: { readonly address: string }) => target.address), [badRef]);
  assert.ok(Object.hasOwn(body.targets[0], "version"));
  const retained = refused.state.intents.find(row => row.intentId === firstIntent.intentId)!;

  assert.equal(retained.goal, firstIntent.goal);
  assert.deepEqual(retained.residual, firstIntent.residual);
  assert.equal(retained.continuation.kind, "waiting");
  assert.ok((refused.history.readFailures ?? []).length > 0);
  assert.deepEqual(pageCalls, [badRef]);
  assert.equal(paidCalls, 0);
  await driver.close?.();

  // A compacted live workset cannot erase the original refusal. Only the public
  // program identity/prose changes here; the source address/condition does not.
  const renamedRead = read("read:renamed-operation", badRef, "Inspect the same original source using different wording");

  await replaceProgram([{ ...retained, revisionReason: "The same original read was reworded", continuation: { kind: "ready", operation: renamedRead } }, otherIntent], true);
  const cold = createDriver();

  assert.equal((await cold.drive(input)).state, "ready");
  const repeated = await store.read(scope);

  assert.equal(repeated.state.completed.find(row => row.operation.operationId === renamedRead.operationId), undefined,
    "an unchanged refused condition is not executed or recorded as a second failed observation");
  assert.equal(repeated.state.intents.find(row => row.intentId === firstIntent.intentId)?.continuation.kind, "waiting");
  assert.ok((repeated.history.readFailures ?? []).length > 0);
  assert.deepEqual(pageCalls, [badRef]);
  assert.equal(paidCalls, 0);
  assert.equal((await cold.drive(input)).state, "ready");
  const otherReturned = await store.read(scope);

  assert.equal(otherReturned.state.completed.find(row => row.operation.operationId === otherRead.operationId)?.outcome, "returned");
  assert.ok(otherReturned.state.materials.some(row => row.text.includes(goodText)));
  assert.deepEqual(pageCalls, [badRef, goodRef]);
  assert.equal(paidCalls, 0);
  await cold.close?.();

  const waitOther: CentralLearningIntentDraft = { ...otherIntent, continuation: { kind: "waiting", wait: {
    kind: "facts", reason: "The separate local read has returned; no interpretation is requested by this fixture", sourceRefs: [] } } };
  const versionTwo = read("read:original-real-version-two", revisedRef);

  await replaceProgram([{ ...retained, revisionReason: "The original owner exposes a different available source version",
    continuation: { kind: "ready", operation: versionTwo } }, waitOther]);
  const revised = createDriver();
  assert.equal((await revised.drive(input)).state, "ready");
  const available = await store.read(scope);

  assert.equal(available.state.completed.find(row => row.operation.operationId === versionTwo.operationId)?.outcome, "returned");
  assert.ok(available.state.materials.some(row => row.text.includes(revisedText)));
  assert.equal(paidCalls, 0);

  const crossRead = read("read:hard-owner-collision", crossOwnerRef);

  await replaceProgram([{ ...retained, revisionReason: "Inspect an independently addressed source with an owner collision",
    continuation: { kind: "ready", operation: crossRead } }, waitOther]);
  const beforeCross = await store.read(scope);

  await assert.rejects(revised.drive(input), error => error instanceof CentralRuntimeSourceError && error.reason === "central_runtime_source_ambiguous");
  assert.equal((await store.read(scope)).stateRef, beforeCross.stateRef, "a hard owner conflict must not become an ordinary refusal checkpoint");
  const ioRead = read("read:hard-original-io", ioRef);

  await replaceProgram([{ ...retained, revisionReason: "Inspect another source whose original read fails with IO",
    continuation: { kind: "ready", operation: ioRead } }, waitOther]);
  const beforeIo = await store.read(scope);

  await assert.rejects(revised.drive(input), error => error === ioFailure);
  assert.equal((await store.read(scope)).stateRef, beforeIo.stateRef, "unknown original IO must remain outside the ordinary negative-read contract");
  assert.equal(paidCalls, 0);
});
