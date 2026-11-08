import assert from "node:assert/strict";
import test from "node:test";
import { runTurn, type LoopPorts } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { createOpenAiTranslator } from "../adapters/provider/openai-translate.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ExecutionProgress } from "../ports/execution-progress.js";
import type { SessionRecord } from "../ports/session.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";

const request = { sessionId: "s", turnId: "t", correlationId: "c", model: "synthetic", text: "Finish the synthetic task." };
const complete = () => createOpenAiTranslator().push({ usage: { prompt_tokens: 77, completion_tokens: 1, total_tokens: 78 } });

function ports(provider: ProviderPort, writes: ExecutionProgress[] = []): LoopPorts {
  return { provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "first"), toolResult({}, "second")], [echoBinding({ needsApproval: false })]),
    progress: { async flush(value) {
      writes.push(value);
      return { ok: true };
    },
      async issue() { return { ok: true }; }, async settle() { return { ok: true }; } },
  };
}

test("a complete main request can checkpoint without a context budget or preparation hook", async () => {
  const writes: ExecutionProgress[] = [];
  const provider: ProviderPort = { inputBindingDigest: () => "a".repeat(64), async *stream(): AsyncIterable<ProviderEvent> {
    yield* complete();
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await runTurn(ports(provider, writes), request);

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.promptInputCheckpoint?.basis.input.tokens, 77);
  assert.equal(result.promptInputCheckpoint?.streamIndex, 1);
  const end = writes.find(value => value.envelopes.some(envelope => envelope.kind === "stream_end"));

  assert.deepEqual(end?.promptInputCheckpoint, result.promptInputCheckpoint);
  assert.equal("inputTokenObservation" in result.usage, false);
  assert.equal(JSON.stringify(result.envelopes).includes('"promptInputCheckpoint"'), false);
  assert.equal(JSON.stringify(result.envelopes).includes('"promptInputRecovery"'), false);
});

test("a later stream with missing usage keeps the original checkpoint's identity", async () => {
  let calls = 0;
  const provider: ProviderPort = { inputBindingDigest: () => "a".repeat(64), async *stream(): AsyncIterable<ProviderEvent> {
    const call = ++calls;
    if (call === 1) {
      yield* complete();
      yield { type: "tool_call", toolCallId: "one", name: "echo", arguments: {} };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await runTurn(ports(provider), request);

  assert.equal(calls, 2);
  assert.equal(result.promptInputCheckpoint?.streamIndex, 1);
  assert.equal(result.promptInputCheckpoint?.basis.input.tokens, 77);
});

for (const ending of ["error", "cancel_ack"] as const) test(`${ending} without a finish cannot create a completed checkpoint`, async () => {
  const provider: ProviderPort = { inputBindingDigest: () => "a".repeat(64), async *stream(): AsyncIterable<ProviderEvent> {
    yield* complete();
    if (ending === "error") yield { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "synthetic incomplete response" };
    else yield { type: "cancel_ack" };
  } };
  assert.equal((await runTurn(ports(provider), request)).promptInputCheckpoint, undefined);
});

test("providers without verifiable input binding retain old behavior without a new checkpoint", async () => {
  const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
    yield* complete();
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await runTurn(ports(provider), request);
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.promptInputCheckpoint, undefined);
  assert.equal(result.promptInputRecovery, undefined);
});

test("checkpoint stream identity follows canonical API calls rather than refunded iteration budget", async () => {
  let calls = 0, steered = false;
  const provider: ProviderPort = { inputBindingDigest: () => "a".repeat(64), async *stream(): AsyncIterable<ProviderEvent> {
    const call = ++calls;
    yield* complete();
    if (call < 3) {
      yield { type: "tool_call", toolCallId: `read-${call}`, name: "echo", arguments: {} };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await runTurn({ ...ports(provider), compaction: compactionWiring({ nowMs: 0 }), pendingInput: () => {
    if (steered) return [];
    steered = true;
    return [{ text: "Use the corrected public direction.", mode: "steer", turnId: request.turnId }];
  } }, { ...request, budget: { maxIterations: 2, contextTokenLimit: 100000 } });

  assert.equal(calls, 3);
  assert.equal(result.promptInputCheckpoint?.streamIndex, result.envelopes.filter(envelope => envelope.kind === "api_call").length);
  assert.notEqual(result.promptInputCheckpoint?.streamIndex, result.iterations);
  const selected = result.envelopes.filter(envelope => envelope.kind === "observation" && envelope.payload.component === "prompt_budget");

  assert.deepEqual(selected.map(envelope => envelope.payload.streamIndex), [1, 2, 3],
    "each selected decision follows the canonical API call even when iteration allowance is refunded");
});

test("an invalid optional checkpoint is reported as unavailable while public history remains runnable", async () => {
  const history: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, sessionId: "s", turnId: "old", at: "now", type: "turn_start", payload: {} },
    { formatVersion: "1", sequence: 1, sessionId: "s", turnId: "old", at: "now", type: "envelope", payload: {
      envelope: { kind: "api_call", sessionId: "s", turnId: "old", attemptId: "old-a", payload: { attemptId: "old-a" } },
    } },
    { formatVersion: "1", sequence: 2, sessionId: "s", turnId: "old", at: "now", type: "envelope", payload: {
      envelope: { kind: "stream_end", sessionId: "s", turnId: "old", attemptId: "old-a", payload: { reason: "stop" } },
      promptInputCheckpoint: { version: 999 },
    } },
  ];
  const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
    yield* complete();
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await runTurn(ports(provider), { ...request, resumedRecords: history });

  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(result.promptInputRecovery, { kind: "unavailable", reason: "invalid_checkpoint" });
  assert.equal(JSON.stringify(result.envelopes).includes('"promptInputRecovery"'), false);
});
