import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowImprovementReceipt, WorkflowImprovementEvidenceSnapshot } from "./improvement-contracts.js";
import { projectWorkflowImprovementEvidence } from "../adapters/improvement-evidence.js";
import { record } from "../domain/trace-parse.js";
import { runtimeFixture, resultRecord, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";

async function withFrozenUse(boardRoot: string, run: (fx: ReturnType<typeof runtimeFixture>, useId: string) => Promise<void>) {
  const fx = runtimeFixture(boardRoot);
  try {
    resultRecord(await fx.runtime.opportunity("learn", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const frozen = resultRecord(await fx.runtime.context("adopt", { task: fx.fixture.opportunity.task, boundary: "before the business phase" }));
    assert.ok(record(frozen.use));
    await run(fx, String(frozen.use.useId));
  } finally { await fx.runtime.close(); }
}

function event(sequence: number, turnId: string, kind: string, payload: JsonObject): SessionRecord {
  return { formatVersion: "1", sequence, sessionId: "session:contract", turnId, at: "2026-11-04T00:00:00.000Z", type: "envelope",
    payload: { envelope: { sessionId: "session:contract", turnId, producerId: "loop", kind, payload } } };
}

const receipt = (ref: string, sequence = 110, executionId = "session:contract/current", tool = "read_file"): WorkflowImprovementReceipt =>
  ({ ref, sequence, executionId, tool, toolCallId: ref, outcome: "succeeded" });
const report = (useId: string) => ({ useId, exposure: "reported_used", followedStepIds: ["confirm-owner"], explanation: "Self-reported process use; actual receipts do not independently prove it." });

test("omitted refs bind the durable feedback issuance despite a later old-turn result, and do not admit independent proof", async () => withImprovementBoard(async boardRoot => withFrozenUse(boardRoot, async (fx, useId) => {
  const projected = projectWorkflowImprovementEvidence([
    event(101, "old", "tool_use", { toolCallId: "old-read", name: "read_file", arguments: { path: "old.ts" } }),
    event(102, "current", "tool_use", { toolCallId: "current-read", name: "read_file", arguments: { path: "current.ts" } }),
    event(103, "current", "tool_result", { toolCallId: "current-read", status: "succeeded" }),
    event(104, "current", "tool_use", { toolCallId: "feedback-call", name: "workflow_learning", arguments: { operation: "feedback", report: report(useId) } }),
    event(105, "old", "tool_result", { toolCallId: "old-read", status: "succeeded" }),
  ], "session:contract");

  assert.ok(projected.ok);
  assert.equal(projected.value.executionId, "session:contract/old");
  fx.state.snapshot = projected.value;
  const result = resultRecord(await fx.runtime.feedback("feedback-call", report(useId)));
  assert.ok(record(result.feedback));
  assert.equal(result.feedback.executionId, "session:contract/current");
  assert.equal(result.feedback.evidenceBinding, "host_execution_window");
  assert.equal(result.feedback.evidenceCount, 1);
  assert.equal(result.feedback.quality, "unknown");
  assert.ok(record(result.feedback.processEvidence));
  assert.equal(result.feedback.processEvidence.kind, "unverified");
  assert.ok(record(result.reputation));
  assert.equal(result.reputation.processQualityPasses, 0);
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.deepEqual(view.value.feedback[0]?.evidenceRefs, ["session:session:contract/turn:current/tool:current-read"]);
  const again = await fx.runtime.feedback("feedback-call", report(useId));
  assert.equal(again.ok, false);

  if (!again.ok) assert.equal(again.code, "workflow_feedback_already_recorded");
})));

test("explicit refs and explicit empty refs remain compatible with hosts that provide no pending-hook metadata", async () => withImprovementBoard(async boardRoot => withFrozenUse(boardRoot, async (fx, useId) => {
  fx.state.snapshot = { ...fx.state.snapshot, executionId: "session:contract/observer", watermark: 120,
    receipts: [receipt("actual:chosen", 110, "session:contract/chosen"), receipt("actual:other", 115, "session:contract/other")] };
  const result = resultRecord(await fx.runtime.feedback("explicit", { ...report(useId), evidenceRefs: ["actual:chosen"] }));

  assert.ok(record(result.feedback));
  assert.equal(result.feedback.executionId, "session:contract/chosen");
  assert.equal(result.feedback.evidenceBinding, "explicit_refs");
  const frozen = resultRecord(await fx.runtime.context("next-use", { task: fx.fixture.opportunity.task, boundary: "later phase" }));
  assert.ok(record(frozen.use));
  const empty = resultRecord(await fx.runtime.feedback("empty-explicit", { ...report(String(frozen.use.useId)), evidenceRefs: [] }));

  assert.ok(record(empty.feedback));
  assert.equal(empty.feedback.evidenceCount, 0);
  assert.equal(empty.feedback.quality, "unknown");
})));

test("automatic binding refuses absent, wrong-operation, wrong-use and cross-turn ambiguous issuances without guessing the snapshot turn", async () => withImprovementBoard(async boardRoot => withFrozenUse(boardRoot, async (fx, useId) => {
  type Hooks = NonNullable<WorkflowImprovementEvidenceSnapshot["pendingHooks"]>;
  const hook = { toolCallId: "feedback-call", executionId: "session:contract/current", operation: "feedback" as const, useId };
  const cases: readonly (Hooks | undefined)[] = [undefined, [{ ...hook, operation: "context" }], [{ ...hook, useId: "another-use" }],
    [hook, { ...hook, executionId: "session:contract/older-open-call" }]];

  for (const pendingHooks of cases) {
    fx.state.snapshot = { evidence: fx.fixture.evidence, receipts: [receipt("actual:current")], watermark: 120, executionId: hook.executionId,
      ...(pendingHooks === undefined ? {} : { pendingHooks }) };
    const result = await fx.runtime.feedback("feedback-call", report(useId));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "workflow_feedback_issuance_unavailable");
  }

  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.feedback.length, 0);
})));

test("automatic reported-used feedback needs a current post-use business receipt and cannot use pre-use, workflow or another execution's receipts", async () => withImprovementBoard(async boardRoot => withFrozenUse(boardRoot, async (fx, useId) => {
  for (const receipts of [[], [receipt("pre-use", 99)], [receipt("hook-only", 110, "session:contract/current", "workflow_learning")],
    [receipt("other-execution", 110, "session:contract/other")]]) {
    fx.state.snapshot = { ...fx.state.snapshot, receipts, watermark: 120, executionId: "session:contract/current",
      pendingHooks: [{ toolCallId: "feedback-call", executionId: "session:contract/current", operation: "feedback", useId }] };
    const result = await fx.runtime.feedback("feedback-call", report(useId));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "workflow_feedback_receipts_unavailable");
  }

  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.feedback.length, 0);
})));
