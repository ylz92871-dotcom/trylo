import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";
import type { WorkflowModelPort, WorkflowObservedTurn, WorkflowTraceProposal } from "./model-port.js";
import { classifyAutomaticWorkflow, learnAutomaticWorkflow, processAutomaticWorkflowInput } from "./automatic-runtime.js";
import { readPendingWorkflowLearningJobs, readWorkflowLearningJob } from "./automatic-jobs.js";
import type { WorkflowAutomaticInput } from "./automatic-job-contracts.js";

const task: WorkflowTask = { scope: "project-test", taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" } };
const text = "Prepare a report and verify its schema.";
const observed: WorkflowObservedTurn = { sessionId: "s", turnId: "t", terminal: "completed", tokens: 50, wallMs: 20,
  checks: [{ toolCallId: "real-check", command: "node check.cjs", status: "passed", evidenceRef: "receipt-check", sequence: 3 }],
  mutations: [{ toolCallId: "write", path: "artifact.json", evidenceRef: "receipt-write", sequence: 2 }],
  artifacts: [{ toolCallId: "read", path: "source.csv", evidenceRef: "receipt-read", sequence: 1 }] };
const proposal: WorkflowTraceProposal = { steps: [{ nodeId: "report", input: "source.csv", output: "artifact.json", dependsOn: [], checkToolCallId: "real-check" }] };

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-auto-runtime-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function model(plan: { readonly classify?: (index: number) => WorkflowLearningResult<WorkflowTask>;
  readonly segment?: (index: number) => WorkflowLearningResult<WorkflowTraceProposal>; readonly cost?: number; readonly uncertain?: boolean }) {
  let calls = 0, tokens = 0;
  const classifications: { readonly allowance: number | undefined; readonly validationError: string | undefined; readonly observed: WorkflowObservedTurn | undefined }[] = [];
  const segments: { readonly allowance: number | undefined; readonly validationError: string | undefined }[] = [];
  const port: WorkflowModelPort = {
    async classify(input, _signal, allowance) {
      classifications.push({ allowance, validationError: input.validationError, observed: input.observed });
      calls += 1;
      tokens += plan.cost ?? 20;
      return plan.classify?.(classifications.length) ?? { ok: true, value: task };
    },
    async segment(input, _signal, allowance) {
      segments.push({ allowance, validationError: input.validationError });
      calls += 1;
      tokens += plan.cost ?? 20;
      return plan.segment?.(segments.length) ?? { ok: true, value: proposal };
    },
    usage: () => ({ calls, tokens, observedTokens: tokens, uncertain: plan.uncertain ?? false, allowance: 20000 }),
  };

  return { port, classifications, segments };
}

function input(maxCalls = 2, maxTokens = 3000): WorkflowAutomaticInput {
  const promptHash = contentHashOf(text);
  return { jobId: "classify-test", purpose: "classify", scope: task.scope, sessionId: "s", turnId: `input:${promptHash}`, promptHash,
    allowance: { grantId: "grant-test", maxCalls, maxTokens } };
}

test("classification repair uses the claim allowance and deducts its first call within the same reservation", async () => fixture(async boardRoot => {
  const fx = model({ classify: index => index === 1 ? { ok: false, code: "invalid_task", message: "condition values need strings" } : { ok: true, value: task } });
  const result = await processAutomaticWorkflowInput({ boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 20000 }, input(), new AbortController().signal, { text, families: [] });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.outcome.kind, "classified");
    assert.equal(result.value.tokens, 40);
  }

  assert.deepEqual(fx.classifications.map(call => call.allowance), [3000, 2980]);
  assert.match(fx.classifications[1]!.validationError!, /invalid_task/);
  const saved = await readWorkflowLearningJob({ boardRoot, jobId: "classify-test" });

  assert.equal(saved.ok, true);

  if (saved.ok) {
    assert.equal(saved.value.job.attempt, 1);
    assert.deepEqual(saved.value.usage, { calls: 2, tokens: 40, observedTokens: 40, uncertain: false });
  }
}));

test("a one-call claim or exhausted token claim cannot spend an extra repair call", async () => fixture(async boardRoot => {
  for (const [index, maxCalls, cost] of [[0, 1, 20], [1, 2, 3000]] as const) {
    const fx = model({ cost, classify: () => ({ ok: false, code: "learning_invalid_json", message: "invalid response" }) });
    const original = input(maxCalls);
    const result = await processAutomaticWorkflowInput({ boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 20000 },
      { ...original, jobId: `bounded-${index}`, allowance: { ...original.allowance, grantId: `grant-${index}` } }, new AbortController().signal, { text, families: [] });

    assert.equal(result.ok, true);

    if (result.ok) assert.notEqual(result.value.outcome.kind, "classified");

    assert.equal(fx.classifications.length, 1);
    assert.ok(fx.port.usage().tokens <= 3000);
  }
}));

test("cached abstention retains its charged usage without another model call", async () => fixture(async boardRoot => {
  const fx = model({ classify: () => ({ ok: false, code: "learning_abstained", message: "unknown applicability" }) });
  const context = { boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 3000 };
  const request = { sessionId: "s", watermark: 5, text, scope: task.scope, families: [] };
  const first = await classifyAutomaticWorkflow(context, request, new AbortController().signal);
  const cached = await classifyAutomaticWorkflow(context, request, new AbortController().signal);

  assert.deepEqual(cached, first);
  assert.equal(first.ok, true);

  if (first.ok) {
    assert.equal(first.value.kind, "not_classified");
    assert.equal(first.value.spent, 20);
  }

  assert.equal(fx.classifications.length, 1);
}));

test("partial provider usage remains uncertain even when observed tokens equal the bounded reservation", async () => fixture(async boardRoot => {
  const fx = model({ uncertain: true, cost: 3000, classify: () => ({ ok: false, code: "learning_provider_unavailable", message: "partial receipt" }) });
  const result = await processAutomaticWorkflowInput({ boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 20000 },
    input(), new AbortController().signal, { text, families: [] });

  assert.equal(result.ok, true);
  const saved = await readWorkflowLearningJob({ boardRoot, jobId: "classify-test" });

  assert.equal(saved.ok, true);

  if (saved.ok) assert.deepEqual(saved.value.usage, { calls: 1, tokens: 3000, observedTokens: 3000, uncertain: true });
}));

test("an already aborted task stages execution facts before claiming or spending any model grant", async () => fixture(async boardRoot => {
  const fx = model({});
  const result = await learnAutomaticWorkflow({ boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 3000 },
    { task, observed, adopted: false, remaining: 3000 }, AbortSignal.abort());

  assert.equal(result.ok, false);
  const pending = await readPendingWorkflowLearningJobs({ boardRoot, scope: task.scope, limit: 10 });

  assert.equal(pending.ok, true);

  if (pending.ok) {
    assert.equal(pending.value.length, 1);
    assert.equal(pending.value[0]?.state, "queued");
    assert.deepEqual(pending.value[0]?.input.purpose === "segment" ? pending.value[0].input.observed : undefined, observed);
  }

  assert.equal(fx.port.usage().calls, 0);
}));

test("segmentation can repair a receipt mismatch once without expanding its call or token grant", async () => fixture(async boardRoot => {
  const fx = model({ segment: index => ({ ok: true, value: index === 1
    ? { steps: proposal.steps.map(step => ({ ...step, checkToolCallId: "invented" })) } : proposal }) });
  const result = await learnAutomaticWorkflow({ boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 20000 },
    { task, observed, adopted: false, remaining: 3000 }, new AbortController().signal);

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.outcome.kind, "learned");
    assert.equal(result.value.tokens, 40);
  }

  assert.deepEqual(fx.segments.map(call => call.allowance), [3000, 2980]);
  assert.match(fx.segments[1]!.validationError!, /workflow_receipt_order/);
}));

test("after-task cold classification carries observed facts into the worker and persists their source coordinates", async () => fixture(async boardRoot => {
  const fx = model({});
  const result = await classifyAutomaticWorkflow({ boardRoot, now: () => "2026-11-03T00:00:00.000Z", model: fx.port, allowance: 3000 },
    { sessionId: "s", watermark: 10, text, scope: task.scope, families: [], observed }, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(fx.classifications[0]?.observed, observed);
  const promptHash = contentHashOf(text);
  const jobId = `workflow-classify:${contentHashOf(["s", 10, promptHash]).slice(0, 32)}`;
  const saved = await readWorkflowLearningJob({ boardRoot, jobId });

  assert.equal(saved.ok, true);

  if (saved.ok && saved.value.input.purpose === "classify") {
    assert.equal(saved.value.input.sourceTurnId, "t");
    assert.equal(saved.value.input.journalWatermark, 10);
  }
}));
