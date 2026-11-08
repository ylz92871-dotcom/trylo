import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { WorkflowLearningArtifact } from "../domain/trace-contracts.js";
import { createWorkflowExecution } from "./execution.js";

const artifact: WorkflowLearningArtifact = { schemaVersion: 1, type: "workflow_learning", requestId: "r", scope: "project",
  taskFamily: { id: "report", intentClass: "compile", checkKind: "acceptance" }, mode: "path", nodes: [
    { id: "prepare", input: "source.csv", output: "clean.csv", dependsOn: [], check: "node check-clean.mjs" },
    { id: "publish", input: "clean.csv", output: "report.json", dependsOn: ["prepare"], check: "node check-report.mjs" },
  ], recovery: [{ afterNode: "publish", goto: "prepare", lesson: "Normalize again", evidenceRefs: ["failure"] }],
  traces: [], positiveEvidenceRefs: ["prior-success"], negativeEvidenceRefs: ["failure"] };

function fixture(records: SessionRecord[] = [], digest = "a".repeat(64)) {
  const run = createWorkflowExecution({ artifact, versionId: "wfl_frozen", traceId: "feedback", sessionId: "s",
    ...(records.length === 0 ? {} : { resumeRecords: records }), outputDigest: () => digest });
  let sequence = records.length;

  function emit(kind: string, payload: JsonObject, turnId = "t1") {
    sequence += 1;
    const envelope: Envelope = { protocolVersion: "0.0", eventId: `e-${sequence}`, sequence, timestamp: `2026-11-03T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
      sessionId: "s", turnId, producerId: "loop", producerSequence: sequence, kind, payload };
    records.push({ formatVersion: "1", sequence, sessionId: "s", turnId, type: "envelope", at: envelope.timestamp, payload: { envelope: { ...envelope } } });
    run.observe(envelope);
    return envelope;
  }

  async function checkpoint(nodeId: string, callId: string, input: string, output: string, turnId = "t1") {
    const node = artifact.nodes.find(node => node.id === nodeId)!;

    emit("tool_use", { name: "run_shell", toolCallId: callId, arguments: { command: node.check } }, turnId);
    emit("tool_result", { toolCallId: callId, status: "succeeded", value: { exitCode: 0 } }, turnId);
    const args = { nodeId, input, output, checkToolCallId: callId };

    emit("tool_use", { name: "workflow_record_step", toolCallId: `r-${callId}`, arguments: args }, turnId);
    const result = await run.tools.execute({ name: "workflow_record_step", toolCallId: `r-${callId}`, arguments: args }, new AbortController().signal);
    if (result.outcome === "result") emit("tool_result", { toolCallId: `r-${callId}`, status: "succeeded", value: result.value }, turnId);

    return result;
  }

  return { run, records, emit, checkpoint };
}

test("a cancelled run resumes committed progress and consumes the actual upstream artifact", async () => {
  const first = fixture();

  first.emit("turn_start", {});
  assert.equal((await first.checkpoint("prepare", "clean", "new-source.csv", "actual-clean.csv")).outcome, "result");
  first.emit("terminal", { reason: "cancelled" });
  const resumed = fixture(first.records);

  assert.equal(resumed.run.trace().runState, "cancelled");
  assert.equal(resumed.run.trace().steps.length, 1);
  const ready = resumed.run.progress().ready;

  assert.ok(Array.isArray(ready));
  assert.deepEqual(ready[0], { ...artifact.nodes[1], inputBindings: { prepare: "actual-clean.csv" } });
  resumed.emit("turn_start", {}, "t2");
  assert.equal((await resumed.checkpoint("publish", "publish", "clean.csv", "report.json", "t2")).outcome, "error", "historical example path is not the produced input");
  assert.equal((await resumed.checkpoint("publish", "publish-fresh", "actual-clean.csv", "report.json", "t2")).outcome, "result");
  resumed.emit("terminal", { reason: "completed" }, "t2");
  assert.equal(resumed.run.trace().outcome, "success");
  assert.equal(resumed.run.trace().steps.length, 2, "already committed prepare was not executed again");
});

test("changed artifacts invalidate restored checkpoints and a torn check never becomes passed", async () => {
  const first = fixture();

  first.emit("turn_start", {});
  await first.checkpoint("prepare", "clean", "source.csv", "clean.csv");
  const changed = fixture(first.records, "b".repeat(64));

  assert.deepEqual((changed.run.progress().ready as JsonObject[]).map(node => node.id), ["prepare"]);
  first.emit("tool_use", { name: "run_shell", toolCallId: "unfinished", arguments: { command: "node check-report.mjs" } });
  const interrupted = fixture(first.records);

  assert.equal(interrupted.run.trace().runState, "interrupted");
  const refused = await interrupted.run.tools.execute({ name: "workflow_record_step", toolCallId: "claim", arguments: {
    nodeId: "publish", input: "clean.csv", output: "report.json", checkToolCallId: "unfinished",
  } }, new AbortController().signal);

  assert.equal(refused.outcome, "error");
  assert.equal(interrupted.run.trace().steps.length, 1);
});

test("duplicate accounting is idempotent and waiting, budget and cancellation remain distinct", () => {
  for (const [payload, expected] of [[{ reason: "failed", cause: "waiting:user_input", awaitingContinuation: true }, "waiting"],
    [{ reason: "failed", cause: "output_tokens_exhausted", awaitingContinuation: true }, "budget_exhausted"], [{ reason: "cancelled" }, "cancelled"]] as const) {
    const fx = fixture();
    fx.emit("turn_start", {});
    const usage = fx.emit("usage", { inputTokens: 10, outputTokens: 4, totalTokens: 14 });

    fx.run.observe(usage);
    fx.emit("terminal", payload);
    assert.equal(fx.run.trace().cost?.tokens, 14);
    assert.equal(fx.run.trace().runState, expected);
    const resumed = fixture(fx.records);

    assert.equal(resumed.run.trace().cost?.tokens, 14);
    assert.equal(resumed.run.trace().runState, expected);
  }
});

test("redelivered committed checkpoint calls replay idempotently without repeating a step", async () => {
  const first = fixture();
  first.emit("turn_start", {});
  const result = await first.checkpoint("prepare", "clean", "source.csv", "clean.csv");
  if (result.outcome !== "result") throw new Error("fixture checkpoint failed");

  const args = { nodeId: "prepare", input: "source.csv", output: "clean.csv", checkToolCallId: "clean" };

  first.emit("tool_use", { name: "workflow_record_step", toolCallId: "r-clean", arguments: args });
  const replayed = await first.run.tools.execute({ name: "workflow_record_step", toolCallId: "r-clean", arguments: args }, new AbortController().signal);

  assert.equal(replayed.outcome, "result");
  first.emit("tool_result", { toolCallId: "r-clean", status: "succeeded", value: result.value });
  const resumed = fixture(first.records);

  assert.equal(resumed.run.trace().steps.length, 1);
  assert.deepEqual((resumed.run.progress().ready as JsonObject[]).map(node => node.id), ["publish"]);
});
