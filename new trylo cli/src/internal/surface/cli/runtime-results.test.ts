import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderRequest } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import { projectEnvelopeSequence } from "./stream-projection.js";
import { createProjection } from "./render.js";
import { emptyTuiState, reduceTuiEvent } from "./tui/state.js";

function usage(outputTokens: number): ProviderEvent {
  return { type: "usage", usage: { ...emptyUsage("snapshot"), inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens } };
}

function providerFor(script: ReadonlyArray<ReadonlyArray<ProviderEvent>>) {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    port: {
      async *stream(request: ProviderRequest) {
        const events = script[requests.length] ?? [];
        requests.push(request);
        yield* events;
      },
    },
  };
}

function run(script: ReadonlyArray<ReadonlyArray<ProviderEvent>>, maxOutputTokens?: number, contextTokenLimit?: number) {
  const provider = providerFor(script);
  return {
    provider,
    result: runTurn(
      {
        profile: emptyProfileLoader(),
        permission: createFakePermission("approved"),
        tools: createFakeTools([toolResult({ ok: true }, "tests 12\npass 12\nfail 0")], [echoBinding({ needsApproval: false })]),
        provider: provider.port,
      },
      { sessionId: "result-session", turnId: "t", correlationId: "c", text: "run tests", budget: { maxIterations: 3, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), ...(contextTokenLimit === undefined ? {} : { contextTokenLimit }) } },
    ),
  };
}

const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const toolFinish: ProviderEvent = { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
const call: ProviderEvent = { type: "tool_call", toolCallId: "first", name: "echo", arguments: {} };

test("executed tool output reaches the CLI wire and terminal frame", async () => {
  const { result } = run([[call, toolFinish], [finish]]);
  const turn = await result;
  const events = projectEnvelopeSequence(turn.envelopes);
  const output = events.find(event => event.type === "tool_result");

  assert.equal(output?.type, "tool_result");

  if (output?.type !== "tool_result") return;

  assert.equal(output.output, "tests 12\npass 12\nfail 0");
  const facts = { sessionId: "result-session", providerId: "fixture", model: "fixture", maxIterations: 3, contextTokenLimit: undefined };
  const state = events.reduce((acc, event) => reduceTuiEvent(acc, event), emptyTuiState(facts));

  assert.ok(state.lines.some(line => line.text.includes("pass 12")));
  const rendered: string[] = [];
  const projection = createProjection("text", { stdout: text => rendered.push(text), stderr: text => rendered.push(text) });

  events.forEach(projection.onEvent);
  assert.match(rendered.join(""), /pass 12/);
});

test("usage after a batch of tools is accepted without an illegal transition", async () => {
  const second: ProviderEvent = { ...call, toolCallId: "second" };
  const { result } = run([[call, second, usage(20), toolFinish], [finish]]);
  const turn = await result;

  assert.equal(turn.state.terminalReason, "completed");
  assert.equal(turn.usage.outputTokens, 20);
  assert.equal(turn.envelopes.filter(e => e.kind === "error" && e.payload.code === "illegal_transition").length, 0);
  const events = projectEnvelopeSequence(turn.envelopes);

  assert.ok(events.some(e => e.type === "usage" && e.usage.outputTokens === 20));
});

test("a later provider request receives only the remaining turn output budget", async () => {
  const { result, provider } = run([[call, usage(15), toolFinish], [usage(5), finish]], 50);
  const turn = await result;
  assert.equal(turn.state.terminalReason, "completed");
  assert.deepEqual(provider.requests.map(r => r.maxOutputTokens), [50, 35]);
});

test("exhausted output budget reports consumption and the saved-session requirement", async () => {
  const { result } = run([[call, usage(35), toolFinish], [usage(20), finish]], 50);
  const turn = await result;

  assert.equal(turn.state.terminalReason, "failed");
  const warning = projectEnvelopeSequence(turn.envelopes).find(e => e.type === "warning" && e.code === "output_tokens_exhausted");

  assert.equal(warning?.type, "warning");

  if (warning?.type !== "warning") return;

  assert.match(warning.message, /55.*50/);
  assert.match(warning.message, /--resume <saved-session>/);
  assert.match(warning.message, /Only runs saved with --session/);
});

test("context window uses one request's input, while billing still adds every request", async () => {
  const second: ProviderEvent = { ...call, toolCallId: "second" };
  const { result, provider } = run([[call, usage(1), toolFinish], [second, usage(1), toolFinish], [usage(1), finish]], undefined, 15);
  const turn = await result;
  assert.equal(turn.state.terminalReason, "completed");
  assert.equal(provider.requests.length, 3);
  assert.equal(turn.usage.inputTokens, 30);
});
