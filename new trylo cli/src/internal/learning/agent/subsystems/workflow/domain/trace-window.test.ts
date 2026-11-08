import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowLearningRequest, WorkflowTrace } from "./trace-contracts.js";
import { learnWorkflow } from "./trace-learn.js";
import { parseWorkflowLearningArtifact, parseWorkflowLearningRequest } from "./trace-parse.js";
import { windowWorkflowHistory } from "./trace-window.js";

const task = { scope: "project:window", taskFamily: { id: "reports", intentClass: "build", checkKind: "acceptance" as const } };

function trace(id: string, format: string, outcome: "success" | "failure"): WorkflowTrace {
  return { ...task, schemaVersion: 1, traceId: id, source: "imported", outcome, conditions: { format }, conditionEvidenceRefs: [`${id}:format`],
    steps: [{ nodeId: "build", input: "source", output: "report", dependsOn: [], check: `node verify-${format}.cjs`,
      status: outcome === "success" ? "passed" : "failed", evidenceRefs: [`${id}:check`] }] };
}

function request(traces: readonly WorkflowTrace[], maxEpisodes = 4): WorkflowLearningRequest {
  return { ...task, requestId: "window", subsystem: "workflow", collect: true, parentVersionId: "previous",
    budget: { maxEpisodes, maxSteps: 32, maxTokens: 20000 }, traces };
}

test("a small allowance waits instead of silently discarding an ancestor condition", () => {
  const result = windowWorkflowHistory({ parentVersionId: "previous", request: request([], 3),
    history: [trace("csv-good", "csv", "success"), trace("csv-bad", "csv", "failure"), trace("json-good", "json", "success"), trace("json-bad", "json", "failure")] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "waiting_evidence_budget");
});

test("all externally nominated facts remain mandatory and omissions bind to the parent", () => {
  const raw = request([trace("explicit-a", "csv", "failure"), trace("explicit-b", "csv", "success")], 2);
  const selected = windowWorkflowHistory({ parentVersionId: "previous", request: raw, history: [trace("old", "csv", "success")] });

  assert.ok(selected.ok);
  assert.deepEqual(selected.value.traces.map(item => item.traceId), ["explicit-a", "explicit-b"]);
  assert.deepEqual(selected.value.evidenceWindow?.omittedRefs, [JSON.stringify(["previous", "old"])]);
  assert.equal(parseWorkflowLearningRequest(selected.value).ok, false);
  const learned = learnWorkflow(selected.value);

  assert.ok(learned.ok);
  assert.ok(parseWorkflowLearningArtifact(learned.value).ok);
  assert.equal(parseWorkflowLearningArtifact({ ...learned.value, evidenceWindow: { ...learned.value.evidenceWindow, retainedTraceIds: ["invented"] } }).ok, false);
});

test("one chat may contain distinct executions without collapsing their statistics", () => {
  const first = { ...trace("a", "csv", "success"), source: "runtime" as const, sessionId: "same-chat", executionId: "exec-a", workflowVersionId: "v" };
  const second = { ...trace("b", "csv", "success"), source: "runtime" as const, sessionId: "same-chat", executionId: "exec-b", workflowVersionId: "v" };
  const learned = learnWorkflow(request([first, second]));
  assert.ok(learned.ok);
  assert.equal(learned.value.branches?.[0]?.statistics.samples, 2);
});

test("conflicting immutable facts and duplicate explicit ids fail before windowing", () => {
  const original = trace("same", "csv", "success");
  assert.equal(windowWorkflowHistory({ parentVersionId: "previous", history: [original], request: request([{ ...original, outcome: "failure" }]) }).ok, false);
  assert.equal(windowWorkflowHistory({ parentVersionId: "previous", history: [], request: request([original, original]) }).ok, false);
});
