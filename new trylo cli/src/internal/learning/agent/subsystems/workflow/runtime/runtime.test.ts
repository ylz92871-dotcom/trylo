import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowLearningRequest, WorkflowTrace } from "../domain/trace-contracts.js";
import { compileWorkflow, learnWorkflow, selectWorkflowPath } from "../domain/trace-learn.js";
import { parseWorkflowLearningArtifact, parseWorkflowLearningRequest, parseWorkflowTrace } from "../domain/trace-parse.js";
import { runWorkflowLearning } from "./runtime.js";
import { readWorkflowVersion, saveWorkflowTrace, workflowFeedback } from "./archive.js";

const task = { scope: "project:fixture", taskFamily: { id: "document-build", intentClass: "validate_artifact", checkKind: "acceptance" as const, checkSchema: "json/v1" } };

function trace(id: string, outcome: "success" | "failure"): WorkflowTrace {
  return { ...task, schemaVersion: 1, traceId: id, source: "imported", outcome,
    steps: [{ nodeId: "build", input: "source", output: "artifact", dependsOn: [], check: "node check-build.cjs", status: "passed", evidenceRefs: [`${id}:build`] },
      { nodeId: "verify", input: "artifact", output: "report", dependsOn: ["build"], check: "node check-verify.cjs", status: outcome === "success" ? "passed" : "failed", evidenceRefs: [`${id}:verify`], ...(outcome === "failure" ? { recoveryTo: "build" } : {}) }] };
}

function request(traces: readonly WorkflowTrace[] = [trace("s1", "success"), trace("f1", "failure")]): WorkflowLearningRequest {
  return { ...task, requestId: "first", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 32, maxSteps: 128, maxTokens: 20000 }, traces };
}

const at = "2026-11-03T00:00:00.000Z";

test("all failures yield evidenced lessons, never a positive runnable path", () => {
  const learned = learnWorkflow(request([trace("f1", "failure"), trace("f2", "failure")]));

  assert.equal(learned.ok, true);

  if (!learned.ok) return;

  assert.equal(learned.value.mode, "lessons_only");
  assert.deepEqual(learned.value.positiveEvidenceRefs, []);
  assert.equal(learned.value.recovery.length, 2);
  assert.deepEqual(learned.value.recovery[0]?.evidenceRefs, ["f1", "f1:verify"]);
  const compiled = compileWorkflow(learned.value, task, 10000);

  assert.equal(compiled.ok, false);
});

test("same graph cannot merge families or weakened applicability premises", () => {
  const different = { ...trace("s2", "success"), taskFamily: { ...task.taskFamily, checkSchema: "json/v2" } };

  assert.equal(learnWorkflow(request([trace("s1", "success"), different])).ok, false);
  const learned = learnWorkflow(request());

  assert.ok(learned.ok);
  assert.equal(compileWorkflow(learned.value, { ...task, taskFamily: { ...task.taskFamily, id: "other" } }, 20000).ok, false);
  assert.equal(compileWorkflow(learned.value, { ...task, scope: "project:other" }, 20000).ok, false);
  assert.equal(compileWorkflow(learned.value, task, 1).ok, false);
});

test("trace parser rejects unmet dependencies, unsupported success, schema drift and forged derived graph", () => {
  assert.equal(parseWorkflowTrace({ ...trace("f", "failure"), outcome: "success" }).ok, false);
  const original = trace("s", "success");

  assert.equal(parseWorkflowTrace({ ...original, steps: [...original.steps].reverse() }).ok, false);
  assert.equal(parseWorkflowTrace({ ...original, schemaVersion: 2 }).ok, false);
  assert.equal(parseWorkflowLearningRequest({ ...request(), taskFamily: { ...task.taskFamily, checkSchema: 123 } }).ok, false);
  assert.equal(parseWorkflowTrace({ ...original, steps: [...original.steps, { ...original.steps[0], nodeId: "build", dependsOn: ["verify"] }] }).ok, false);
  const learned = learnWorkflow(request());

  assert.ok(learned.ok);
  assert.equal(parseWorkflowLearningArtifact({ ...learned.value, nodes: [] }).ok, false);
  // Board serialization may reorder object keys without changing the contract.
  const sorted = JSON.parse(JSON.stringify(learned.value, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  })) as unknown;

  assert.equal(parseWorkflowLearningArtifact(sorted).ok, true);
});

test("unknown fields cannot smuggle unsupported version or grant through the canonical trace", () => {
  assert.equal(parseWorkflowLearningRequest({ ...request(), subsystem: "tool" }).ok, false);
  assert.equal(parseWorkflowLearningRequest({ ...request(), budget: { maxEpisodes: 0, maxSteps: 1, maxTokens: 1 } }).ok, false);
  const malicious = trace("s", "success");
  assert.equal(parseWorkflowTrace({ ...malicious, steps: malicious.steps.map(step => ({ ...step, check: "skip_approval" })) }).ok, false);
  assert.equal(parseWorkflowLearningRequest(request([{ ...malicious, source: "runtime" }])).ok, false);
});

test("standalone round persists immutable Board version, feedback updates and correction changes next dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-learning-"));
  try {
    const first = await runWorkflowLearning({ boardRoot: root, request: request(), issuedAt: at });

    assert.ok(first.ok);
    const old = await readWorkflowVersion(root, first.value.versionId);

    assert.ok(old.ok);
    assert.deepEqual(old.value.positiveEvidenceRefs, ["s1"]);
    const feedback = { ...trace("actual-next", "failure"), source: "runtime" as const, workflowVersionId: first.value.versionId };
    const partial = { ...feedback, traceId: "partial-success", steps: [feedback.steps[0]!], outcome: "success" as const };

    assert.equal((await saveWorkflowTrace(root, partial, at)).ok, false);
    assert.ok((await saveWorkflowTrace(root, feedback, at)).ok);
    assert.equal((await workflowFeedback(root, first.value.versionId)).ok, true);
    const next = await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: { ...request([]), requestId: "corrected", parentVersionId: first.value.versionId,
      correction: { reason: "Require schema v2 check for this family", nodeId: "verify", check: "node check-verify-v2.cjs", recoveryTo: "build" } } });

    assert.ok(next.ok);
    assert.notEqual(first.value.versionId, next.value.versionId);
    const current = await readWorkflowVersion(root, next.value.versionId);

    assert.ok(current.ok);
    assert.equal(current.value.traces.length, 3);
    const compiled = compileWorkflow(current.value, task, 20000);

    assert.ok(compiled.ok);
    assert.match(compiled.value, /node check-verify-v2.cjs/);
    assert.deepEqual((await readWorkflowVersion(root, first.value.versionId)), old);
    const retry = await runWorkflowLearning({ boardRoot: root, request: request(), issuedAt: at });

    assert.deepEqual(retry, first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a correction can remove a prior recovery edge and still archive failed execution feedback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-correction-"));
  try {
    const first = await runWorkflowLearning({ boardRoot: root, request: request(), issuedAt: at });

    assert.ok(first.ok);
    const next = await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: { ...request([]), requestId: "no-recovery", parentVersionId: first.value.versionId,
      correction: { reason: "Inspect failure and stop this family instead of auto recovery", nodeId: "verify", check: "node check-verify.cjs" } } });

    assert.ok(next.ok);
    const feedback = { ...trace("no-recovery-failure", "failure"), source: "runtime" as const, workflowVersionId: next.value.versionId,
      steps: trace("x", "failure").steps.map(step => {
        const { recoveryTo: _removed, ...rest } = step;
        return rest;
      }) };

    assert.ok((await saveWorkflowTrace(root, feedback, at)).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collection off, cancellation and exhausted allowance do not create a Board", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-no-write-"));
  const root = path.join(parent, "never-created");

  try {
    assert.equal((await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: { ...request(), collect: false } })).ok, false);
    assert.equal((await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: request(), signal: AbortSignal.abort() })).ok, false);
    assert.equal((await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: { ...request(), budget: { maxEpisodes: 1, maxSteps: 1, maxTokens: 1 } } })).ok, false);
    await assert.rejects(readFile(path.join(root, "board-events.ndjson")), { code: "ENOENT" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("feedback binds the actually selected conditional branch rather than the canonical exemplar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-branch-feedback-"));
  try {
    const branches = ["json", "csv"].map(format => ({ ...trace(`success-${format}`, "success"), conditions: { format },
      conditionEvidenceRefs: [`intent:${format}`], steps: trace(`success-${format}`, "success").steps.map(step => ({
        ...step, check: `node check-${step.nodeId}-${format}.cjs`,
      })) }));
    const learned = await runWorkflowLearning({ boardRoot: root, request: request(branches), issuedAt: at });
    if (!learned.ok) throw new Error(learned.message);

    const parent = await readWorkflowVersion(root, learned.value.versionId);
    if (!parent.ok) throw new Error(parent.message);

    const alternate = parent.value.branches!.find(branch => branch.nodes[0]?.check !== parent.value.nodes[0]?.check)!;

    assert.ok(alternate, "fixture contains a branch different from the top-level exemplar");
    const selected = selectWorkflowPath(parent.value, { ...task, conditions: alternate.when });
    if (!selected.ok) throw new Error(selected.message);

    const feedback: WorkflowTrace = { ...task, schemaVersion: 1, traceId: "actual-alternate", source: "runtime", outcome: "success",
      workflowVersionId: learned.value.versionId, conditions: alternate.when, conditionEvidenceRefs: ["session:actual/input"], adoptedBranchId: alternate.id,
      steps: selected.value.artifact.nodes.map(node => ({ nodeId: node.id, input: node.input, output: node.output,
        dependsOn: node.dependsOn, check: node.check, status: "passed", evidenceRefs: [`actual:${node.id}`] })) };

    assert.equal((await saveWorkflowTrace(root, feedback, at)).ok, true, "a supported alternate branch must persist feedback");
    assert.equal((await saveWorkflowTrace(root, { ...feedback, traceId: "wrong-branch", adoptedBranchId: "unrelated-branch" }, at)).ok, false);
    assert.equal((await saveWorkflowTrace(root, { ...feedback, traceId: "wrong-check", steps: feedback.steps.map(step => ({ ...step, check: "node unrelated.cjs" })) }, at)).ok, false);
    const saved = await workflowFeedback(root, learned.value.versionId);

    assert.equal(saved.ok, true);

    if (saved.ok) assert.deepEqual(saved.value.map(trace => trace.adoptedBranchId), [alternate.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
