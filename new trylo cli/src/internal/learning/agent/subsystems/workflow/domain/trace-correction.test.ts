import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowLearningRequest, WorkflowTrace } from "./trace-contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import { compileWorkflow, learnWorkflow } from "./trace-learn.js";
import { parseWorkflowLearningArtifact } from "./trace-parse.js";

const task = { scope: "project:correction", taskFamily: { id: "reports", intentClass: "summarize", checkKind: "acceptance" as const } };
const changedCheck = "node verify-owner-and-digest.cjs";

function trace(id: string, format: string, check = "node verify.cjs", outcome: "success" | "failure" = "success"): WorkflowTrace {
  return { ...task, conditions: { format }, conditionEvidenceRefs: [`${id}:format`], schemaVersion: 1, traceId: id, source: "imported", outcome,
    steps: [{ nodeId: "read", input: "source", output: "rows", dependsOn: [], check: "node read.cjs", status: "passed", evidenceRefs: [`${id}:read`] },
      { nodeId: "summary", input: "rows", output: "report", dependsOn: ["read"], check, status: outcome === "success" ? "passed" : "failed", evidenceRefs: [`${id}:summary`] }],
    cost: { tokens: 900, wallMs: 90 } };
}

function request(extra: readonly WorkflowTrace[] = []): WorkflowLearningRequest {
  return { ...task, requestId: "explicit-owner-check", parentVersionId: "parent", subsystem: "workflow", collect: true,
    correction: { reason: "CSV requires owner and digest", nodeId: "summary", check: changedCheck, when: { format: "csv" } },
    budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 10000 }, traces: [trace("old-csv", "csv"), trace("json", "json"), ...extra] };
}

test("explicit check change remains pending and old successes/costs support only the original structure", () => {
  const learned = learnWorkflow(request());

  assert.ok(learned.ok);
  const csv = learned.value.branches?.find(branch => branch.when.format === "csv");

  assert.equal(csv?.checkProvenance?.[0]?.status, "pending_execution");
  assert.deepEqual(csv?.checkProvenance?.[0]?.baseEvidenceRefs, ["old-csv"]);
  assert.deepEqual(csv?.positiveEvidenceRefs, []);
  assert.equal(csv?.statistics.samples, 0);
  assert.equal(csv?.statistics.totalTokens, 0);
  const compiled = compileWorkflow(learned.value, { ...task, conditions: { format: "csv" } }, 10000);

  assert.ok(compiled.ok);
  assert.match(compiled.value, /No actual execution evidence yet/);
  assert.match(compiled.value, /path evidence: no complete observation/);
  assert.match(compiled.value, /Original structure evidence: old-csv/);
  assert.ok(parseWorkflowLearningArtifact(learned.value).ok);
  assert.equal(parseWorkflowLearningArtifact({ ...learned.value, branches: learned.value.branches?.map(branch => branch.when.format !== "csv" ? branch
    : { ...branch, checkProvenance: branch.checkProvenance?.map(item => ({ ...item, status: "observed", observedTraceIds: ["forged"], passedTraceIds: ["forged"] })) }) }).ok, false);
});

test("real failed execution records adoption of the new check without claiming a pass", () => {
  const actual = { ...trace("failed-new-check", "csv", changedCheck, "failure"), source: "runtime" as const, workflowVersionId: "corrected", cost: { tokens: 700, wallMs: 70 } };
  const learned = learnWorkflow(request([actual]));

  assert.ok(learned.ok);
  const csv = learned.value.branches?.find(branch => branch.when.format === "csv");

  assert.equal(csv?.checkProvenance?.[0]?.status, "observed");
  assert.deepEqual(csv?.checkProvenance?.[0]?.observedTraceIds, ["failed-new-check"]);
  assert.deepEqual(csv?.checkProvenance?.[0]?.passedTraceIds, []);
  assert.deepEqual(csv?.positiveEvidenceRefs, []);
  assert.equal(csv?.statistics.totalTokens, 700);
});

test("matching actual passed execution supplies new-check evidence and measured cost", () => {
  const actual = { ...trace("passed-new-check", "csv", changedCheck), source: "runtime" as const, workflowVersionId: "corrected", cost: { tokens: 700, wallMs: 70 } };
  const learned = learnWorkflow(request([actual]));

  assert.ok(learned.ok);
  const csv = learned.value.branches?.find(branch => branch.when.format === "csv");

  assert.deepEqual(csv?.checkProvenance?.[0]?.passedTraceIds, ["passed-new-check"]);
  assert.deepEqual(csv?.positiveEvidenceRefs, ["passed-new-check"]);
  assert.equal(csv?.statistics.totalTokens, 700);
  assert.equal(learned.value.branches?.find(branch => branch.when.format === "json")?.checkProvenance, undefined);
});

test("legacy V2 correction assets retain their hash while dispatch discloses the missing evidence", () => {
  const old = learnWorkflow(request(), "legacy_correction");

  assert.ok(old.ok);
  const hash = contentHashOf(old.value);
  const restored = parseWorkflowLearningArtifact(old.value);

  assert.deepEqual(restored, old);
  assert.ok(restored.ok);
  assert.equal(contentHashOf(restored.value), hash);
  const compiled = compileWorkflow(restored.value, { ...task, conditions: { format: "csv" } }, 10000);

  assert.ok(compiled.ok);
  assert.match(compiled.value, /No actual execution evidence yet/);
  assert.match(compiled.value, /Legacy cost figures describe the original recipe/);
});
