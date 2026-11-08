import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowLearningRequest, WorkflowTrace } from "../domain/trace-contracts.js";
import { runWorkflowLearning } from "./runtime.js";
import { readWorkflowVersion } from "./archive.js";

const task = { scope: "project:window", taskFamily: { id: "window", intentClass: "build_report", checkKind: "acceptance" as const } };

function trace(traceId: string, outcome: WorkflowTrace["outcome"]): WorkflowTrace {
  return { ...task, schemaVersion: 1, traceId, source: "imported", outcome,
    steps: [{ nodeId: "build", input: "source", output: "report", dependsOn: [], check: "node verify.cjs",
      status: outcome === "failure" ? "failed" : "passed", evidenceRefs: [`${traceId}:check`] }] };
}

function request(traces: readonly WorkflowTrace[]): WorkflowLearningRequest {
  return { ...task, requestId: "window-first", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 10000 }, traces };
}

test("daily updates consume a bounded evidence window while the old Board version stays readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-window-"));
  try {
    const first = await runWorkflowLearning({ boardRoot: root, issuedAt: "2026-11-03T00:00:00.000Z",
      request: request([trace("s0", "success"), trace("f0", "failure"), trace("u0", "unknown")]) });

    assert.ok(first.ok);
    const second = await runWorkflowLearning({ boardRoot: root, issuedAt: "2026-11-03T00:01:00.000Z", request: {
      ...request([trace("s1", "success")]), requestId: "window-next", parentVersionId: first.value.versionId,
      budget: { maxEpisodes: 3, maxSteps: 8, maxTokens: 10000 },
    } });

    assert.ok(second.ok, JSON.stringify(second));
    assert.equal(second.value.traceCount, 3);
    assert.equal(second.value.evidenceWindow?.parentVersionId, first.value.versionId);
    assert.ok(second.value.evidenceWindow?.omittedRefs.some(ref => ref.includes("s0")));
    const current = await readWorkflowVersion(root, second.value.versionId);

    assert.ok(current.ok);
    assert.equal(current.value.learning?.statisticsScope, "window");
    assert.deepEqual(current.value.evidenceWindow, second.value.evidenceWindow);
    const old = await readWorkflowVersion(root, first.value.versionId);

    assert.ok(old.ok);
    assert.equal(old.value.traces.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
