import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTask } from "../../learning/domains/workflow/trace-contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { runWorkflowLearning } from "../../integration/workflow-learning/runtime.js";
import { enqueueWorkflowLearningJob, claimWorkflowLearningJob, finishWorkflowLearningJob } from "../../integration/workflow-learning/automatic-jobs.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { readWorkflowRunInstances } from "../../integration/workflow-learning/run-adoption.js";
import { openAutomaticWorkflow } from "./workflow-auto-wiring.js";
import { openWorkflowRun } from "./workflow-run-wiring.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";

const at = "2026-11-03T00:00:00.000Z", prompt = "Produce the next checked report";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-auto-correction-"));
  let ordinal = 0;
  const ctx: CliContext = { homeDir: root, cwd: root, env: { TRYLO_HOME: path.join(root, "home") }, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } }, isDirectory: () => true, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => undefined, stderr: () => undefined, now: () => Date.parse(at), newId: prefix => `${prefix}-${++ordinal}` };
  const task: WorkflowTask = { scope: workspaceIdentity(root), taskFamily: { id: "report", intentClass: "compile", checkKind: "acceptance" }, conditions: { format: "json" } };
  const boardRoot = workflowBoardRoot(ctx);
  const round = async (requestId: string, parentVersionId?: string, correct = false) => {
    const result = await runWorkflowLearning({ boardRoot, issuedAt: at, request: { ...task, requestId, subsystem: "workflow", collect: true,
      budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 16000 },
      traces: parentVersionId === undefined ? [{ ...task, schemaVersion: 1, traceId: "seed", source: "imported", outcome: "success", conditionEvidenceRefs: ["seed:input"],
        steps: [{ nodeId: "verify", input: "source.json", output: "report.json", dependsOn: [], check: "node verify-v1.cjs", status: "passed", evidenceRefs: ["seed:check"] }] }] : [],
      ...(parentVersionId === undefined ? {} : { parentVersionId }), ...(correct ? { correction: { nodeId: "verify", check: "node verify-v2.cjs", reason: "Correct verifier", when: task.conditions } } : {}) } });
    assert.ok(result.ok, JSON.stringify(result));
    return result.value.versionId;
  };
  const scaffold = async (sessionId: string): Promise<RunScaffold & { readonly session: ReturnType<typeof createNdjsonSessionStore> }> => {
    const session = createNdjsonSessionStore({ path: path.join(root, `${sessionId}.ndjson`) });
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "openai-compatible", model: "unused", toolCatalogHash: "fixture", workspaceId: task.scope } })).ok);
    return { providerId: "openai-compatible", providerKind: "openai-compatible", model: "unused", endpoint: "http://127.0.0.1:1/v1", apiKey: undefined, format: "text",
      workspaceRoot: root, workspaceId: task.scope, checkpointRoot: root, sessionId, session, warnings: [], close: () => session.release() };
  };

  return { ctx, task, boardRoot, round, scaffold, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function classified(fx: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  const promptHash = contentHashOf(prompt), jobId = `workflow-classify:${contentHashOf([sessionId, 0, promptHash]).slice(0, 32)}`;
  const input = { jobId, purpose: "classify", scope: fx.task.scope, sessionId, turnId: `input:${promptHash}`, promptHash, journalWatermark: 0,
    allowance: { grantId: `${jobId}:initial`, maxCalls: 2, maxTokens: 16000 } };
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot: fx.boardRoot, input, issuedAt: at })).ok);
  const claim = await claimWorkflowLearningJob({ boardRoot: fx.boardRoot, jobId, issuedAt: at });
  assert.ok(claim.ok);
  assert.ok((await finishWorkflowLearningJob({ boardRoot: fx.boardRoot, claim: claim.value, outcome: { kind: "classified", task: fx.task }, usage: { calls: 0, tokens: 0 }, issuedAt: at })).ok);
}

test("fresh automatic dispatch uses the saved correction after a later old-branch update, without another model call", async () => {
  const fx = await fixture(), scaffold = await fx.scaffold("new-task");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("No provider work allowed");
  };

  try {
    const base = await fx.round("base"), corrected = await fx.round("corrected", base, true);
    await fx.round("late-old-child", base);
    await classified(fx, scaffold.sessionId);
    const automatic = await openAutomaticWorkflow(fx.ctx, { workflowLearning: true, message: [], readStdin: false }, scaffold, prompt);
    assert.equal(automatic.nomination?.versionId, corrected);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await scaffold.session.release();
    await fx.cleanup();
  }
});

test("active frozen instances and explicit historical runs retain the original version despite new default corrections", async () => {
  const fx = await fixture(), active = await fx.scaffold("active"), historical = await fx.scaffold("historical");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("No provider work allowed");
  };

  try {
    const base = await fx.round("base");
    const explicitContext: CliContext = { ...fx.ctx, readFile: file => file.endsWith("task.json") ? JSON.stringify(fx.task) : fx.ctx.readFile(file) };
    const options = { workflowVersion: base, workflowTask: "task.json", message: [], readStdin: false };
    const first = await openWorkflowRun(explicitContext, options, active);
    assert.ok(first !== undefined && "scaffold" in first);
    const initial = await active.session.readRecords();
    assert.ok(initial.ok);
    const before = readWorkflowRunInstances(initial.view.records);
    assert.ok(before.ok);
    await fx.round("corrected", base, true);
    await fx.round("late-old-child", base);
    const resumed = { ...active, resumeRecords: initial.view.records };
    const automatic = await openAutomaticWorkflow(fx.ctx, { workflowLearning: true, message: [], readStdin: false }, resumed, prompt);

    assert.equal(automatic.nomination?.versionId, base);
    const reopened = await openWorkflowRun(explicitContext, { message: [], readStdin: false }, resumed, automatic.nomination);

    assert.ok(reopened !== undefined && "scaffold" in reopened);
    const after = await active.session.readRecords();
    assert.ok(after.ok);
    assert.deepEqual(readWorkflowRunInstances(after.view.records), before, "resume adds no new adoption or changed instance identity");
    const oldRun = await openWorkflowRun(explicitContext, options, historical);
    assert.ok(oldRun !== undefined && "scaffold" in oldRun);
    const oldFacts = await historical.session.readRecords();
    assert.ok(oldFacts.ok);
    const instances = readWorkflowRunInstances(oldFacts.view.records);
    assert.ok(instances.ok);
    assert.equal(instances.value[0]?.adoption.versionId, base);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await active.session.release();
    await historical.session.release();
    await fx.cleanup();
  }
});
