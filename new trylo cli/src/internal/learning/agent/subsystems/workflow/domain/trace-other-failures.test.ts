import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowTrace } from "./trace-contracts.js";
import { learnWorkflow } from "./trace-learn.js";
import { parseWorkflowTrace } from "./trace-parse.js";

const task = { scope: "project:operations", taskFamily: { id: "reports", intentClass: "build", checkKind: "acceptance" as const } };
const failure = { toolCallId: "failed-read", command: "node inspect-input.cjs", evidenceRef: "actual:failed-read" };

function trace(): WorkflowTrace {
  return { ...task, schemaVersion: 1, traceId: "operations-failed", source: "imported", outcome: "failure",
    steps: [{ nodeId: "build", input: "source", output: "report", dependsOn: [], check: "node verify.cjs", status: "passed", evidenceRefs: ["actual:verify"] }],
    otherFailures: [failure] };
}

test("failed non-check operations form evidenced lessons without a recommended success path", () => {
  const learned = learnWorkflow({ ...task, requestId: "operations", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 4, maxSteps: 16, maxTokens: 8000 }, traces: [trace()] });

  assert.ok(learned.ok);
  assert.equal(learned.value.mode, "lessons_only");
  assert.deepEqual(learned.value.recovery[0]?.evidenceRefs, ["operations-failed", "actual:failed-read"]);
  assert.equal(learned.value.branches?.[0]?.statistics.failedOperations, 1);
  assert.deepEqual(learned.value.negativeEvidenceRefs, ["operations-failed"]);
});

test("non-check failures survive normalization with actual receipt coordinates", () => {
  const parsed = parseWorkflowTrace(trace());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.otherFailures, [failure]);
});

test("malformed and duplicate non-check failure receipts fail closed", () => {
  assert.equal(parseWorkflowTrace({ ...trace(), otherFailures: [{ toolCallId: "x", evidenceRef: "r" }] }).ok, false);
  assert.equal(parseWorkflowTrace({ ...trace(), otherFailures: [failure, failure] }).ok, false);
});
