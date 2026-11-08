import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, createFakeProvider, createFakeTools, echoBinding, emptyProfileLoader } from "../../loop/fakes.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { Transcript } from "../../protocol/transcript.js";
import { ExecutionProgressError } from "../../ports/execution-progress.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createTurnRecorder } from "./turn-recorder.js";
import { hostFailure } from "./host-failure.js";
import { projectEnvelopes } from "./projection.js";
import { finishTurn } from "./turn-finish.js";
import { createTurnRenderer } from "./render.js";
import { openGoalSession } from "./goal-session.js";

const request = { sessionId: "s", turnId: "t", correlationId: "c", text: "Finish the task and explain the result." };
const call: ProviderEvent[] = [
  { type: "tool_call", toolCallId: "c", name: "echo", arguments: {} },
  { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
];
const report: ProviderEvent[] = [
  { type: "text_start", blockId: "report" },
  { type: "text_delta", blockId: "report", text: "The operation's outcome is unconfirmed. I stopped further actions; the task is unfinished." },
  { type: "text_end", blockId: "report" },
  { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
];

function observedProvider(scripts: ProviderEvent[][], requests: ProviderRequest[]): ProviderPort {
  const scripted = createFakeProvider(scripts);
  return { async *stream(input, signal) { requests.push(input); yield* scripted.stream(input, signal); } };
}

for (const cancel of [false, true]) test(cancel
  ? "closing a cancelled unknown lease preserves cancellation status and exit code"
  : "a durable unknown can explain the interruption without tools or clearing its effect fence", async () => {
  const root = mkdtempSync(join(testScratchPath(), "interruption-report-"));
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });
  const requests: ProviderRequest[] = [];
  const frames: string[] = [];
  const cancellation = new AbortController();

  try {
    assert.equal((await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z",
      fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } })).ok, true);
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
    assert.ok(recorder);
    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const sink = { stdout: (text: string) => { frames.push(text); }, stderr: () => {} };
    const renderer = createTurnRenderer("stream-json", sink, { sessionId: "s", turnId: "t", providerId: "fixture", model: "m" });
    const tools = createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]);
    const result = await runTurn({ progress: recorder.progress, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      provider: observedProvider([call, report], requests),
      tools: { ...tools, async execute(input, signal) { const result = await tools.execute(input, signal); if (cancel) cancellation.abort(); return result; } } },
    { ...request, onEnvelope: renderer.onEnvelope, cancelSignal: cancellation.signal });

    assert.equal(result.state.terminalReason, cancel ? "cancelled" : "failed", "an explanation must not promote uncertain work to success");
    assert.equal(requests.length, cancel ? 1 : 2);
    if (!cancel) {
      assert.deepEqual(requests[1]?.tools, []);
      assert.match(requests[1]?.messages.at(-1)?.content ?? "", /unconfirmed|uncertain/);
      assert.equal(result.transcript.at(-1)?.kind, "assistant_text");
    }
    const recovered = await session.read();
    assert.ok(recovered.ok);
    assert.deepEqual(recovered.session.reconcileRequired, ["tool:c"]);
    assert.equal(recovered.session.transcript.some(item => item.kind === "assistant_text" && item.text.includes("unconfirmed")), !cancel);
    assert.deepEqual(await recorder.progress.issue("another-action"), { ok: false, code: "effect_reconciliation_required" });
    const finished = await finishTurn({ result, renderer, recorder, startedAt: 0, providerId: "fixture", model: "m", extraWarnings: [],
      input: { ...request, workspaceRoot: root, workspaceId: "w", checkpointRoot: join(root, "undo"), providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
        permission: createFakePermission("approved"), format: "stream-json", session, sink, now: () => 0 } });
    assert.ok("continuation" in finished && finished.continuation === "session_closed");
    assert.equal(finished.exitCode, cancel ? 130 : 52);
    const terminal = frames.flatMap(frame => JSON.parse(frame) as { type: string; status?: string });
    assert.deepEqual(terminal.filter(frame => frame.type === "run_result").map(frame => frame.status), [cancel ? "cancelled" : "failed"]);
    const before = await session.readRecords();
    assert.deepEqual(await session.append({ type: "turn_input", sessionId: "s", turnId: "next", at: "1970-01-01T00:00:00Z", payload: { text: "after closed lease" } }),
      { ok: false, code: "lock_conflict" }, "the old live scaffold cannot append through the closed lease");
    assert.deepEqual(await session.readRecords(), before);
  } finally { await session.release(); rmSync(root, { recursive: true, force: true }); }
});

test("a reconciled historical unknown cannot close a successful current turn that reuses its call id", async () => {
  const root = mkdtempSync(join(testScratchPath(), "unknown-history-scope-"));
  const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });
  const history: Transcript = [
    { kind: "user", sequence: 0, text: "Earlier work." },
    { kind: "tool_call", sequence: 1, toolCallId: "c", name: "echo", arguments: {} },
    { kind: "tool_result", sequence: 2, toolCallId: "c", name: "echo", outcome: "unknown", output: "Earlier response was lost.", truncated: false },
  ];
  const requests: ProviderRequest[] = [];
  const sink = { stdout: () => {}, stderr: () => {} };

  try {
    assert.equal((await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z",
      fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } })).ok, true);
    const previous = createTurnRecorder({ session, sessionId: "s", turnId: "old", now: () => 0 });
    assert.ok(previous);
    await previous.start({ startedAt: 0, toolCatalogHash: "h" });
    assert.deepEqual(await previous.progress.flush({ transcript: history, envelopes: [] }), { ok: true });
    assert.deepEqual(await previous.progress.issue("tool:c"), { ok: true });
    assert.deepEqual(await previous.progress.settle("tool:c", "unknown"), { ok: false, code: "effect_reconciliation_required" });
    await previous.finish({ status: "failed", finishReason: "unknown", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    assert.equal((await session.append({ type: "effect_failed", sessionId: "s", turnId: "old", at: "1970-01-01T00:00:00Z",
      payload: { key: "tool:c", outcome: "failed" } })).ok, true, "fixture reconciliation preserves the historical unknown transcript");
    const reconciled = await session.read();
    assert.ok(reconciled.ok);
    assert.deepEqual(reconciled.session.reconcileRequired, []);

    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", resumeTranscript: history, now: () => 0 });
    assert.ok(recorder);
    await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
    const renderer = createTurnRenderer("stream-json", sink, { sessionId: "s", turnId: "t", providerId: "fixture", model: "m" });
    const result = await runTurn({ progress: recorder.progress, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]), provider: observedProvider([call, [
        { type: "text_delta", blockId: "answer", text: "The current operation succeeded." },
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ]], requests) }, { ...request, resumedTranscript: history, onEnvelope: renderer.onEnvelope });
    assert.equal(result.state.toolCalls.c?.status, "succeeded");
    assert.ok(result.issuedKeys.includes("tool:c"));
    const finished = await finishTurn({ result, renderer, recorder, startedAt: 0, providerId: "fixture", model: "m", extraWarnings: [],
      input: { ...request, resumeTranscript: history, workspaceRoot: root, workspaceId: "w", checkpointRoot: join(root, "undo"),
        providerId: "fixture", model: "m", endpoint: "", apiKey: undefined, permission: createFakePermission("approved"),
        format: "stream-json", session, sink, now: () => 0 } });
    assert.ok("result" in finished, "a reconciled prior turn cannot close the current successful writer lease");
    assert.equal(finished.exitCode, 0);
    assert.equal((await session.append({ type: "turn_input", sessionId: "s", turnId: "next", at: "1970-01-01T00:00:00Z",
      payload: { text: "Continue the healthy session." } })).ok, true);
    const recovered = await session.read();
    assert.ok(recovered.ok);
    assert.deepEqual(recovered.session.reconcileRequired, []);
    assert.equal(recovered.session.transcript.some(item => item.kind === "tool_result" && item.outcome === "unknown"), true);
  } finally { await session.release(); rmSync(root, { recursive: true, force: true }); }
});

test("caller cancellation after an unknown settlement does not send an explanation request", async () => {
  const requests: ProviderRequest[] = [];
  const cancellation = new AbortController();
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([call, report], requests),
    progress: { async flush() { return { ok: true }; }, async issue() { return { ok: true }; },
      async settle() { cancellation.abort(); return { ok: false, code: "effect_reconciliation_required" }; } },
    tools: createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]) },
  { ...request, cancelSignal: cancellation.signal });
  assert.equal(requests.length, 1);
  assert.equal(result.state.terminalReason, "cancelled");
});

for (const boundary of ["goal_budget", "goal_write_failure", "goal_cancel"] as const) {
  test(`${boundary} is acknowledged before an unknown interruption can request a model report`, async () => {
    const root = mkdtempSync(join(testScratchPath(), "report-goal-boundary-"));
    const session = createNdjsonSessionStore({ path: join(root, "s.ndjson") });
    const requests: ProviderRequest[] = [];
    const cancellation = new AbortController();

    try {
      assert.equal((await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z",
        fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" } })).ok, true);
      const owner = await openGoalSession({ command: { version: 1, action: "create", objective: "Finish the explicit goal.",
        tokenBudget: boundary === "goal_budget" ? 10 : 100 }, records: [], session, sessionId: "s", turnId: "t", now: () => 0, emit: () => {} });
      const goal = { ...owner, async checkpoint(total: number, turnId?: string, round?: number) {
        if (boundary === "goal_write_failure" && total > 0) throw new Error("goal_checkpoint_failed:disk_full");
        await owner.checkpoint(total, turnId, round);
        if (boundary === "goal_cancel" && total > 0) cancellation.abort();
      } };
      const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
      assert.ok(recorder);
      await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
      const billed: ProviderEvent[] = [{ type: "usage", usage: { mode: "snapshot", inputTokens: 5, outputTokens: 5, totalTokens: 10,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }, ...call];
      const running = runTurn({ goal, progress: recorder.progress, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
        provider: observedProvider([billed, report], requests),
        tools: createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]) },
      { ...request, cancelSignal: cancellation.signal });

      if (boundary === "goal_write_failure") await assert.rejects(running, /goal_checkpoint_failed:disk_full/);
      else {
        const result = await running;
        assert.equal(result.state.terminalReason, boundary === "goal_cancel" ? "cancelled" : "failed");
        assert.equal(owner.current().tokensUsed, 10, "the same cumulative checkpoint cannot charge the work twice");
        assert.equal(owner.current().status, boundary === "goal_budget" ? "budget_exhausted" : "active");
      }

      assert.equal(requests.length, 1, "a report cannot cross the goal's budget, failed writer or caller cancellation");
      const recovered = await session.read();
      assert.ok(recovered.ok);
      assert.deepEqual(recovered.session.reconcileRequired, ["tool:c"]);
    } finally { await session.release(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("an unsettled parallel member prevents an unknown report from bypassing settlement", async () => {
  const requests: ProviderRequest[] = [];
  const batch: ProviderEvent[] = [call[0]!, { type: "tool_call", toolCallId: "later", name: "echo", arguments: {} }, call[1]!];
  await assert.rejects(runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([batch, report], requests),
    progress: { async flush() { return { ok: true }; }, async issue() { return { ok: true }; },
      async settle() { return { ok: false, code: "effect_reconciliation_required" }; } },
    tools: createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]) }, request),
  /execution_progress_failed:settle:effect_reconciliation_required/);
  assert.equal(requests.length, 1);
});

test("a writer failure immediately after the unknown acknowledgement prevents a report request", async () => {
  const requests: ProviderRequest[] = [];
  let uncertain = false;
  await assert.rejects(runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([call, report], requests),
    progress: { async flush() { return uncertain ? { ok: false, code: "disk_full" } : { ok: true }; }, async issue() { return { ok: true }; },
      async settle() { uncertain = true; return { ok: false, code: "effect_reconciliation_required" }; } },
    tools: createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]) }, request),
  /execution_progress_failed:flush:disk_full/);
  assert.equal(requests.length, 1);
});

test("explicit request allowance still stops a durable unknown without a report request", async () => {
  const requests: ProviderRequest[] = [];
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([call, report], requests),
    progress: { async flush() { return { ok: true }; }, async issue() { return { ok: true }; },
      async settle() { return { ok: false, code: "effect_reconciliation_required" }; } },
    tools: createFakeTools([{ outcome: "unknown", code: "lost_ack", message: "uncertain" }], [echoBinding({ needsApproval: false })]) },
  { ...request, budget: { maxIterations: 1 } });
  assert.equal(requests.length, 1);
  assert.equal(result.state.terminalReason, "failed");
});

test("a persistence failure never makes a report request", async () => {
  const requests: ProviderRequest[] = [];
  await assert.rejects(runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([call, report], requests),
    progress: { async flush() { return { ok: false, code: "disk_full" }; }, async issue() { return { ok: true }; }, async settle() { return { ok: true }; } },
    tools: createFakeTools([], []) }, request), /execution_progress_failed:flush:disk_full/);
  assert.equal(requests.length, 0);
});

test("repeated output truncation reports unfinished work while retaining the failure", async () => {
  const requests: ProviderRequest[] = [];
  const length: ProviderEvent[] = [
    { type: "text_start", blockId: "same" }, { type: "text_delta", blockId: "same", text: "unfinished prefix" },
    { type: "text_end", blockId: "same" }, { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: true },
  ];
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([length, length, report], requests), tools: createFakeTools([], []) }, request);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2]?.tools, []);
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.transcript.at(-1)?.kind, "assistant_text");
  assert.ok(result.envelopes.some(envelope => envelope.kind === "terminal" && envelope.payload.cause === "output_continuation_no_progress"));
});

test("host durability failures explain their system source and preserve the typed cause", async () => {
  const failure = await hostFailure(new ExecutionProgressError("flush", "disk_full"), undefined);
  assert.match(failure.message, /progress could not be saved/);
  assert.match(failure.message, /execution_progress_failed:flush:disk_full/);
  assert.equal(failure.continuation, "session_closed");
});

test("an unavailable provider gets an attributed system explanation without another model request", async () => {
  const requests: ProviderRequest[] = [];
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    provider: observedProvider([[{ type: "error", class: "quota", retryable: false, phase: "before_headers", message: "quota" }]], requests),
    tools: createFakeTools([], []) }, request);
  assert.equal(requests.length, 1);
  assert.equal(result.transcript.some(item => item.kind === "assistant_text"), false);
  const warning = projectEnvelopes(result.envelopes).find(event => event.type === "warning");
  assert.ok(warning?.type === "warning");
  assert.match(warning.message, /could not provide a final response/);
  assert.match(warning.message, /quota/);
});
