import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CentralBudgetProjection } from "../../learning/control/central-budget-contract.js";
import type { CentralDeliberationPort, CentralDeliberationRequest, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralLearningIntentDraft, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeExecutionPort,
  CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { recordOperationResult } from "../../learning/central/runtime/transitions.js";
import { isCentralLearningIntent } from "../../learning/central/runtime/validation.js";
import { compactCentralWorkingSet } from "../../learning/central/runtime/working-set.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { centralReferenceSelectionCode } from "./change-reference-contract.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { semanticAttemptMaterial, semanticRecoveryAt, semanticRecoveryBlock, unresolvedSemanticAttempts } from "./runtime-recovery.js";
import { createCentralRuntimeStore } from "./runtime-store.js";

const scope = "workspace:open-continuation", sourceRef = "source:original-condition", freshRef = "source:actual-new-feedback";
const now = () => "2026-11-06T00:00:00.000Z";
const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "configuration:open-continuation",
  authorizationRef: "authorization:open-continuation", allowance: { schemaVersion: 2, unit: "total_model_tokens",
    maxTokens: 10000, maxCalls: 8, maxSteps: 8, maxPromptChars: 20000 } };
const originalThought: Extract<CentralLearningOperation, { kind: "think" }> = { kind: "think", operationId: "thought:original-commitment",
  purpose: "Compare the original uncertainty", expectedChange: "Record what the original evidence supports", sourceRefs: [sourceRef] };

function intent(continuation: CentralLearningIntentDraft["continuation"]): CentralLearningIntentDraft {
  return { intentId: "intent:original", subject: { plane: "agent", domain: "prompt", issueId: "issue:original" },
    goal: "Identify when the original method applies", rationale: "The original condition is unresolved", conditions: [], knowledge: [],
    residual: ["The transfer condition remains unknown"], commitment: { purpose: "Resolve the original uncertainty", assumptions: [], reconsiderWhen: [] },
    revisionReason: "The original source supports this question", sourceRefs: [sourceRef], continuation };
}

const sourceMaterial: CentralRuntimeMaterial = { ref: sourceRef, kind: "source", text: "The original receiver condition is unresolved.", sourceRefs: [] };

test("knowledge-only return leaves an open purpose quiet across restart; actual new same-subject feedback can select native dispatch", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "trylo-open-continuation-"));
  assert.equal(dirname(boardRoot), resolve(tmpdir()));
  const enabled = () => true, store = createCentralRuntimeStore({ boardRoot, enabled });
  const drivers: ReturnType<typeof createCentralLearningDriver>[] = [];

  try {
    const initial = await store.read(scope), original = intent({ kind: "ready", operation: originalThought });
    const seeded = await store.append({ expectedRevision: initial.revision, previousRef: initial.stateRef,
      state: { ...initial.state, intents: [original], materials: [sourceMaterial], consumedSourceRefs: [sourceRef] },
      reason: "original_ready_thought_committed", sourceRefs: [sourceRef] });

    assert.equal(seeded.status, "written");
    let changed = false, calls = 0;
    const source: CentralRuntimeSourcePort = { async snapshot() {
      const current = await store.read(scope);
      return { boardSequence: current.revision, opportunities: [], sourceRefs: changed ? [sourceRef, freshRef] : [sourceRef],
        materials: changed ? [sourceMaterial, { ref: freshRef, kind: "source" as const,
          text: "An actual later receiver returned a different condition.", sourceRefs: [] }] : [sourceMaterial],
        ...(changed ? { reconsider: [{ subject: original.subject, sourceRefs: [freshRef], reason: "The actual receiver premise changed" }] } : {}) };
    }, async read() { throw new Error("No read is selected in this bounded journey"); } };
    const semantic: CentralDeliberationPort = { async deliberate(request: CentralDeliberationRequest) {
      calls += 1;
      assert.equal(request.state.intents[0]?.continuation.kind, "open", "execution occupancy must not become a semantic facts wait");
      assert.equal(request.state.completed.find(row => row.operation.operationId === request.operation.operationId)?.outcome, "unknown");
      const view = createCentralLearningChangeView(request, [], "central-learning-change-input-v4");
      const target = view.dictionary.entries.find(row => row.kind === "intent" && view.dictionary.intent(row.handle)?.intentId === original.intentId);
      const selectedSource = view.dictionary.entries.find(row => row.ref === (calls === 1 ? sourceRef : freshRef)
        && view.dictionary.source(row.handle) !== undefined);
      const checkpoint = centralReferenceSelectionCode(view.dictionary);

      assert.ok(target);
      assert.ok(selectedSource);
      assert.ok(checkpoint);

      if (calls === 1) assert.equal(request.operation.operationId, originalThought.operationId);
      else {
        assert.equal(calls, 2);
        assert.ok(request.operation.operationId.startsWith("central-reconsider:"));
      }

      const set = calls === 1 ? { knowledge: [{ statement: "The original condition remains a bounded uncertainty.",
        conditions: "Only the original receiver was observed", sources: [selectedSource.handle] }] }
        : { next: { kind: "dispatch", purpose: "Investigate the actual changed receiver condition", expectedChange: "Test the remaining transfer premise",
          sources: [selectedSource.handle], allowance: { maxTokens: 100, maxCalls: 1, maxSteps: 1, maxPromptChars: 1000 } } };

      return decodeCentralDeliberation(compileCentralLearningChange({ checkpoint, changes: [{ kind: "revise", target: target.handle,
        why: calls === 1 ? "Record the actual limited finding" : "The new receiver evidence warrants native research", set }],
        explanation: "Preserve the original purpose and its actual evidence", sources: [selectedSource.handle] },
      request, view.dictionary, "central-learning-change-input-v4"), request, [], "central-learning-change-input-v4");
    } };
    const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No consult selected"); },
      async prepare() { throw new Error("This journey stops at the explicit dispatch commitment"); },
      async execute() { throw new Error("No worker is launched"); }, async recover() { return null; } };
    const create = () => { const driver = createCentralLearningDriver({ boardRoot, scope, enabled, now, source, deliberation: semantic, execution });
      drivers.push(driver);
    return driver; };
    const input: CentralLearningDriveInput = { scope, configuration, signal: new AbortController().signal,
      wake: { reason: "original_committed_work", sourceRefs: [sourceRef] }, publish() {} };
    const first = create();
    assert.equal((await first.drive(input)).state, "waiting");
    const returned = await store.read(scope);

    assert.equal(returned.state.intents[0]?.continuation.kind, "open");
    assert.equal(returned.state.intents[0]?.knowledge.length, 1);
    assert.equal(returned.state.completed.find(row => row.operation.operationId === originalThought.operationId)?.outcome, "returned");
    await first.close?.();
    const cold = create(), quiet = await cold.drive(input);

    assert.equal(calls, 1);
    assert.equal(quiet.reason, "central_open_without_committed_successor");
    assert.equal(quiet.wakeAt, undefined);
    changed = true; // The same normal drive now sees a genuinely different source, without a synthetic continuation request.
    assert.equal((await cold.drive(input)).state, "ready");
    assert.equal(calls, 2);
    const selected = (await store.read(scope)).state.intents[0];
    assert.ok(selected);
    assert.deepEqual(selected.subject, original.subject);
    assert.equal(selected.continuation.kind, "ready");

    if (selected.continuation.kind === "ready") {
      assert.equal(selected.continuation.operation.kind, "dispatch");
      assert.deepEqual(selected.continuation.operation.sourceRefs, [freshRef]);
    }
  } finally {
    await Promise.allSettled(drivers.map(driver => driver.close?.()));
    assert.equal(dirname(boardRoot), resolve(tmpdir()));
    await rm(boardRoot, { recursive: true, force: true });
  }
});

test("open is exact, late semantic results preserve explicit decisions, and compaction retains every unknown receipt dependency", () => {
  const opened = intent({ kind: "open" });
  assert.equal(isCentralLearningIntent(opened), true);
  assert.equal(isCentralLearningIntent({ ...opened, continuation: { kind: "open", wait: { kind: "facts", sourceRefs: [], reason: "mixed" } } }), false);
  assert.equal(isCentralLearningIntent({ ...opened, continuation: { kind: "open", operation: originalThought } }), false);
  const decisions: readonly CentralLearningIntentDraft[] = [intent({ kind: "waiting", wait: { kind: "facts",
    reason: "The model explicitly chose this condition after the old request", sourceRefs: [originalThought.operationId] } }),
  { ...opened, intentId: "intent:ended", continuation: { kind: "ended", goalState: "open", reason: "The model ended this investment" } },
  { ...opened, intentId: "intent:ready", continuation: { kind: "ready", operation: { ...originalThought, operationId: "thought:new-commitment",
    purpose: "Investigate a later receiver premise", sourceRefs: [freshRef] } } }];
  const unknown = { intentId: opened.intentId, operation: originalThought, outcome: "unknown" as const, resultRefs: [], publicResult: "Original response unconfirmed" };
  const lateState: CentralLearningRuntimeState = { ...emptyCentralRuntimeState(scope), intents: decisions, completed: [unknown] };
  const beforeLate = canonicalJson(lateState);
  const late = recordOperationResult(lateState, { intentId: opened.intentId, operation: originalThought,
    result: { outcome: "returned", resultRefs: ["delivery:actual-late"], publicResult: "The original public semantic decision returned" } });

  assert.equal(late.state.intents, decisions);
  assert.equal(late.state.intents[0], decisions[0]);
  assert.equal(late.state.completed[0]?.outcome, "returned");
  assert.equal(late.state.materials[0]?.ref, late.resultRef);
  assert.equal(late.state.intents.some(row => row.continuation.kind === "ready" && row.continuation.operation.operationId.startsWith("central-interpret:")), false);
  assert.equal(canonicalJson(lateState), beforeLate);

  const budget: CentralBudgetProjection = { budget: { schemaVersion: 1, budgetId: "budget:open-continuation", scope, unit: "total_model_tokens",
    limits: { tokens: 10000, calls: 8, steps: 8 }, authorizationRef: configuration.authorizationRef, mode: "exclusive_new_funding", openedAt: now(), openedSequence: 1 },
  occupied: { tokens: 40, calls: 1, steps: 1 }, available: { tokens: 9960, calls: 7, steps: 7 }, status: "available", historicalExternalGrantIds: [] };
  const empty = emptyCentralRuntimeState(scope), issuedAt = Date.parse(now());
  const attempt = semanticAttemptMaterial(empty, originalThought, issuedAt, 50);
  const block = semanticRecoveryBlock(originalThought.operationId, new CentralDeliberationError("central_deliberation_timeout", "unknown"),
    budget, configuration.configurationRef);
  const later = Array.from({ length: 20 }, (_, index) => ({ intentId: `intent:later-${index}`, outcome: "returned" as const,
    operation: { ...originalThought, operationId: `thought:later-${index}`, purpose: `A distinct later computation ${index}` },
    resultRefs: [`result:later-${index}`], publicResult: "A later computation returned" }));
  const newerBlock = semanticRecoveryBlock("thought:later-19", new CentralDeliberationError("central_deliberation_timeout", "unknown"), budget, configuration.configurationRef);
  const old: CentralLearningRuntimeState = { ...empty, intents: [opened], completed: [unknown, ...later],
    materials: [attempt, block, ...later.map((row): CentralRuntimeMaterial => ({ ref: row.resultRefs[0]!, kind: "knowledge",
      text: row.publicResult, sourceRefs: [] })), newerBlock] };
  const before = canonicalJson(old), compacted = compactCentralWorkingSet(old, { ...old });

  assert.ok(compacted.completed.some(row => row.operation.operationId === originalThought.operationId && row.outcome === "unknown"));
  assert.ok(compacted.materials.some(row => row.ref === attempt.ref));
  assert.ok(compacted.materials.some(row => row.ref === block.ref));
  assert.equal(unresolvedSemanticAttempts(compacted).length, 1);
  assert.equal(semanticRecoveryAt(compacted, issuedAt), undefined);
  assert.equal(canonicalJson(old), before);
});
