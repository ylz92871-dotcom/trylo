import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowLearningRequest, WorkflowTrace } from "./trace-contracts.js";
import { compileWorkflow, learnWorkflow } from "./trace-learn.js";

const task = { scope: "project:branch-evidence", taskFamily: { id: "reports", intentClass: "summarize", checkKind: "acceptance" as const } };
const oldCheck = "node verify-v1.cjs";
const changedCheck = "node verify-v2.cjs";

function trace(traceId: string, format: string, check: string): WorkflowTrace {
  return { ...task, conditions: { format }, conditionEvidenceRefs: [`${traceId}:format`], schemaVersion: 1, traceId,
    source: "imported", outcome: "success", steps: [
      { nodeId: "read", input: "source", output: "rows", dependsOn: [], check: "node read.cjs", status: "passed", evidenceRefs: [`${traceId}:read`] },
      { nodeId: "summary", input: "rows", output: "report", dependsOn: ["read"], check, status: "passed", evidenceRefs: [`${traceId}:summary`] },
    ] };
}

function request(extra: readonly WorkflowTrace[] = []): WorkflowLearningRequest {
  return { ...task, requestId: "csv-check-change", parentVersionId: "parent", subsystem: "workflow", collect: true,
    correction: { reason: "CSV requires v2", nodeId: "summary", check: changedCheck, when: { format: "csv" } },
    budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 10000 },
    traces: [trace("csv-original", "csv", oldCheck), trace("json-only-success", "json", changedCheck), ...extra] };
}

test("a corrected branch never borrows matching graph evidence from another condition", () => {
  for (const compatibility of ["current", "legacy_correction"] as const) {
    const learned = learnWorkflow(request(), compatibility);

    assert.ok(learned.ok);
    const csv = compileWorkflow(learned.value, { ...task, conditions: { format: "csv" } }, 10000);

    assert.ok(csv.ok);
    assert.match(csv.value, /path evidence: no complete observation of this changed path yet/);
    assert.match(csv.value, /Original structure evidence: csv-original/);
    assert.doesNotMatch(csv.value, /json-only-success/);
  }
});

test("a corrected branch cites its own new observation while excluding another condition", () => {
  const learned = learnWorkflow(request([{ ...trace("csv-v2-observed", "csv", changedCheck), source: "runtime", workflowVersionId: "corrected" }]));
  assert.ok(learned.ok);
  const csv = compileWorkflow(learned.value, { ...task, conditions: { format: "csv" } }, 10000);
  assert.ok(csv.ok);
  assert.match(csv.value, /path evidence: csv-v2-observed/);
  assert.doesNotMatch(csv.value, /json-only-success/);
});
