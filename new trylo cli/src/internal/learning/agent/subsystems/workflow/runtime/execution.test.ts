import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowLearningArtifact } from "../domain/trace-contracts.js";
import { createWorkflowExecution } from "./execution.js";

const artifact: WorkflowLearningArtifact = {
  schemaVersion: 1, type: "workflow_learning", requestId: "r", scope: "project-a",
  taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" }, mode: "path",
  nodes: [
    { id: "prepare", input: "source.csv", output: "clean.csv", dependsOn: [], check: "node check-clean.mjs" },
    { id: "publish", input: "clean.csv", output: "report.json", dependsOn: ["prepare"], check: "node check-report.mjs" },
  ],
  recovery: [{ afterNode: "publish", goto: "prepare", lesson: "Normalize and retry", evidenceRefs: ["failed-before"] }],
  positiveEvidenceRefs: ["prior-success"], negativeEvidenceRefs: ["failed-before"], traces: [],
};
let ordinal = 0;

function event(kind: string, payload: JsonObject, overrides: Partial<Envelope> = {}): Envelope {
  ordinal += 1;
  return { protocolVersion: "0.0", eventId: `e-${ordinal}`, sequence: ordinal, timestamp: "2026-11-03T00:00:00.000Z",
    sessionId: "s", turnId: "t", producerId: "loop", producerSequence: 1, kind, payload, ...overrides };
}

function scenario() {
  return createWorkflowExecution({ artifact, versionId: "wfl_test", traceId: "trace" });
}

function checked(run: ReturnType<typeof scenario>, id: string, command: string, success = true) {
  run.observe(event("tool_use", { toolCallId: id, name: "run_shell", arguments: { command } }));
  run.observe(event("tool_result", success ? { toolCallId: id, status: "succeeded", value: { exitCode: 0 } }
    : { toolCallId: id, status: "failed", code: "shell_nonzero_exit" }));
}

function record(run: ReturnType<typeof scenario>, nodeId: string, checkToolCallId: string, recoveryTo?: string) {
  const node = artifact.nodes.find(node => node.id === nodeId)!;
  const actualInput = node.dependsOn.length === 1 ? [...run.trace().steps].reverse().find(step => step.nodeId === node.dependsOn[0] && step.status === "passed")?.output ?? node.input : node.input;
  return run.tools.execute({ name: "workflow_record_step", toolCallId: `record-${checkToolCallId}`,
    arguments: { nodeId, input: actualInput, output: node.output, checkToolCallId, ...(recoveryTo === undefined ? {} : { recoveryTo }) } }, new AbortController().signal);
}

test("learned run requires observed checks and dependencies, not completion or model claims", async () => {
  const run = scenario();

  run.observe(event("terminal", { reason: "completed" }));
  assert.equal(run.trace().outcome, "unknown");
  assert.equal((await record(run, "prepare", "invented")).outcome, "error");
  checked(run, "later", "node check-report.mjs");
  assert.equal((await record(run, "publish", "later")).outcome, "error");
  checked(run, "wrong", "node unrelated.mjs");
  assert.equal((await record(run, "prepare", "wrong")).outcome, "error");
});

test("observed failure follows frozen recovery and fresh rechecks support success", async () => {
  const run = scenario();

  checked(run, "p1", "node check-clean.mjs");
  assert.equal((await record(run, "prepare", "p1")).outcome, "result");
  checked(run, "f", "node check-report.mjs", false);
  assert.equal((await record(run, "publish", "f", "publish")).outcome, "error");
  assert.equal((await record(run, "publish", "f", "prepare")).outcome, "result");
  checked(run, "premature", "node check-report.mjs");
  assert.equal((await record(run, "publish", "premature")).outcome, "error");
  checked(run, "p2", "node check-clean.mjs");
  assert.equal((await record(run, "prepare", "p2")).outcome, "result");
  checked(run, "done", "node check-report.mjs");
  assert.equal((await record(run, "publish", "done")).outcome, "result");
  run.observe(event("terminal", { reason: "completed" }));
  const trace = run.trace();

  assert.equal(trace.outcome, "success");
  assert.equal(trace.steps.length, 4);
  assert.equal(trace.steps[1]?.status, "failed");
  assert.match(trace.steps[1]!.evidenceRefs[0]!, /s.*t.*f/);
  assert.equal((await record(run, "publish", "done")).outcome, "result", "redelivery of the same committed checkpoint is idempotent");
  assert.equal(run.trace().steps.length, 4);
});

test("child, foreign-turn and unpaired results cannot verify a node", async () => {
  const run = scenario();

  run.observe(event("turn_start", {}));

  for (const overrides of [{ producerId: "child" }, { turnId: "other" }]) {
    run.observe(event("tool_use", { toolCallId: "forged", name: "run_shell", arguments: { command: "node check-clean.mjs" } }, overrides));
    run.observe(event("tool_result", { toolCallId: "forged", status: "succeeded", value: { exitCode: 0 } }, overrides));
  }

  assert.equal((await record(run, "prepare", "forged")).outcome, "error");
  run.observe(event("tool_result", { toolCallId: "orphan", status: "succeeded", value: { exitCode: 0 } }));
  assert.equal((await record(run, "prepare", "orphan")).outcome, "error");
});

test("a checkpoint cannot reuse a checker started before a dependency or recovery changed", async () => {
  const run = scenario();

  checked(run, "stale", "node check-report.mjs");
  run.observe(event("tool_use", { toolCallId: "inflight", name: "run_shell", arguments: { command: "node check-report.mjs" } }));
  checked(run, "prepare", "node check-clean.mjs");
  assert.equal((await record(run, "prepare", "prepare")).outcome, "result");
  assert.equal((await record(run, "publish", "stale")).outcome, "error");
  run.observe(event("tool_result", { toolCallId: "inflight", status: "succeeded", value: { exitCode: 0 } }));
  assert.equal((await record(run, "publish", "inflight")).outcome, "error");
});

test("actual artifact references may vary while checker and recovery contracts stay frozen", async () => {
  const run = createWorkflowExecution({ artifact: { ...artifact, recovery: [
    { afterNode: "publish", lesson: "The corrected task has no automatic fallback", evidenceRefs: ["correction"] }, ...artifact.recovery,
  ] }, versionId: "wfl_corrected", traceId: "trace" });

  checked(run, "p", "node check-clean.mjs");
  const actual = await run.tools.execute({ name: "workflow_record_step", toolCallId: "actual", arguments: {
    nodeId: "prepare", input: "another-source.csv", output: "another-clean.csv", checkToolCallId: "p",
  } }, new AbortController().signal);

  assert.equal(actual.outcome, "result");
  assert.equal(run.trace().steps[0]?.output, "another-clean.csv");
  checked(run, "f", "node check-report.mjs", false);
  assert.equal((await record(run, "publish", "f", "prepare")).outcome, "error");
  assert.equal((await record(run, "publish", "f")).outcome, "result");
  assert.equal(run.trace().outcome, "failure");
});

test("intervening tool activity invalidates completed and in-flight checks before recording", async () => {
  for (const name of ["write_file", "read_file"]) {
    const run = scenario();

    checked(run, "stale-artifact", "node check-clean.mjs");
    run.observe(event("tool_use", { toolCallId: "intervening", name, arguments: { path: "clean.csv" } }));
    assert.equal((await record(run, "prepare", "stale-artifact")).outcome, "error");
    run.observe(event("tool_use", { toolCallId: "inflight-check", name: "run_shell", arguments: { command: "node check-clean.mjs" } }));
    run.observe(event("tool_use", { toolCallId: "another-intervening", name, arguments: { path: "clean.csv" } }));
    run.observe(event("tool_result", { toolCallId: "inflight-check", status: "succeeded", value: { exitCode: 0 } }));
    assert.equal((await record(run, "prepare", "inflight-check")).outcome, "error");
    checked(run, "fresh-artifact", "node check-clean.mjs");
    assert.equal((await record(run, "prepare", "fresh-artifact")).outcome, "result");
  }
});
