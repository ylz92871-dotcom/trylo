import assert from "node:assert/strict";
import test from "node:test";
import { boundWorkflowImprovementInventory } from "./improvement-inventory.js";
import { projectWorkflowImprovementFeedback } from "./improvement-feedback-evidence.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";

test("large multilingual inventories preserve whole evidence and process contracts within the tool response budget", () => {
  const evidence = Array.from({ length: 40 }, (_, index) => ({ ref: `actual:${index}`,
    kind: index === 39 ? "user_correction" as const : "tool_success" as const,
    summary: `${index}: ${"真实条件与结果".repeat(200)}` }));
  const available = Array.from({ length: 8 }, (_, index) => ({ versionId: `v:${index}`,
    process: { key: "discovery", inputContract: "完整输入".repeat(300), outputContract: "完整产物".repeat(300),
      sideEffects: "read_only", checkContract: "独立验收".repeat(300) } }));
  const value = boundWorkflowImprovementInventory({ available, evidence, recentIssues: [], uses: [] });

  assert.ok(new TextEncoder().encode(JSON.stringify(value)).length < 32_000);
  assert.ok(value.omitted.evidence > 0);
  assert.ok(value.omitted.available > 0);
  assert.equal(value.evidence[0]?.ref, "actual:39", "the current explicit correction remains visible before routine successes");

  for (const item of value.evidence) assert.deepEqual(item, evidence.find(original => original.ref === item.ref));

  for (const item of value.available) assert.deepEqual(item, available.find(original => original.versionId === item.versionId));

  assert.match(value.inventoryNote, /omitted premises are not satisfied/);
});

test("large feedback task context is abbreviated with provenance while independent process grade stays distinguishable", () => {
  const fixture = searchImprovementFixture();
  const task = { ...fixture.opportunity.task, process: { key: "long-contract", inputContract: "入".repeat(4096),
    outputContract: "出".repeat(4096), sideEffects: "read_only" as const, checkContract: "验".repeat(4096) } };
  const projected = projectWorkflowImprovementFeedback([{ feedbackId: "feedback:independent", useId: "use:actual", versionId: "version:actual",
    executionId: "session:actual/turn:actual", task, exposure: "reported_used", quality: "failed", evidenceRefs: ["receipt:actual"],
    followedStepIds: [], explanation: "The checker saw an incorrect output; this does not establish the process caused it.",
    processEvidence: { kind: "partial", checkerRef: "checker:independent", evidenceRefs: ["receipt:actual"], checkedStepIds: ["confirm-owner"] } }]);

  assert.ok(projected.ok);
  assert.equal(projected.value[0]?.kind, "quality_failure");
  const summary = JSON.parse(projected.value[0]!.summary);

  assert.equal(summary.taskContextAbbreviated, true);
  assert.equal(summary.processObservation.kind, "partial");
  assert.equal(summary.processObservation.source, "independent_host");
  assert.equal(summary.processObservation.checkedStepCount, 1);
  assert.equal(summary.modelReportedStepIdsAreNotProcessProof, true);
  assert.ok(projected.value[0]?.sourceVersionId);
});
