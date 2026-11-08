import assert from "node:assert/strict";
import test from "node:test";
import { commitWorkflowImprovementRecord } from "../adapters/improvement-board.js";
import { parseWorkflowImprovementFeedback } from "../improvement/index.js";
import { resultRecord, runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";
import { record } from "../domain/trace-parse.js";
import type { WorkflowImprovementProposal } from "../improvement/contracts.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";

test("an operator harm assessment becomes source-bound correction evidence and a changed procedure on the same issue", async () => withImprovementBoard(async boardRoot => {
  const fixture = searchImprovementFixture();
  let calls = 0;
  const fx = runtimeFixture(boardRoot, { newModel: () => {
    let sent = 0;
    return { async propose(input) {
      sent += 1;
      calls += 1;

      if (calls === 1) return { ok: true, value: fixture.proposal };

      const assessment = input.evidence.find(item => item.ref === "operator:actual-harm");

      assert.equal(assessment?.kind, "user_correction");
      assert.ok(assessment?.sourceVersionId);
      assert.match(assessment.summary, /operator user judged this adoption harmful/);
      assert.equal(input.parent?.proposal.procedure.steps[0]?.action, fixture.proposal.procedure.steps[0]!.action);
      const action = "Inspect the current generator receipt before confirming that the cached owner still exists.";
      const proposal: WorkflowImprovementProposal = { ...fixture.proposal,
        diagnosis: { hypothesis: "The cached owner may refer to output that was never generated.", supportingRefs: [assessment.ref],
          counterEvidenceRefs: [], alternatives: ["The owner may have moved after generation."], discriminateBy: ["Inspect generation status and current ownership before choosing a search scope."] },
        procedure: { ...fixture.proposal.procedure, steps: fixture.proposal.procedure.steps.map((step, index) => index === 0 ? { ...step, action } : step) },
        changes: [{ kind: "replace", stepIds: ["confirm-owner"], before: fixture.proposal.procedure.steps[0]!.action, after: action,
          rationale: "The user's harm report challenges unconditional reuse; probe the alternative cause first.", evidenceRefs: [assessment.ref], expectedEffect: "Avoid repeating search for an output absent in this case." }] };

      return { ok: true, value: proposal };
    }, usage: () => ({ calls: sent, tokens: sent * 100, observedTokens: sent * 100, uncertain: false }) };
  } });

  try {
    resultRecord(await fx.runtime.opportunity("first-proposal", fixture.opportunity));
    await fx.runtime.settlePending();
    const frozen = resultRecord(await fx.runtime.context("first-use", { task: fixture.opportunity.task, boundary: "source investigation" }));

    assert.ok(record(frozen.use));
    fx.state.snapshot = { ...fx.state.snapshot, executionId: "session:contract/turn:application", watermark: 120,
      receipts: [{ ref: "receipt:application", sequence: 110, executionId: "session:contract/turn:application",
        toolCallId: "read-owner", tool: "read_file", outcome: "succeeded" }] };
    resultRecord(await fx.runtime.feedback("application-report", { useId: frozen.use.useId,
      exposure: "reported_used", evidenceRefs: ["receipt:application"], followedStepIds: ["confirm-owner"], explanation: "The owner assumption did not help this case." }));
    const reported = await fx.ports.store.read();
    assert.ok(reported.ok);
    const base = parseWorkflowImprovementFeedback(reported.value.feedback[0]);
    assert.ok(base.ok);
    const assessment = parseWorkflowImprovementFeedback({ ...base.value, feedbackId: "operator:actual-harm", quality: "unknown",
      evidenceRefs: [], followedStepIds: [], explanation: "The user says the saved procedure hindered this case.",
      userAssessment: { judgment: "harmed", evidenceRef: "operator-choice:actual-harm" } });

    assert.ok(assessment.ok);
    const saved = await commitWorkflowImprovementRecord(boardRoot, { type: "workflow_improvement_feedback", schemaVersion: 1,
      feedback: assessment.value }, new Date(fx.options.now()).toISOString());
    assert.ok(saved.ok);
    const observed = resultRecord(await fx.runtime.context("inspect-correction", {}));
    assert.ok(Array.isArray(observed.evidence));
    assert.equal(observed.evidence.find(item => record(item) && item.ref === assessment.value.feedbackId)?.kind, "user_correction");
    const changed = await fx.runtime.opportunity("revise-after-user-feedback", { ...fixture.opportunity,
      trigger: "user_correction", problem: "The user reported that unconditional owner reuse harmed this case.",
      evidenceRefs: [assessment.value.feedbackId] });

    resultRecord(changed);
    await fx.runtime.settlePending();
    const view = await fx.ports.store.read();
    assert.ok(view.ok);
    assert.equal(view.value.versions.length, 2);
    assert.equal(view.value.versions[1]!.artifact.parentVersionId, view.value.versions[0]!.versionId);
    assert.equal(view.value.versions[1]!.artifact.proposal.diagnosis.supportingRefs[0], assessment.value.feedbackId);
    assert.ok(view.value.versions[1]!.artifact.evidence.find(item => item.ref === assessment.value.feedbackId)?.sourceVersionId);
    const next = resultRecord(await fx.runtime.context("next-use", { task: fixture.opportunity.task, boundary: "next investigation" }));

    assert.equal(next.status, "frozen");
    assert.match(String(next.guidance), /Inspect the current generator receipt/);
    assert.equal(calls, 2);
  } finally { await fx.runtime.close(); }
}));
