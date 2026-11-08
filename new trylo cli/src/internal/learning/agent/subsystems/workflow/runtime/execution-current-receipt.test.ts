import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { WorkflowLearningArtifact } from "../domain/trace-contracts.js";
import { createWorkflowExecution } from "./execution.js";
import { parseWorkflowTrace } from "../domain/trace-parse.js";
import { learnWorkflow } from "../domain/trace-learn.js";

const artifact: WorkflowLearningArtifact = { schemaVersion: 1, type: "workflow_learning", requestId: "r", scope: "project",
  taskFamily: { id: "report", intentClass: "report", checkKind: "acceptance" }, mode: "path",
  nodes: [{ id: "prepare", input: "source.csv", output: "clean.csv", dependsOn: [], check: "node check-clean.mjs" },
    { id: "publish", input: "clean.csv", output: "report.json", dependsOn: ["prepare"], check: "node check-report.mjs" }],
  recovery: [{ afterNode: "publish", goto: "prepare", lesson: "Normalize again", evidenceRefs: ["prior-failure"] }],
  positiveEvidenceRefs: ["prior-success"], negativeEvidenceRefs: ["prior-failure"], traces: [] };

function fixture(frozen = artifact) {
  const records: SessionRecord[] = [];
  const input = { artifact: frozen, versionId: "wfl_frozen", traceId: "feedback", sessionId: "s" };
  const run = createWorkflowExecution(input), committed = createWorkflowExecution(input);
  let sequence = 0, call = 0;

  function emit(kind: string, payload: JsonObject, acknowledge = true, turnId = "t") {
    sequence += 1;
    const envelope: Envelope = { protocolVersion: "0.0", eventId: `e-${sequence}`, sequence, producerSequence: sequence,
      producerId: "loop", sessionId: "s", turnId, timestamp: "2026-11-03T00:00:00.000Z", kind, payload };
    run.observe(envelope);
    if (acknowledge) acknowledgeEnvelope(envelope);
    return envelope;
  }

  function acknowledgeEnvelope(envelope: Envelope) {
    records.push({ formatVersion: "1", sequence: records.length + 1, type: "envelope", at: envelope.timestamp,
      sessionId: "s", turnId: envelope.turnId!, payload: { envelope: { ...envelope } } });
    committed.observeCommitted(envelope);
  }

  function check(id: string, command: string, passed = true) {
    emit("tool_use", { name: "run_shell", toolCallId: id, arguments: { command } });
    emit("tool_result", { toolCallId: id, status: passed ? "succeeded" : "failed", value: { exitCode: passed ? 0 : 1 } });
  }

  async function tool(name: string, args: JsonObject, acknowledge = true) {
    const toolCallId = `record-${++call}`;
    emit("tool_use", { name, toolCallId, arguments: args });
    const result = await run.tools.execute({ name, toolCallId, arguments: args }, new AbortController().signal);
    const receipt = result.outcome === "result"
      ? emit("tool_result", { toolCallId, status: "succeeded", value: result.value }, acknowledge) : undefined;
    return { result, receipt };
  }

  emit("turn_start", {});

  return { run, committed, records, input, emit, check, tool, acknowledgeEnvelope };
}

const prepare = { nodeId: "prepare", input: "actual-source.csv", output: "actual-clean.csv" };

test("a fresh exact check binds without a model-visible ID and progress exposes only safe current receipts", async () => {
  const fx = fixture();
  fx.check("actual-provider-id", artifact.nodes[0]!.check);
  const progress = await fx.tool("workflow_progress", {});

  assert.equal(progress.result.outcome, "result");

  if (progress.result.outcome === "result") assert.deepEqual(progress.result.value.availableChecks,
    [{ toolCallId: "actual-provider-id", command: artifact.nodes[0]!.check, status: "passed" }]);

  const wrong = await fx.tool("workflow_record_step", { ...prepare, checkToolCallId: "historical-id" });

  assert.equal(wrong.result.outcome, "error");

  if (wrong.result.outcome === "error") assert.match(wrong.result.message, /actual-provider-id/);

  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  assert.deepEqual(fx.run.trace().steps[0]?.evidenceRefs, ["session:s/turn:t/tool:actual-provider-id"]);
  assert.deepEqual(fx.run.progress().availableChecks, []);
});

test("automatic binding still requires the exact fresh settled check and cannot borrow torn or stale evidence", async () => {
  for (const mode of ["absent", "wrong-command", "inflight", "intervening", "cross-turn"] as const) {
    const fx = fixture();

    if (mode === "wrong-command") fx.check("wrong", "node some-other-check.mjs");

    if (mode === "inflight") fx.emit("tool_use", { name: "run_shell", toolCallId: "pending", arguments: { command: artifact.nodes[0]!.check } });

    if (mode === "intervening" || mode === "cross-turn") {
      fx.check("old", artifact.nodes[0]!.check);
      if (mode === "intervening") fx.emit("tool_use", { name: "read_file", toolCallId: "read", arguments: { path: "clean.csv" } });
      else fx.emit("turn_start", {}, true, "next");
    }

    const result = await fx.tool("workflow_record_step", prepare);

    assert.equal(result.result.outcome, "error", mode);
    assert.equal(fx.run.trace().steps.length, 0);
  }
});

test("automatically bound failed checks still enforce frozen recovery and fresh dependencies", async () => {
  const fx = fixture();
  fx.check("clean", artifact.nodes[0]!.check);
  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  fx.check("failed", artifact.nodes[1]!.check, false);
  const publish = { nodeId: "publish", input: "actual-clean.csv", output: "actual-report.json" };

  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "error");
  assert.equal((await fx.tool("workflow_record_step", { ...publish, recoveryTo: "prepare" })).result.outcome, "result");
  assert.equal(fx.run.trace().steps[1]?.status, "failed");
  fx.check("too-early", artifact.nodes[1]!.check);
  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "error");
  fx.check("clean-again", artifact.nodes[0]!.check);
  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  fx.check("passed", artifact.nodes[1]!.check);
  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "result");
  fx.emit("terminal", { reason: "completed" });
  assert.equal(fx.committed.trace().outcome, "success");
});

test("automatic receipt binding replays original committed facts and exposes a checkpoint only after its ack", async () => {
  const fx = fixture();
  fx.check("real-check", artifact.nodes[0]!.check);
  await fx.tool("workflow_progress", {});
  const result = await fx.tool("workflow_record_step", prepare, false);

  assert.equal(result.result.outcome, "result");
  assert.equal(fx.run.trace().steps.length, 1);
  assert.equal(fx.committed.trace().steps.length, 0);
  assert.ok(result.receipt);
  fx.acknowledgeEnvelope(result.receipt);
  assert.equal(fx.committed.trace().steps.length, 1);
  const replayed = createWorkflowExecution({ ...fx.input, resumeRecords: fx.records });

  assert.deepEqual(replayed.trace().steps, fx.committed.trace().steps);
  assert.deepEqual(replayed.progress().availableChecks, []);
});

test("auxiliary failures survive intervening tools without vetoing a completely verified frozen path", async () => {
  const fx = fixture();
  fx.check("unrecorded-failure", "node dependency-probe.cjs", false);
  fx.emit("tool_use", { name: "read_file", toolCallId: "inspection", arguments: { path: "source.csv" } });
  fx.check("clean", artifact.nodes[0]!.check);
  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  fx.check("report", artifact.nodes[1]!.check);
  assert.equal((await fx.tool("workflow_record_step", { nodeId: "publish", input: "actual-clean.csv", output: "actual-report.json" })).result.outcome, "result");
  fx.emit("terminal", { reason: "completed" });
  assert.equal(fx.run.trace().outcome, "success", "a helper failure cannot replace the frozen path's actual checks");
  const expected = [{ toolCallId: "unrecorded-failure", command: "node dependency-probe.cjs", evidenceRef: "session:s/turn:t/tool:unrecorded-failure" }];

  assert.deepEqual(fx.run.trace().otherFailures, expected);
  const replayed = createWorkflowExecution({ ...fx.input, resumeRecords: fx.records });

  assert.deepEqual(replayed.trace().otherFailures, expected);
  fx.check("dependency-recheck", "node dependency-probe.cjs");
  fx.emit("terminal", { reason: "completed" });
  assert.equal(fx.run.trace().outcome, "success");
  assert.deepEqual(fx.run.trace().otherFailures, expected, "a recovered failure remains negative evidence");
  assert.equal(fx.run.trace().steps.length, 2, "a receipt never infers a node checkpoint");
});

test("all-failed auxiliary receipts without passed nodes produce lessons and no supported positive path", () => {
  const fx = fixture();
  fx.check("failed-helper", "node inspect-input.cjs", false);
  fx.emit("terminal", { reason: "completed" });
  const trace = fx.run.trace();

  assert.notEqual(trace.outcome, "success");
  const learned = learnWorkflow({ scope: artifact.scope, taskFamily: artifact.taskFamily, requestId: "failed-helpers", subsystem: "workflow", collect: true,
    traces: [trace], budget: { maxEpisodes: 2, maxSteps: 16, maxTokens: 10000 } });

  assert.ok(learned.ok);
  assert.equal(learned.value.mode, "lessons_only");
  assert.deepEqual(learned.value.positiveEvidenceRefs, []);
  assert.deepEqual(learned.value.negativeEvidenceRefs, [trace.traceId]);
});

test("an ambiguous frozen failed check invalidates every possible node instead of reviving old checkpoints", async () => {
  const shared = "node check-all-products.cjs";
  const fx = fixture({ ...artifact, nodes: artifact.nodes.map(node => ({ ...node, check: shared })),
    recovery: [...artifact.recovery, { afterNode: "prepare", goto: "prepare", lesson: "Recheck the producer", evidenceRefs: ["prior-failure"] }] });

  fx.check("prepare-original", shared);
  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  const publish = { nodeId: "publish", input: "actual-clean.csv", output: "actual-report.json" };

  fx.check("publish-original", shared);
  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "result");
  fx.check("ambiguous-failure", shared, false);
  fx.check("unrecorded-pass", shared);
  fx.emit("terminal", { reason: "completed" });
  assert.notEqual(fx.run.trace().outcome, "success", "a later unbound pass cannot resurrect either pre-failure checkpoint");
  assert.equal(fx.run.trace().steps.length, 2, "no failed IO or step was invented");
  fx.check("prepare-recovered", shared);
  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  fx.check("publish-recovered", shared);
  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "result");
  fx.emit("terminal", { reason: "completed" });
  assert.equal(fx.run.trace().outcome, "success");
  assert.equal(fx.run.trace().otherFailures?.length, 1);
});

test("ambiguous failed checks with conflicting recovery contracts remain typed unknown instead of guessing a node", async () => {
  const shared = "node check-all-products.cjs";
  const fx = fixture({ ...artifact, nodes: artifact.nodes.map(node => ({ ...node, check: shared })) });

  fx.check("prepare-original", shared);
  await fx.tool("workflow_record_step", prepare);
  fx.check("publish-original", shared);
  await fx.tool("workflow_record_step", { nodeId: "publish", input: "actual-clean.csv", output: "actual-report.json" });
  fx.check("ambiguous-failure", shared, false);
  fx.check("ambiguous-retry", shared);
  const record = await fx.tool("workflow_record_step", prepare);

  assert.equal(record.result.outcome, "error");

  if (record.result.outcome === "error") assert.equal(record.result.code, "workflow_recovery_ambiguous");

  fx.emit("terminal", { reason: "completed" });
  assert.equal(fx.run.trace().outcome, "unknown");
  assert.equal(fx.run.trace().steps.length, 2);
  assert.equal(fx.run.trace().otherFailures?.length, 1);
  assert.deepEqual(fx.run.progress().ready, []);
});

test("failed receipts from different turns may retain the same provider tool ID without being merged", () => {
  const trace = { ...artifact, schemaVersion: 1, traceId: "failures", source: "runtime", workflowVersionId: "wfl_frozen", steps: [], outcome: "failure",
    otherFailures: ["t1", "t2"].map(turn => ({ toolCallId: "provider-reused-id", command: "node check.cjs", evidenceRef: `session:s/turn:${turn}/tool:provider-reused-id` })) };
  assert.equal(parseWorkflowTrace(trace).ok, true);
  assert.equal(parseWorkflowTrace({ ...trace, otherFailures: [trace.otherFailures[0], trace.otherFailures[0]] }).ok, false);
});

test("omitting a frozen failed checkpoint cannot bypass its recovery edge or invent failed output", async () => {
  const fx = fixture();
  fx.check("prepare", artifact.nodes[0]!.check);
  await fx.tool("workflow_record_step", prepare);
  fx.check("forgotten-failed-summary", artifact.nodes[1]!.check, false);
  fx.emit("tool_use", { name: "read_file", toolCallId: "inspection", arguments: { path: "actual-clean.csv" } });
  fx.check("summary-without-recovery", artifact.nodes[1]!.check);
  const publish = { nodeId: "publish", input: "actual-clean.csv", output: "actual-report.json" };

  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "error");
  assert.equal(fx.run.trace().steps.length, 1, "failure observation does not invent node IO or a failed step");
  assert.equal(fx.run.progress().recoveryTo, "prepare");
  const resumed = createWorkflowExecution({ ...fx.input, resumeRecords: fx.records });

  assert.equal(resumed.progress().recoveryTo, "prepare");
  fx.check("recovered-prepare", artifact.nodes[0]!.check);
  assert.equal((await fx.tool("workflow_record_step", prepare)).result.outcome, "result");
  fx.check("recovered-summary", artifact.nodes[1]!.check);
  assert.equal((await fx.tool("workflow_record_step", publish)).result.outcome, "result");
  fx.emit("terminal", { reason: "completed" });
  assert.equal(fx.run.trace().outcome, "success");
  assert.equal(fx.run.trace().otherFailures?.length, 1);
});
