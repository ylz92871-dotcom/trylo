import assert from "node:assert/strict";
import test from "node:test";
import type { TimerScheduler } from "../../../../../subagent/scheduler.js";
import type { ProviderPort } from "../../../../../ports/provider.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { createCollaborationDecisionModel } from "../runtime/decision-model.js";
import { createPersonalAgentTools } from "../runtime/personal-agent-tools.js";
import { createPersonalAgentCollaboration } from "../personal-agent/service.js";
import { createCollaborationControl } from "./central.js";
import type { CollaborationCentralWorker } from "./contracts.js";
import { collaborationTimingFor } from "./timing.js";

const NOW = Date.parse("2026-11-03T12:00:00.000Z"), scope = "workspace:deadline";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 24000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };

function timers() {
  const entries: { delay: number; cancelled: boolean; fire: () => void }[] = [];
  const scheduler: TimerScheduler = (delay, fire) => {
    const entry = { delay, cancelled: false, fire: () => { if (!entry.cancelled) fire(); } };
    entries.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  };
  return { scheduler, entries };
}

function memory() {
  let state = emptyBoardState(), clock = NOW;
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  return { board, now: () => new Date(clock).toISOString(), advance(ms: number) { clock += ms; }, state: () => state };
}

async function fund(control: ReturnType<typeof createCollaborationControl>) {
  const reported = await control.report({ scope, problemKey: "deadline", report: { reportId: "report:deadline",
    source: { teamRunId: "team", taskId: "task", memberId: "worker" }, facts: ["A reference was missing."], evidenceRefs: [] } });
  assert.ok(reported.ok);
  const decided = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "PA selected this issue.", sourceRefs: [] });
  assert.ok(decided.ok);
  assert.ok((await control.fund({ issueId: decided.issue.issueId, expectedRevision: decided.issue.revision, grantId: "grant:deadline", allowance })).ok);
}

function slowCall() {
  let entered = () => {}, requests = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stream: ProviderPort["stream"] = async function* (_request, signal) {
    requests += 1;
    yield { type: "stream_start", providerId: "bounded-local-fixture", model: "fixture", warnings: [] };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: 20, totalTokens: 120,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    entered();
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "error", class: "cancelled", retryable: false, phase: "after_stream_started", message: "Fixture transport observed the abort signal" };
  };
  const provider: ProviderPort = { stream, fork: () => ({ stream }) };

  return { provider, started, calls: () => requests };
}

const modelWorker = (model: ReturnType<typeof createCollaborationDecisionModel>): CollaborationCentralWorker => ({ async run(input) {
  const result = await model.decide({ issue: input.issue, material: {}, step: 0, jobId: input.jobId, claimId: input.claimId,
    funding: input.funding, maxPromptChars: allowance.maxPromptChars, signal: input.signal });
  return result.ok ? { kind: "completed", resultRefs: [] } : { kind: "failed", reason: result.reason };
} });

test("model local wait ceiling is 540s while unified work, lease and PA metadata remain unchanged", async () => {
  assert.deepEqual(collaborationTimingFor(4), { stepMs: 150000, workMs: 540000, leaseMs: 570000, toolTimeoutMs: 600000 });
  const h = memory(), step = timers(), work = timers(), slow = slowCall(), caller = new AbortController();
  const model = createCollaborationDecisionModel({ provider: slow.provider, model: "fixture", scheduler: step.scheduler });
  const control = createCollaborationControl({ board: h.board, now: h.now, ownerId: "deadline-owner", worker: modelWorker(model), workScheduler: work.scheduler });

  await fund(control);
  const dispatch = control.dispatch({ scope, signal: caller.signal });
  await slow.started;
  let result: Awaited<typeof dispatch> | undefined;

  try {
    assert.equal(step.entries[0]?.delay, 540000);
    step.entries[0]!.fire();
    result = await dispatch;
  } finally {
    caller.abort();
    await dispatch;
  }

  assert.ok(result?.ok);
  assert.equal(result.result?.kind, "failed");
  assert.equal(result.result?.kind === "failed" ? result.result.reason : undefined, "learning_model_timeout");
  assert.equal(slow.calls(), 1);
  assert.deepEqual(centralLearningSpent(h.state().centralLearningGrants![0]!), { tokens: 120, calls: 1, steps: 1 });
  assert.ok(step.entries.every(timer => timer.cancelled));
  assert.ok(work.entries.every(timer => timer.cancelled));
  const service = createPersonalAgentCollaboration({ control, scope, turnId: "turn", allowance, currentResources: async () => ({ view: {}, revision: "r1" }) });
  const tools = createPersonalAgentTools({ service, scope, turnId: "turn", learningToolTimeoutMs: collaborationTimingFor(allowance.maxCalls).toolTimeoutMs,
    capability: async () => ({}), library: async () => ({}), feedback: async () => ({}) });

  assert.equal(tools.snapshot().find(t => t.name === "collaboration_decide")!.timeoutMs, 390000);
});

test("actual work deadline aborts the original worker signal then settles known usage and closes its single grant", async () => {
  const h = memory(), step = timers(), work = timers(), slow = slowCall(), caller = new AbortController();
  const control = createCollaborationControl({ board: h.board, now: h.now, ownerId: "work-owner", workScheduler: work.scheduler,
    worker: modelWorker(createCollaborationDecisionModel({ provider: slow.provider, model: "fixture", scheduler: step.scheduler })) });

  await fund(control);
  const dispatch = control.dispatch({ scope, signal: caller.signal });
  await slow.started;
  let result: Awaited<typeof dispatch> | undefined;

  try {
    assert.equal(work.entries[0]?.delay, 330000);
    assert.equal(Date.parse(h.state().centralLearningGrants![0]!.claim!.expiresAt) - NOW, 360000);
    h.advance(330000);
    work.entries[0]!.fire();
    result = await dispatch;
  } finally {
    caller.abort();
    await dispatch;
  }

  assert.ok(result?.ok);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.result, { kind: "cancelled", reason: "learning_work_timeout" });
  assert.equal(h.state().assets.length, 0);
  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.deepEqual(h.state().centralLearningGrants![0]!.allowance, allowance);
  assert.equal(h.state().centralLearningGrants![0]!.status, "closed");
  assert.deepEqual(centralLearningSpent(h.state().centralLearningGrants![0]!), { tokens: 120, calls: 1, steps: 1 });
  assert.equal((await control.dispatch({ scope })).ok, true);
  assert.equal(slow.calls(), 1);
  assert.ok(step.entries.every(timer => timer.cancelled));
  assert.ok(work.entries.every(timer => timer.cancelled));
});

test("caller cancellation and normal dispatch completion both remove work timers and preserve original lifecycle ownership", async () => {
  for (const cancel of [true, false]) {
    const h = memory(), work = timers(), caller = new AbortController();
    let workerSignal: AbortSignal | undefined, entered = () => {}, release = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const control = createCollaborationControl({ board: h.board, now: h.now, ownerId: "parent-owner", workScheduler: work.scheduler,
      worker: { async run(input) {
        workerSignal = input.signal;
        entered();
        await gate;
        return { kind: "completed", resultRefs: ["bounded-result"] };
      } } });

    await fund(control);
    const dispatch = control.dispatch({ scope, signal: caller.signal });
    await started;

    if (cancel) caller.abort();
    release();
    const result = await dispatch;
    assert.ok(result.ok);
    assert.equal(result.status, cancel ? "cancelled" : "completed");
    assert.equal(work.entries.length, 1);
    assert.equal(work.entries[0]!.cancelled, true);

    if (!cancel) {
      caller.abort();
      assert.equal(workerSignal?.aborted, false);
    }

    assert.equal(h.state().jobs[0]!.state, cancel ? "cancelled" : "succeeded");
    assert.equal(h.state().centralLearningGrants!.length, 1);
  }
});
