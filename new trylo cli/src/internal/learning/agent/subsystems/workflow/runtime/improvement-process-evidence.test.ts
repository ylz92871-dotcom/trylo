import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowProcessEvidence } from "../improvement/contracts.js";
import { resultRecord, runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";
import { record } from "../domain/trace-parse.js";

async function applyAssessedFeedback(boardRoot: string, processEvidence?: WorkflowProcessEvidence, followedStepIds: readonly string[] = ["confirm-owner", "scoped-search"]) {
  const fx = runtimeFixture(boardRoot, { assessQuality: async () => ({ ok: true, value: { quality: "passed",
    ...(processEvidence === undefined ? {} : { processEvidence }) } }) });
  try {
    resultRecord(await fx.runtime.opportunity("learn", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const use = resultRecord(await fx.runtime.context("use", { task: fx.fixture.opportunity.task, boundary: "before process" }));
    assert.ok(record(use.use));
    fx.state.snapshot = { ...fx.state.snapshot, executionId: "session:contract/turn:execution", watermark: 120, receipts: [
      { ref: "receipt:current", sequence: 110, executionId: "session:contract/turn:execution", toolCallId: "actual-check", tool: "run_shell", outcome: "succeeded", checkStatus: "passed" },
      { ref: "receipt:old", sequence: 90, executionId: "session:contract/turn:older", toolCallId: "old-check", tool: "run_shell", outcome: "succeeded", checkStatus: "passed" },
    ] };
    const result = await fx.runtime.feedback("observed", { useId: use.use.useId, exposure: "reported_used", evidenceRefs: ["receipt:current"],
      followedStepIds, explanation: "The independently selected checker evaluated this result." });
    const view = await fx.ports.store.read();
    assert.ok(view.ok);

    return { result, view: view.value };
  } finally { await fx.runtime.close(); }
}

test("product quality and a model's complete step list do not certify whole-process adherence", async () => withImprovementBoard(async boardRoot => {
  const { result } = await applyAssessedFeedback(boardRoot);
  const value = resultRecord(result);
  assert.ok(record(value.feedback));
  assert.ok(record(value.feedback.processEvidence));
  assert.equal(value.feedback.quality, "passed");
  assert.equal(value.feedback.processEvidence.kind, "unverified");
  assert.ok(record(value.reputation));
  assert.equal(value.reputation.qualityPasses, 1);
  assert.equal(value.reputation.processQualityPasses, 0);
  assert.equal(value.reputation.completeProcessUses, 0);
}));

test("independent partial process evidence can accompany product quality without promoting the whole workflow", async () => withImprovementBoard(async boardRoot => {
  const { result } = await applyAssessedFeedback(boardRoot, { kind: "partial", checkerRef: "checker:independent-path-v1",
    evidenceRefs: ["receipt:current"], checkedStepIds: ["confirm-owner"] }, []);
  const value = resultRecord(result);
  assert.ok(record(value.reputation));
  assert.equal(value.reputation.qualityPasses, 1);
  assert.equal(value.reputation.partialProcessUses, 1);
  assert.equal(value.reputation.processQualityPasses, 0);
}));

test("trusted whole-path evidence binds checked and actually skipped branches without requiring model labels", async () => withImprovementBoard(async boardRoot => {
  const { result } = await applyAssessedFeedback(boardRoot, { kind: "complete", checkerRef: "checker:independent-path-v1",
    evidenceRefs: ["receipt:current"], checkedStepIds: ["confirm-owner"], skippedStepIds: ["scoped-search"] }, []);
  const value = resultRecord(result);
  assert.ok(record(value.reputation));
  assert.equal(value.reputation.completeProcessUses, 1);
  assert.equal(value.reputation.processQualityPasses, 1);
  assert.notEqual(value.reputation.standing, "supported", "one admitted execution does not prove cross-task benefit");
}));

for (const [label, evidenceRefs, checkedStepIds] of [
  ["pre-adoption evidence", ["receipt:old"], ["confirm-owner", "scoped-search"]],
  ["incomplete coverage", ["receipt:current"], ["confirm-owner"]],
] as const) test(`host process claims reject ${label} rather than silently certifying the workflow`, async () => withImprovementBoard(async boardRoot => {
  const { result, view } = await applyAssessedFeedback(boardRoot, { kind: "complete", checkerRef: "checker:independent-path-v1",
    evidenceRefs, checkedStepIds, skippedStepIds: [] }, []);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "workflow_process_evidence_unbound");
  assert.equal(view.feedback.length, 0);
}));
