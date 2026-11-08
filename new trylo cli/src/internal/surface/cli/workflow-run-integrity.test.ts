import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { runWorkflowLearning } from "../../integration/workflow-learning/runtime.js";
import { workflowFeedback } from "../../integration/workflow-learning/archive.js";
import { resolveLatestWorkflowInstance } from "../../integration/workflow-learning/run-adoption.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { openWorkflowRun } from "./workflow-run-wiring.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { runtimeScopePaths, readRuntimeIntent } from "../../adapters/central-learning-runtime/files.js";
import { serveCentralRuntime } from "../../adapters/central-learning-runtime/server.js";

for (const collection of ["enabled", "disabled"] as const) test(`same-run invalidation persists before late feedback; collection ${collection} controls the existing owner wake`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-integrity-")), at = "2026-11-03T00:00:00.000Z";
  const session = createNdjsonSessionStore({ path: path.join(root, "session.ndjson") });
  const paths = runtimeScopePaths(path.join(root, "home"), root);
  const host = await serveCentralRuntime({ paths, configuration: {}, driver: { async drive() { return { state: "waiting" }; } } });
  const before = host.owner.snapshot().wakeSequence;

  try {
    const ctx: CliContext = { cwd: root, homeDir: root, env: { TRYLO_HOME: path.join(root, "home") }, nodeVersion: "v24.0.0", platform: "win32",
      stdinIsTty: false, readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } }, isDirectory: () => true,
      readDir: () => [], writeFile: () => true, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
      stdout: () => undefined, stderr: () => undefined, now: () => Date.parse(at), newId: prefix => `${prefix}-test` };
    const task = { scope: "project", taskFamily: { id: "report", intentClass: "report", checkKind: "acceptance" as const } };

    await writeFile(path.join(root, "task.json"), JSON.stringify(task));
    await writeFile(path.join(root, "artifact.txt"), "checked");
    const learned = await runWorkflowLearning({ boardRoot: workflowBoardRoot(ctx), issuedAt: at, request: { ...task, requestId: "seed", collect: true,
      subsystem: "workflow", budget: { maxEpisodes: 2, maxSteps: 4, maxTokens: 10000 }, traces: [{ ...task, schemaVersion: 1, traceId: "seed", source: "imported", outcome: "success",
        steps: [{ nodeId: "report", input: "source.txt", output: "artifact.txt", dependsOn: [], check: "node check.cjs", status: "passed", evidenceRefs: ["seed-check"] }] }] } });

    assert.ok(learned.ok);
    assert.ok((await session.start({ sessionId: "s", createdAt: at, fingerprint: { schemaVersion: "1", providerId: "fixture", model: "test", toolCatalogHash: "none", workspaceId: task.scope } })).ok);
    const scaffold: RunScaffold = { providerId: "fixture", providerKind: "fixture", model: "test", endpoint: "", format: "text", apiKey: undefined,
      workspaceRoot: root, workspaceId: task.scope, checkpointRoot: root, sessionId: "s", session, warnings: [], close: () => session.release() };
    const opened = await openWorkflowRun(ctx, { workflowVersion: learned.value.versionId, workflowTask: "task.json", workflowCollection: collection,
      message: [], readStdin: false }, scaffold);
    if (opened === undefined || !("scaffold" in opened)) throw new Error("workflow did not open");

    const workflow = opened;
    let ordinal = 0;

    async function emit(kind: string, payload: JsonObject) {
      ordinal += 1;
      const event: Envelope = { protocolVersion: "0.0", eventId: `e-${ordinal}`, sequence: ordinal, producerSequence: ordinal,
        producerId: "loop", sessionId: "s", turnId: "t", timestamp: at, kind, payload };

      workflow.observe(event);
      assert.ok((await session.append({ type: "envelope", sessionId: "s", turnId: "t", at, payload: { envelope: { ...event } } })).ok);
      workflow.scaffold.onCommittedEnvelope?.(event);

      if (kind === "terminal") await session.append({ type: "terminal", sessionId: "s", turnId: "t", at, payload });
    }

    await emit("turn_start", {});
    await emit("tool_use", { name: "run_shell", toolCallId: "check", arguments: { command: "node check.cjs" } });
    await emit("tool_result", { toolCallId: "check", status: "succeeded", value: { exitCode: 0 } });
    const args = { nodeId: "report", input: "source.txt", output: "artifact.txt" };

    await emit("tool_use", { name: "workflow_record_step", toolCallId: "record", arguments: args });
    const result = await workflow.tools.execute({ name: "workflow_record_step", toolCallId: "record", arguments: args }, new AbortController().signal);

    assert.equal(result.outcome, "result");

    if (result.outcome === "result") await emit("tool_result", { toolCallId: "record", status: "succeeded", value: result.value });

    await writeFile(path.join(root, "artifact.txt"), "changed after checkpoint");
    await emit("terminal", { reason: "completed" });
    assert.equal(workflow.codeFor(EXIT_CODES.OK), EXIT_CODES.EXECUTION_FAILURE);
    await workflow.finish();
    const facts = await session.readRecords();
    assert.ok(facts.ok);
    assert.ok(facts.view.records.some(record => record.type === "execution_extension" && record.payload.configuration !== null
      && typeof record.payload.configuration === "object" && "kind" in record.payload.configuration && record.payload.configuration.kind === "checkpoint_invalidated"));
    const restored = await resolveLatestWorkflowInstance(workflowBoardRoot(ctx), facts.view.records);
    assert.ok(restored.ok && restored.value);
    assert.equal(restored.value.trace.outcome, "unknown");
    const feedback = await workflowFeedback(workflowBoardRoot(ctx), learned.value.versionId);
    assert.ok(feedback.ok);
    assert.equal(feedback.value.length, collection === "enabled" ? 1 : 0);

    if (collection === "enabled") assert.equal(feedback.value[0]?.outcome, "unknown");

    const notified = readRuntimeIntent(paths);
    assert.ok(notified.ok && notified.value);
    assert.equal(notified.value.wakeSequence, before + (collection === "enabled" ? 1 : 0));

    if (collection === "enabled") {
      assert.equal(notified.value.wakeReason, "workflow_instance_feedback_committed");
      assert.equal(notified.value.sourceRefs[0], restored.value.trace.traceId);
      assert.equal(notified.value.sourceRefs.length, 2);
    }

    assert.equal(await readFile(path.join(root, "artifact.txt"), "utf8"), "changed after checkpoint");
  } finally {
    await host.close("stop");
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
