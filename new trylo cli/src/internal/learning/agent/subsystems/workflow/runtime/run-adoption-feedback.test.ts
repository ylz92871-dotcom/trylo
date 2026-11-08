import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNdjsonSessionStore } from "../../../../../adapters/session-store/ndjson.js";
import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import { contentHashOf } from "../../../../control/hash.js";
import { runWorkflowLearning } from "./runtime.js";
import { readWorkflowVersion, workflowFeedback } from "./archive.js";
import { selectWorkflowPath } from "../domain/trace-learn.js";
import { createWorkflowExecution } from "./execution.js";
import { commitWorkflowAdoption, commitWorkflowCheckpointInvalidation, persistWorkflowInstanceFeedback, resolveLatestWorkflowInstance } from "./run-adoption.js";

const task = { scope: "project", taskFamily: { id: "report", intentClass: "report", checkKind: "acceptance" as const }, conditions: { format: "json" } };
const nodes = [{ id: "normalize", input: "source.csv", output: "clean.csv", dependsOn: [], check: "node check-clean.cjs" },
  { id: "summarize", input: "clean.csv", output: "report.json", dependsOn: ["normalize"], check: "node check-summary.cjs" }];

test("terminal crash recovery retains the entire adopted instance and exact feedback identities across turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-feedback-recovery-")), at = "2026-11-03T00:00:00.000Z";
  try {
    const learned = await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: { ...task, subsystem: "workflow", requestId: "seed", collect: true,
      budget: { maxEpisodes: 4, maxSteps: 16, maxTokens: 10000 }, traces: [{ ...task, schemaVersion: 1, traceId: "seed", source: "imported",
        outcome: "success", conditionEvidenceRefs: ["seed:input"], steps: nodes.map(node => ({ nodeId: node.id, input: node.input, output: node.output,
          dependsOn: node.dependsOn, check: node.check, status: "passed", evidenceRefs: [`seed:${node.id}`] })) }] } });

    assert.ok(learned.ok);
    const loaded = await readWorkflowVersion(root, learned.value.versionId);
    assert.ok(loaded.ok);
    const selected = selectWorkflowPath(loaded.value, task);
    assert.ok(selected.ok);
    const session = createNdjsonSessionStore({ path: path.join(root, "session.ndjson") });

    await session.start({ sessionId: "s", createdAt: at, fingerprint: { schemaVersion: "1", providerId: "fixture", model: "test", toolCatalogHash: "none", workspaceId: task.scope } });
    const adoption = { task, versionId: learned.value.versionId, instanceId: "execution-1", artifactHash: contentHashOf(loaded.value),
      budget: { maxOutputTokens: 1000 }, conditionEvidenceRefs: ["session:s/task"],
      ...(selected.value.adoptedBranchId === undefined ? {} : { adoptedBranchId: selected.value.adoptedBranchId }) };

    assert.ok((await commitWorkflowAdoption(session, "s", adoption, at)).ok);
    const live = createWorkflowExecution({ artifact: selected.value.artifact, versionId: adoption.versionId, traceId: "random-invocation-id", sessionId: "s", executionId: adoption.instanceId,
      conditions: task.conditions, conditionEvidenceRefs: adoption.conditionEvidenceRefs,
      ...(adoption.adoptedBranchId === undefined ? {} : { adoptedBranchId: adoption.adoptedBranchId }) });
    let ordinal = 0;

    async function emit(turnId: string, kind: string, payload: JsonObject) {
      ordinal += 1;
      const envelope: Envelope = { protocolVersion: "0.0", eventId: `e-${ordinal}`, sequence: ordinal, producerSequence: ordinal,
        producerId: "loop", sessionId: "s", turnId, timestamp: at, kind, payload };
      live.observe(envelope);
      assert.ok((await session.append({ type: "envelope", sessionId: "s", turnId, at, payload: { envelope: { ...envelope } } })).ok);
      if (kind === "terminal") assert.ok((await session.append({ type: "terminal", sessionId: "s", turnId, at, payload })).ok);
    }

    for (const [index, node] of nodes.entries()) {
      const turn = `t${index + 1}`, id = `check-${index}`;

      await emit(turn, "turn_start", {});
      await emit(turn, "usage", { totalTokens: 10, inputTokens: 8, outputTokens: 2 });
      await emit(turn, "tool_use", { name: "run_shell", toolCallId: id, arguments: { command: node.check } });
      await emit(turn, "tool_result", { toolCallId: id, status: "succeeded", value: { exitCode: 0 } });
      const args = { nodeId: node.id, input: node.input, output: node.output };

      await emit(turn, "tool_use", { name: "workflow_record_step", toolCallId: `record-${index}`, arguments: args });
      const result = await live.tools.execute({ name: "workflow_record_step", toolCallId: `record-${index}`, arguments: args }, new AbortController().signal);

      assert.equal(result.outcome, "result");

      if (result.outcome === "result") await emit(turn, "tool_result", { toolCallId: `record-${index}`, status: "succeeded", value: result.value });

      await emit(turn, "terminal", { reason: index === 0 ? "cancelled" : "completed" });
    }

    const facts = await session.readRecords();
    assert.ok(facts.ok);
    const firstTerminal = facts.view.records.find(item => item.type === "terminal")!;
    const firstInterrupted = await resolveLatestWorkflowInstance(root, facts.view.records.filter(item => item.sequence < firstTerminal.sequence - 1));

    assert.ok(firstInterrupted.ok && firstInterrupted.value);
    assert.equal(firstInterrupted.value.terminalTurnId, undefined);
    assert.equal(firstInterrupted.value.completed, false);
    assert.match(firstInterrupted.value.trace.traceId, /^workflow-feedback:/);
    const resolved = await resolveLatestWorkflowInstance(root, facts.view.records);
    assert.ok(resolved.ok && resolved.value);
    assert.equal(resolved.value.completed, true);
    assert.equal(resolved.value.terminalTurnId, "t2");
    assert.deepEqual(resolved.value.trace.steps.map(step => step.nodeId), ["normalize", "summarize"]);
    assert.equal(resolved.value.trace.executionId, adoption.instanceId);
    assert.equal(resolved.value.trace.sessionId, "s");
    assert.deepEqual(resolved.value.trace.conditions, task.conditions);
    assert.equal(resolved.value.trace.adoptedBranchId, adoption.adoptedBranchId);
    assert.deepEqual(resolved.value.trace.cost, { tokens: 20, wallMs: 0 });
    assert.deepEqual(resolved.value.trace.budgetReceipt, { initialTokens: 1000, grantedTokens: 0, observedOutputTokens: 4,
      reservedUnknownTokens: 0, remainingTokens: 996, usageUncertain: false });
    const first = await persistWorkflowInstanceFeedback(root, resolved.value, at);
    assert.ok(first.ok);
    const again = await resolveLatestWorkflowInstance(root, facts.view.records);
    assert.ok(again.ok && again.value);
    const repeated = await persistWorkflowInstanceFeedback(root, again.value, "2026-11-04T00:00:00.000Z");
    assert.ok(repeated.ok);
    assert.equal(repeated.value.versionId, first.value.versionId);
    const archived = await workflowFeedback(root, adoption.versionId);
    assert.ok(archived.ok);
    assert.equal(archived.value.length, 1, "same terminal facts cannot create another success sample on restart");
    const invalidation = { nodeIds: ["normalize"], stepDigest: contentHashOf(resolved.value.trace.steps) };

    assert.ok((await commitWorkflowCheckpointInvalidation(session, "s", adoption, invalidation, at)).ok);
    const invalidatedFacts = await session.readRecords();
    assert.ok(invalidatedFacts.ok);
    const invalidated = await resolveLatestWorkflowInstance(root, invalidatedFacts.view.records);
    assert.ok(invalidated.ok && invalidated.value);
    assert.equal(invalidated.value.completed, false);
    assert.equal(invalidated.value.trace.outcome, "unknown", "another restart cannot resurrect the invalidated producer or its consumer");
    assert.notEqual(invalidated.value.trace.traceId, resolved.value.trace.traceId);
    assert.ok((await persistWorkflowInstanceFeedback(root, invalidated.value, at)).ok);
    const revised = await runWorkflowLearning({ boardRoot: root, issuedAt: at, request: { ...task, subsystem: "workflow", requestId: "revise", collect: true,
      parentVersionId: adoption.versionId, traces: [], budget: { maxEpisodes: 16, maxSteps: 128, maxTokens: 10000 } } });

    assert.ok(revised.ok, JSON.stringify(revised));
    await emit("t3", "turn_start", {});
    await emit("t3", "api_call", {});
    const interruptedFacts = await session.readRecords();
    assert.ok(interruptedFacts.ok);
    const interrupted = await resolveLatestWorkflowInstance(root, interruptedFacts.view.records);
    assert.ok(interrupted.ok && interrupted.value);
    assert.notEqual(interrupted.value.trace.traceId, invalidated.value.trace.traceId, "a new interrupted turn cannot reuse the previous terminal snapshot identity");
    assert.equal(interrupted.value.trace.cost, undefined);
    assert.ok((await persistWorkflowInstanceFeedback(root, interrupted.value, at)).ok);
    await session.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
