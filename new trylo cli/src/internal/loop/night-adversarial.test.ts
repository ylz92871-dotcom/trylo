import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderRequest } from "../ports/provider.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn } from "./runner.js";

/**
 * Adversarial cases for the turn loop.
 *
 * Each one is a way a plausible implementation could look successful while
 * being wrong. They are written against the loop's public result, not against
 * internals, so a refactor cannot quietly delete the protection.
 */

function recordingProvider(script: ReadonlyArray<ReadonlyArray<ProviderEvent>>): {
  readonly requests: ProviderRequest[];
  readonly port: { stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent> };
} {
  const requests: ProviderRequest[] = [];
  let index = 0;

  return {
    requests,
    port: {
      async *stream(request) {
        requests.push(request);
        const events = script[index] ?? [];
        index += 1;
        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

function terminalEnvelope(result: Awaited<ReturnType<typeof runTurn>>) {
  return result.envelopes.filter((envelope) => envelope.kind === "terminal").at(-1);
}

test("a stream that ends with a tool input still open may not complete", async () => {
  const provider = recordingProvider([
    [
      { type: "tool_input_start", toolCallId: "call-truncated", name: "echo" },
      { type: "tool_input_delta", toolCallId: "call-truncated", argumentsText: '{"text":"par' },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "truncated" },
  );

  assert.notEqual(result.state.terminalReason, "completed");
  const payload = terminalEnvelope(result)?.payload ?? {};

  assert.equal(payload["cause"], "unsettled_tool_input");
  assert.equal(payload["toolCallIds"], "call-truncated");
});

test("a stream that dies after emitting text is unknown and is not retried", async () => {
  const provider = recordingProvider([
    [
      { type: "text_start", blockId: "b1" },
      { type: "text_delta", blockId: "b1", text: "half an answer" },
      {
        type: "error",
        class: "network",
        retryable: true,
        phase: "after_stream_started",
        message: "connection lost",
      },
    ],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "unstable" },
  );

  assert.equal(result.state.terminalReason, "unknown");
  // Retrying after bytes were delivered would duplicate the text.
  assert.equal(provider.requests.length, 1);
  const texts = result.envelopes.filter((envelope) => envelope.kind === "text");

  assert.equal(texts.length, 1);
});

test("repeated usage snapshots are not charged twice", async () => {
  const snapshot = (input: number, output: number): ProviderEvent => ({
    type: "usage",
    usage: { ...emptyUsage("snapshot"), inputTokens: input, outputTokens: output, totalTokens: input + output },
  });
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProviderScript([
        snapshot(10, 5),
        snapshot(10, 5),
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "usage" },
  );

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.usage.totalTokens, 15);
});

test("usage deltas within one stream accumulate", async () => {
  const delta = (input: number, output: number): ProviderEvent => ({
    type: "usage",
    usage: { ...emptyUsage("delta"), inputTokens: input, outputTokens: output, totalTokens: input + output },
  });
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProviderScript([
        delta(10, 5),
        delta(2, 3),
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "usage" },
  );

  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 8);
});

test("a usage snapshot trailing a tool call in the same stream is still recorded", async () => {
  // Providers may report usage after the tool-call block closes. If the loop
  // ran the tool mid-stream, the phase would leave `streaming` and the trailing
  // usage would be rejected as an illegal transition and silently dropped.
  const snapshot = (input: number, output: number): ProviderEvent => ({
    type: "usage",
    usage: { ...emptyUsage("snapshot"), inputTokens: input, outputTokens: output, totalTokens: input + output },
  });
  const provider = recordingProvider([
    [
      { type: "tool_input_start", toolCallId: "call-1", name: "echo" },
      { type: "tool_input_delta", toolCallId: "call-1", argumentsText: '{"text":"hi"}' },
      { type: "tool_input_end", toolCallId: "call-1" },
      snapshot(16, 8),
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [
      { type: "text_start", blockId: "b1" },
      { type: "text_delta", blockId: "b1", text: "done" },
      { type: "text_end", blockId: "b1" },
      { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
    ],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "usage after tool" },
  );

  assert.equal(result.state.terminalReason, "completed");
  const illegal = result.envelopes.filter(
    (envelope) => envelope.kind === "error" && envelope.payload["code"] === "illegal_transition",
  );

  assert.deepEqual(illegal, []);
  const usage = result.envelopes.filter((envelope) => envelope.kind === "usage");

  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.payload["inputTokens"], 16);
  assert.equal(usage[0]?.payload["outputTokens"], 8);
});

test("a turn's usage adds up across iterations instead of reporting only the last", async () => {
  // Each iteration is a separate provider call, so its usage is separately
  // billable. Reporting only the final stream would under-count the turn.
  const snapshot = (input: number, output: number): ProviderEvent => ({
    type: "usage",
    usage: { ...emptyUsage("snapshot"), inputTokens: input, outputTokens: output, totalTokens: input + output },
  });
  const provider = recordingProvider([
    [
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { text: "hi" } },
      snapshot(16, 8),
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [
      snapshot(32, 12),
      { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
    ],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "two calls" },
  );

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.usage.inputTokens, 48);
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.usage.totalTokens, 68);
});

test("the second provider request carries the real tool result", async () => {
  const provider = recordingProvider([
    [
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { text: "hi" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([toolResult({ echo: "hi" }, "TOOL-OUTPUT-MARKER")], [
        echoBinding({ needsApproval: false }),
      ]),
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "use the tool" },
  );

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(provider.requests.length, 2);
  const second = provider.requests[1];

  assert.notEqual(second, undefined);
  const toolMessages = (second?.messages ?? []).filter((message) => message.role === "tool");

  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.content, "TOOL-OUTPUT-MARKER");
  assert.equal(toolMessages[0]?.toolCallId, "call-1");
  // The assistant turn that asked for the tool must still be present.
  assert.equal(
    (second?.messages ?? []).some(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) === 1,
    ),
    true,
  );
});

test("the user turn is part of the canonical transcript so a resume can rebuild it", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProviderScript([
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "remember this" },
  );
  const first = result.transcript[0];

  assert.equal(first?.kind, "user");

  if (first?.kind === "user") {
    assert.equal(first.text, "remember this");
  }
});

test("an unknown provider event neither fails the turn nor leaks its payload", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProviderScript([
        { type: "raw_unknown", wire: "vendor_experiment", metadata: {} },
        { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "unknown wire" },
  );

  assert.equal(result.state.terminalReason, "completed");
  const observation = result.envelopes.find(
    (envelope) => envelope.kind === "observation" && envelope.payload["raw_unknown"] === "vendor_experiment",
  );

  assert.notEqual(observation, undefined);
});

test("the turn loop stops at the configured iteration budget instead of looping", async () => {
  let calls = 0;
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
      provider: {
        async *stream() {
          calls += 1;
          yield { type: "tool_call", toolCallId: `call-${calls}`, name: "echo", arguments: {} };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        },
      },
    },
    {
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "loop forever",
      budget: { maxIterations: 3 },
    },
  );

  assert.equal(result.state.terminalReason, "failed");
  assert.equal(calls <= 3, true, `provider was called ${calls} times`);
  const payload = terminalEnvelope(result)?.payload ?? {};

  assert.equal(payload["cause"], "iterations_exhausted");
});

test("the loop only completes once the provider declares a terminal reason", async () => {
  // A stream that stops without `finish` is unterminated, not complete.
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProviderScript([{ type: "text_delta", blockId: "b1", text: "partial" }]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "silent stop" },
  );
  assert.notEqual(result.state.terminalReason, "completed");
});

test("D7: a tool timeout reaches the model as a retryable error, never cancels the turn", async () => {
  // hard-eval ①：run_shell 超时曾以 cancelled 终结整轮（exit 130）。按本仓库
  // 既有架构（同 shell_nonzero_exit），tool error 是回给模型的一次重试机会，
  // 不是整轮的死刑：turn 存活、模型在下一个请求里看到 shell_timeout。
  const provider = recordingProvider([
    [
      { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: {} },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools(
        [{ outcome: "error", code: "shell_timeout", message: "shell_timeout:10000ms" }],
        [echoBinding({ needsApproval: false })],
      ),
      provider: provider.port,
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "run something long" },
  );

  // The terminal reason, not an exit code: an exit code is what the surface
  // turns a result into, and the loop depending on the surface to describe its
  // own outcome is the dependency the architecture check refuses. "A timeout
  // is not a cancellation" is a fact about this result, so it is asserted here.
  // The terminal reason, not an exit code: an exit code is what the surface
  // turns a result into, and the loop depending on the surface to describe its
  // own outcome is the dependency the architecture check refuses. "A timeout
  // is not a cancellation" is a fact about this result, so it is asserted here.
  assert.notEqual(result.state.terminalReason, "cancelled");
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /shell_timeout/);
});

test("D7: envelopes carry the injected clock, not a hardcoded 1970", async () => {
  // D7-② 真根因：journal-emit 把 timestamp 写死成 1970，persist 再怎么抄
  // envelope 时间也救不回来。host 拥有时钟，loop 只接受注入。
  const provider = recordingProvider([
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);
  const ports = {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
    provider: provider.port,
  };
  const stamped = await runTurn(ports, {
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "hi",
    now: () => 1_757_000_000_000,
  });

  assert.equal(stamped.envelopes.length > 0, true);

  for (const envelope of stamped.envelopes) {
    assert.equal(envelope.timestamp, "2025-09-04T15:33:20.000Z");
  }

  const timeless = await runTurn(ports, {
    sessionId: "s",
    turnId: "t2",
    correlationId: "c",
    text: "hi",
  });

  for (const envelope of timeless.envelopes) {
    assert.equal(envelope.timestamp, "1970-01-01T00:00:00.000Z");
  }
});

/** Local helper so a single script can be expressed without the recording wrapper. */
function createFakeProviderScript(events: ReadonlyArray<ProviderEvent>) {
  return {
    async *stream(): AsyncIterable<ProviderEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

test("D5: the turn budget reaches the provider request as maxOutputTokens", async () => {
  // host.ts 把 maxTokens 映射成 budget.maxOutputTokens，但 buildRequest 从未
  // 把它带进 ProviderRequest：adapter 再想发也发不出去。红例断言请求体上的值。
  const provider = recordingProvider([
    [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
  ]);

  await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
      provider: provider.port,
    },
    {
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "hi",
      budget: { maxIterations: 3, maxOutputTokens: 50 },
    },
  );
  assert.equal(provider.requests.length >= 1, true, "the provider should have been called");
  assert.equal(provider.requests[0]?.maxOutputTokens, 50);
});

test("D5: an explicit exhausted output allowance stops instead of reporting completion", async () => {
  // 显式总输出额度耗尽时不能继续；单次响应截断本身不等于总额度耗尽。
  const provider = recordingProvider([
    [
      { type: "text_delta", blockId: "b1", text: "partial" },
      { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 50, totalTokens: 60,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
      { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false },
    ],
  ]);
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
      provider: provider.port,
    },
    {
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      text: "write a long essay",
      budget: { maxIterations: 3, maxOutputTokens: 50 },
    },
  );

  assert.equal(result.state.terminalReason, "failed");
  const payload = terminalEnvelope(result)?.payload ?? {};

  assert.equal(payload["cause"], "output_tokens_exhausted");
});
