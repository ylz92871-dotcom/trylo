import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "./context.js";
import { parseWorkflow } from "./args-workflow.js";
import { handleWorkflowLearning } from "./commands-workflow-learning.js";
import { workflowBoardRoot } from "./workflow-paths.js";
import { workflowSessionEvidence } from "./workflow-session-evidence.js";
import { parseWorkflowProviderFlags, withWorkflowLearningSignal } from "./workflow-learning-provider.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { sessionPath } from "./session-paths.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { runWorkflowLearning } from "../../integration/workflow-learning/runtime.js";
import { bindWorkflowProposal } from "../../integration/workflow-learning/raw-facts.js";
import { readWorkflowVersion, workflowFeedback } from "../../integration/workflow-learning/archive.js";
import { selectWorkflowPath } from "../../learning/domains/workflow/trace-learn.js";
import { createWorkflowExecution } from "../../integration/workflow-learning/execution.js";
import { commitWorkflowAdoption } from "../../integration/workflow-learning/run-adoption.js";
import { classifyAutomaticWorkflow, learnAutomaticWorkflow, processAutomaticWorkflowInput } from "../../integration/workflow-learning/automatic-runtime.js";
import { readSuccessfulWorkflowClassificationRetry } from "../../integration/workflow-learning/automatic-classification-retries.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { enqueueWorkflowLearningJob, claimWorkflowLearningJob, finishWorkflowLearningJob, readWorkflowLearningJob, recoverWorkflowLearningJob, retryWorkflowLearningJob } from "../../integration/workflow-learning/automatic-jobs.js";

async function fixture(run: (ctx: CliContext, output: string[], reads: string[]) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-ops-")), output: string[] = [], reads: string[] = [];
  const ctx: CliContext = { env: { TRYLO_HOME: path.join(root, "home") }, homeDir: root, cwd: root,
    nodeVersion: "v24.0.0", platform: "win32", stdinIsTty: false,

    readFile: file => {
      reads.push(file);
      try { return readFileSync(file, "utf8"); } catch { return undefined; }
    },

    isDirectory: file => { try { return statSync(file).isDirectory(); } catch { return false; } }, readDir: () => [],
    writeFile: () => { throw new Error("learning command attempted a task write"); },
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: value => output.push(value), stderr: () => undefined, now: () => 0, newId: prefix => `${prefix}-test` };

  try { await run(ctx, output, reads); } finally { await rm(root, { recursive: true, force: true }); }
}

function classifyInput(ctx: CliContext) {
  const promptHash = contentHashOf("Create a checked report.");
  return { jobId: "classify-op", purpose: "classify" as const, scope: workspaceIdentity(ctx.cwd), sessionId: "session-op",
    turnId: `input:${promptHash}`, promptHash, allowance: { grantId: "classify-op-grant", maxCalls: 1, maxTokens: 4000 } };
}

test("operator verbs route through the learning boundary and execution flags are refused", () => {
  for (const verb of ["jobs", "job", "recover", "retry", "work", "learn-session"]) assert.equal(parseWorkflow([verb]).kind, "workflow_learning");
  assert.equal(parseWorkflowProviderFlags(["--provider", "fixture"]).ok, true);
  for (const argv of [["--allow-writes"], ["--tools", "run_shell"], ["user task"], ["--resume", "s"]]) assert.equal(parseWorkflowProviderFlags(argv).ok, false);
});

test("standalone learning borrows and releases cancellation on both success and failure", async () => fixture(async ctx => {
  let handler: (() => void) | undefined, released = 0;
  const observed: CliContext = { ...ctx, interrupts: { observe: callback => { handler = callback; },

    unobserve: callback => {
      assert.equal(handler, callback);
      handler = undefined;
      released += 1;
    }, exit: () => undefined } };
  assert.equal(await withWorkflowLearningSignal(observed, async signal => {
    handler?.();
    assert.equal(signal.aborted, true);
    return "cancelled";
  }), "cancelled");
  await assert.rejects(withWorkflowLearningSignal(observed, async () => { throw new Error("worker failed"); }), /worker failed/);
  assert.equal(handler, undefined);
  assert.equal(released, 2);
}));

test("job inspection, unknown recovery and explicit funding reuse the durable Board lifecycle without providers", async () => fixture(async (ctx, output, reads) => {
  const boardRoot = workflowBoardRoot(ctx), issuedAt = new Date(0).toISOString();

  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: classifyInput(ctx), issuedAt })).ok);
  assert.equal(await handleWorkflowLearning(ctx, ["jobs"]), EXIT_CODES.OK);
  assert.equal((JSON.parse(output.at(-1)!) as { value: unknown[] }).value.length, 1);
  assert.ok((await claimWorkflowLearningJob({ boardRoot, jobId: "classify-op", issuedAt })).ok);
  assert.equal(await handleWorkflowLearning(ctx, ["recover", "classify-op", "--attempt", "1"]), EXIT_CODES.OK);
  assert.equal(await handleWorkflowLearning(ctx, ["retry", "classify-op", "--grant", "explicit-new-grant", "--tokens", "5000"]), EXIT_CODES.OK);
  const read = await readWorkflowLearningJob({ boardRoot, jobId: "classify-op" });
  assert.ok(read.ok);
  assert.equal(read.value.job.state, "queued");
  assert.equal(read.value.input.allowance.maxTokens, 5000);
  assert.deepEqual(reads, []);
  assert.equal(await handleWorkflowLearning(ctx, ["retry", "classify-op", "--tokens", "5000"]), EXIT_CODES.USAGE);
}));

test("classification work needs the original prompt before any provider or grant is opened", async () => fixture(async (ctx, _output, reads) => {
  const boardRoot = workflowBoardRoot(ctx), issuedAt = new Date(0).toISOString();
  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input: classifyInput(ctx), issuedAt })).ok);
  assert.equal(await handleWorkflowLearning(ctx, ["work", "classify-op", "--", "--provider", "fixture"]), EXIT_CODES.CONFIG);
  const current = await readWorkflowLearningJob({ boardRoot, jobId: "classify-op" });
  assert.ok(current.ok);
  assert.equal(current.value.job.attempt, 0);
  assert.equal(current.value.job.state, "queued");
  assert.deepEqual(reads, []);
}));

test("completed classification work is reused without loading another account or provider", async () => fixture(async (ctx, output, reads) => {
  const boardRoot = workflowBoardRoot(ctx), issuedAt = new Date(0).toISOString(), input = classifyInput(ctx);

  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input, issuedAt })).ok);
  const claim = await claimWorkflowLearningJob({ boardRoot, jobId: input.jobId, issuedAt });
  assert.ok(claim.ok);
  const task = { scope: input.scope, taskFamily: { id: "report", intentClass: "build-report", checkKind: "acceptance" as const } };

  assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome: { kind: "classified", task }, usage: { calls: 1, tokens: 30 }, issuedAt })).ok);
  const prompt = path.join(ctx.cwd, "original-prompt.txt");
  await writeFile(prompt, "Create a checked report.");
  assert.equal(await handleWorkflowLearning(ctx, ["work", input.jobId, "--prompt-file", prompt]), EXIT_CODES.OK);
  assert.equal((JSON.parse(output.at(-1)!) as { value: { outcome: { kind: string } } }).value.outcome.kind, "classified");
  assert.deepEqual(reads, [prompt]);
}));

test("facts-only work repairs a queued staging prefix without requiring a provider or spending tokens", async () => fixture(async (ctx, output, reads) => {
  const boardRoot = workflowBoardRoot(ctx), scope = workspaceIdentity(ctx.cwd), issuedAt = new Date(0).toISOString();
  const input = { jobId: "facts-op", purpose: "segment", scope, sessionId: "session-op", turnId: "turn-op",
    task: { scope, taskFamily: { id: "report", intentClass: "build-report", checkKind: "acceptance" } },
    allowance: { grantId: "facts-only-op", maxCalls: 0, maxTokens: 0 } };

  assert.ok((await enqueueWorkflowLearningJob({ boardRoot, input, issuedAt })).ok);
  const file = path.join(boardRoot, "board-events.ndjson"), prefix = readFileSync(file, "utf8").trimEnd().split("\n").slice(0, 3);

  await writeFile(file, `${prefix.join("\n")}\n`);
  assert.equal(await handleWorkflowLearning(ctx, ["work", "facts-op"]), EXIT_CODES.EXECUTION_FAILURE);
  const saved = await readWorkflowLearningJob({ boardRoot, jobId: "facts-op" });
  assert.ok(saved.ok);
  assert.equal(saved.value.job.state, "waiting_evidence");
  assert.deepEqual(saved.value.usage, { calls: 0, tokens: 0 });
  assert.equal((JSON.parse(output.at(-1)!) as { value: { tokens: number } }).value.tokens, 0);
  assert.deepEqual(reads, []);
}));

test("session learning targets actual current user input and exact classifier source watermark", async () => fixture(async (ctx, _output, reads) => {
  const sessionId = "source-session", store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  assert.ok((await store.start({ sessionId, createdAt: new Date(0).toISOString(), fingerprint: {
    schemaVersion: "1", providerId: "fixture", model: "default", toolCatalogHash: "none", workspaceId: workspaceIdentity(ctx.cwd) } })).ok);

  for (const [turnId, text] of [["turn-old", "Create a checked report."], ["turn-new", "Different current work."]] as const) {
    assert.ok((await store.append({ type: "turn_start", sessionId, turnId, at: new Date(0).toISOString(), payload: {} })).ok);
    assert.ok((await store.append({ type: "turn_input", sessionId, turnId, at: new Date(0).toISOString(), payload: { text } })).ok);
    assert.ok((await store.append({ type: "terminal", sessionId, turnId, at: new Date(0).toISOString(), payload: { reason: "completed" } })).ok);
  }

  await store.append({ type: "execution_extension", sessionId, turnId: "turn-new", at: new Date(1000).toISOString(), payload: {} });
  await store.release();
  const current = await workflowSessionEvidence(ctx, sessionId);
  assert.ok(current.ok);
  assert.equal(current.value.observed.turnId, "turn-new");
  assert.equal(current.value.watermark, 6);
  assert.equal(current.value.records.at(-1)?.sequence, 7);
  assert.equal(current.value.observed.wallMs, 0);
  const old = await workflowSessionEvidence(ctx, sessionId, { turnId: "turn-old", promptHash: contentHashOf("Create a checked report."), journalWatermark: 3 });

  assert.ok(old.ok);
  assert.equal(old.value.observed.turnId, "turn-old");
  assert.equal(old.value.records.at(-1)?.sequence, 3);
  assert.equal((await workflowSessionEvidence(ctx, sessionId, { turnId: "turn-new", journalWatermark: 3 })).ok, false);
  assert.equal(await handleWorkflowLearning(ctx, ["learn-session", "../escape"]), EXIT_CODES.USAGE);
  assert.deepEqual(reads, []);
}));

test("learning the same already-consumed turn reuses its version without another classifier or version chain", async () => fixture(async (ctx, output, reads) => {
  const sessionId = "learned-session", scope = workspaceIdentity(ctx.cwd), issuedAt = new Date(0).toISOString();
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  assert.ok((await store.start({ sessionId, createdAt: issuedAt, fingerprint: { schemaVersion: "1", providerId: "fixture",
    model: "default", toolCatalogHash: "none", workspaceId: scope } })).ok);
  await store.append({ type: "turn_start", sessionId, turnId: "already-learned", at: issuedAt, payload: {} });
  await store.append({ type: "turn_input", sessionId, turnId: "already-learned", at: issuedAt, payload: { text: "Create a checked report." } });
  await store.append({ type: "terminal", sessionId, turnId: "already-learned", at: issuedAt, payload: { reason: "completed" } });
  await store.release();
  const task = { scope, taskFamily: { id: "report", intentClass: "build-report", checkKind: "acceptance" as const } };
  const evidence = await workflowSessionEvidence(ctx, sessionId);
  assert.ok(evidence.ok);
  const trace = bindWorkflowProposal(task, evidence.value.observed, { steps: [] });
  assert.ok(trace.ok);
  const boardRoot = workflowBoardRoot(ctx), learned = await runWorkflowLearning({ boardRoot, issuedAt, request: { ...task,
    requestId: "prior-learning", subsystem: "workflow", collect: true, budget: { maxEpisodes: 4, maxSteps: 8, maxTokens: 10000 },
    traces: [trace.value] } });

  assert.ok(learned.ok, JSON.stringify(learned));
  const before = await createBoardReader(boardRoot).load();
  assert.ok(before.ok);

  for (let round = 0; round < 2; round += 1) {
    assert.equal(await handleWorkflowLearning(ctx, ["learn-session", sessionId, "--budget", "12000", "--", "--provider", "fixture"]), EXIT_CODES.OK);
    const result = JSON.parse(output.at(-1)!) as { value: { outcome: { versionId: string }; reused: boolean } };
    assert.equal(result.value.outcome.versionId, learned.value.versionId);
    assert.equal(result.value.reused, true);
  }

  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.assets.length, before.state.assets.length);
  assert.equal(after.state.jobs.length, before.state.jobs.length);
  assert.deepEqual(reads, []);
}));

for (const oldCached of [false, true]) test(`standalone learning restores adopted feedback after a durable terminal precedes the finish hook${oldCached ? " and rejects an old incomplete cache" : ""}`, async () => fixture(async (ctx, output) => {
  const boardRoot = workflowBoardRoot(ctx), scope = workspaceIdentity(ctx.cwd), issuedAt = new Date(0).toISOString();
  const task = { scope, taskFamily: { id: "report", intentClass: "build-report", checkKind: "acceptance" as const } };
  const prior = await runWorkflowLearning({ boardRoot, issuedAt, request: { ...task, subsystem: "workflow", collect: true, requestId: "prior-path",
    budget: { maxEpisodes: 8, maxSteps: 16, maxTokens: 10000 }, traces: [{ ...task, schemaVersion: 1, source: "imported", traceId: "prior", outcome: "success",
      steps: [{ nodeId: "build", input: "source", output: "report.json", dependsOn: [], check: "node check.cjs", status: "passed", evidenceRefs: ["prior-check"] }] }] } });

  assert.ok(prior.ok);
  const loaded = await readWorkflowVersion(boardRoot, prior.value.versionId);
  assert.ok(loaded.ok);
  const selected = selectWorkflowPath(loaded.value, task);
  assert.ok(selected.ok);
  const sessionId = "adopted-crash", turnId = "failed-turn", instanceId = "adopted-instance";
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  assert.ok((await store.start({ sessionId, createdAt: issuedAt, fingerprint: { schemaVersion: "1", providerId: "fixture",
    model: "default", toolCatalogHash: "none", workspaceId: scope } })).ok);
  assert.ok((await commitWorkflowAdoption(store, sessionId, { versionId: prior.value.versionId, task, instanceId,
    artifactHash: contentHashOf(loaded.value), budget: {}, ...(selected.value.adoptedBranchId === undefined ? {} : { adoptedBranchId: selected.value.adoptedBranchId }) }, issuedAt)).ok);
  await store.append({ type: "turn_start", sessionId, turnId, at: issuedAt, payload: {} });
  await store.append({ type: "turn_input", sessionId, turnId, at: issuedAt, payload: { text: "Create a checked report." } });
  const run = createWorkflowExecution({ artifact: selected.value.artifact, versionId: prior.value.versionId, traceId: "live", sessionId, executionId: instanceId });
  let sequence = 0;

  async function append(kind: string, payload: JsonObject) {
    sequence += 1;
    const envelope: Envelope = { protocolVersion: "0.0", eventId: `event-${sequence}`, sequence, timestamp: issuedAt,
      sessionId, turnId, producerId: "loop", producerSequence: sequence, kind, payload };
    run.observe(envelope);
    assert.ok((await store.append({ type: "envelope", sessionId, turnId, at: issuedAt, payload: { envelope } })).ok);
  }

  await append("tool_use", { toolCallId: "actual-check", name: "run_shell", arguments: { command: "node check.cjs" } });
  await append("tool_result", { toolCallId: "actual-check", status: "failed", code: "shell_nonzero_exit" });
  const args = { nodeId: "build", input: "source", output: "report.json", checkToolCallId: "actual-check" };

  await append("tool_use", { toolCallId: "record", name: "workflow_record_step", arguments: args });
  const recorded = await run.tools.execute({ toolCallId: "record", name: "workflow_record_step", arguments: args }, new AbortController().signal);

  assert.equal(recorded.outcome, "result");
  if (recorded.outcome !== "result") throw new Error("checkpoint fixture failed");

  await append("tool_result", { toolCallId: "record", status: "succeeded", value: recorded.value });
  await append("terminal", { reason: "failed" });
  await store.append({ type: "terminal", sessionId, turnId, at: issuedAt, payload: { reason: "failed" } });
  await store.release();
  const before = await workflowFeedback(boardRoot, prior.value.versionId);
  assert.ok(before.ok);
  assert.equal(before.value.length, 0);

  if (oldCached) {
    const evidence = await workflowSessionEvidence(ctx, sessionId);
    assert.ok(evidence.ok);
    const cached = await learnAutomaticWorkflow({ boardRoot, now: () => issuedAt, allowance: 12000,
      model: { classify: async () => { throw new Error("revision fixture cannot classify"); },
        segment: async () => { throw new Error("revision fixture cannot segment"); }, usage: () => ({ calls: 0, tokens: 0, allowance: 12000 }) } },
      { task, observed: evidence.value.observed, adopted: true, parentVersionId: prior.value.versionId, remaining: 12000 }, new AbortController().signal);
    assert.ok(cached.ok);
    assert.equal(cached.value.outcome.kind, "learned");
  }

  const exit = await handleWorkflowLearning(ctx, ["learn-session", sessionId, "--budget", "12000", "--", "--provider", "fixture"]);
  const feedback = await workflowFeedback(boardRoot, prior.value.versionId);
  assert.ok(feedback.ok);
  assert.equal(feedback.value.length, 1);

  if (oldCached) {
    assert.equal(exit, EXIT_CODES.CONFIG);
    assert.equal((JSON.parse(output.at(-1)!) as { code: string }).code, "workflow_feedback_not_learned");
    const state = await createBoardReader(boardRoot).load();
    assert.ok(state.ok);
    assert.equal(state.state.jobs.length, 1);
    assert.equal(state.state.jobs[0]?.attempt, 1);
    return;
  }

  assert.equal(exit, EXIT_CODES.OK);
  const result = JSON.parse(output.at(-1)!) as { value: { outcome: { kind: string; versionId: string } } };

  assert.equal(result.value.outcome.kind, "learned");
  assert.equal(feedback.value[0]?.executionId, instanceId);
  assert.equal(feedback.value[0]?.steps[0]?.status, "failed");
  const learned = await readWorkflowVersion(boardRoot, result.value.outcome.versionId);
  assert.ok(learned.ok);
  assert.ok(learned.value.traces.some(trace => trace.executionId === instanceId && trace.steps[0]?.status === "failed"));
  assert.equal(await handleWorkflowLearning(ctx, ["learn-session", sessionId, "--budget", "12000", "--", "--provider", "fixture"]), EXIT_CODES.OK);
  const repeated = await workflowFeedback(boardRoot, prior.value.versionId);
  assert.ok(repeated.ok);
  assert.equal(repeated.value.length, 1);
}));

for (const recovery of ["terminal_chain", "base_recovery", "child_recovery"] as const) test(`funded classification ${recovery} lets learn-session continue without old abstention or foreign sources`, async () => fixture(async (ctx, output) => {
  const boardRoot = workflowBoardRoot(ctx), scope = workspaceIdentity(ctx.cwd), issuedAt = new Date(0).toISOString(), sessionId = "classification-retry";
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });

  assert.ok((await store.start({ sessionId, createdAt: issuedAt, fingerprint: { schemaVersion: "1", providerId: "fixture", model: "default", toolCatalogHash: "none", workspaceId: scope } })).ok);
  await store.append({ type: "turn_start", sessionId, turnId: "turn", at: issuedAt, payload: {} });
  await store.append({ type: "turn_input", sessionId, turnId: "turn", at: issuedAt, payload: { text: "Create a checked report." } });
  await store.append({ type: "terminal", sessionId, turnId: "turn", at: issuedAt, payload: { reason: "completed" } });
  await store.release();
  const evidence = await workflowSessionEvidence(ctx, sessionId);
  assert.ok(evidence.ok);
  const task = { scope, taskFamily: { id: "report", intentClass: "build-report", checkKind: "acceptance" as const } };
  let calls = 0;
  const context = { boardRoot, now: () => issuedAt, allowance: 12000, model: {
    classify: async () => {
      calls += 1;
      return calls === 1 && recovery !== "base_recovery" ? { ok: false as const, code: "learning_abstained", message: "needs explicit retry" } : { ok: true as const, value: task };
    },

    segment: async () => { throw new Error("empty executed turn requires no segmentation model"); },
    usage: () => ({ calls, tokens: calls * 20, observedTokens: calls * 20, allowance: 12000 }) } };
  const nomination = { sessionId, scope, text: evidence.value.text, watermark: evidence.value.watermark, observed: evidence.value.observed, families: [] };
  const first = await classifyAutomaticWorkflow(context, nomination, recovery === "base_recovery" ? AbortSignal.abort() : new AbortController().signal);

  if (recovery === "base_recovery") {
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.code, "cancelled");
  }
  else {
    assert.ok(first.ok);
    assert.equal(first.value.kind, "not_classified");
  }

  const state = await createBoardReader(boardRoot).load();
  assert.ok(state.ok);
  const base = await readWorkflowLearningJob({ boardRoot, jobId: state.state.jobs[0]!.jobId });
  assert.ok(base.ok);

  if (base.value.input.purpose !== "classify") throw new Error("classification fixture created the wrong job");

  const original = base.value.input;
  let previous = base.value.job.jobId;

  if (recovery === "base_recovery") {
    assert.ok((await claimWorkflowLearningJob({ boardRoot, jobId: previous, issuedAt })).ok);
    assert.ok((await recoverWorkflowLearningJob({ boardRoot, jobId: previous, expectedAttempt: 1, issuedAt })).ok);
  }

  for (const grantId of recovery === "terminal_chain" ? ["explicit-retry", "explicit-nested-retry"] : ["explicit-retry"]) {
    let funded = await retryWorkflowLearningJob({ boardRoot, jobId: previous, allowance: { grantId, maxCalls: 1, maxTokens: 4000 }, issuedAt });
    assert.ok(funded.ok);

    if (recovery === "child_recovery") {
      assert.ok((await claimWorkflowLearningJob({ boardRoot, jobId: funded.value.jobId, issuedAt })).ok);
      assert.ok((await recoverWorkflowLearningJob({ boardRoot, jobId: funded.value.jobId, expectedAttempt: 1, issuedAt })).ok);
      funded = await retryWorkflowLearningJob({ boardRoot, jobId: funded.value.jobId, allowance: { grantId: "child-continuation", maxCalls: 1, maxTokens: 4000 }, issuedAt });
      assert.ok(funded.ok);
    }

    const worked = await processAutomaticWorkflowInput(context, funded.value.input, new AbortController().signal, { text: nomination.text, families: [], observed: nomination.observed });

    assert.ok(worked.ok);
    assert.equal(worked.value.outcome.kind, "classified");
    previous = funded.value.jobId;
  }

  const expectedCalls = recovery === "terminal_chain" ? 3 : recovery === "child_recovery" ? 2 : 1;

  assert.equal(calls, expectedCalls);

  for (const foreignSource of [false, true]) {
    const id = foreignSource ? "foreign-source" : "no-authorized-lineage";
    assert.ok((await enqueueWorkflowLearningJob({ boardRoot, issuedAt, input: { ...original, jobId: id,
      ...(foreignSource ? { sourceTurnId: "foreign-turn" } : {}), allowance: { grantId: `grant-${id}`, maxCalls: 1, maxTokens: 1000 } } })).ok);
    const claim = await claimWorkflowLearningJob({ boardRoot, jobId: id, issuedAt });
    assert.ok(claim.ok);
    assert.ok((await finishWorkflowLearningJob({ boardRoot, claim: claim.value, outcome: { kind: "classified", task: { ...task, taskFamily: { ...task.taskFamily, id: "unrelated" } } }, usage: { calls: 1, tokens: 10 }, issuedAt })).ok);
  }

  const paid = await readSuccessfulWorkflowClassificationRetry({ boardRoot, input: original });
  assert.ok(paid.ok);
  assert.equal(paid.value?.jobId, previous);

  for (const changed of [{ ...original, scope: "foreign" }, { ...original, sessionId: "foreign" }, { ...original, sourceTurnId: "foreign" },
    { ...original, journalWatermark: evidence.value.watermark + 1 }, { ...original, promptHash: "a".repeat(64), turnId: `input:${"a".repeat(64)}` }]) {
    const rejected = await readSuccessfulWorkflowClassificationRetry({ boardRoot, input: changed });
    assert.equal(rejected.ok, false);
  }

  assert.equal(await handleWorkflowLearning(ctx, ["learn-session", sessionId, "--budget", "12000", "--", "--provider", "fixture"]), EXIT_CODES.OK);
  const result = JSON.parse(output.at(-1)!) as { value: { outcome: { kind: string; versionId: string } } };
  assert.equal(result.value.outcome.kind, "learned");
  const learned = await readWorkflowVersion(boardRoot, result.value.outcome.versionId);
  assert.ok(learned.ok);
  assert.equal(learned.value.taskFamily.id, "report");
  assert.equal(calls, expectedCalls);
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.jobs.length, recovery === "terminal_chain" ? 6 : recovery === "child_recovery" ? 5 : 4);
}));
