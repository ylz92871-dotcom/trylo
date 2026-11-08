import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import type { TimerScheduler } from "../../subagent/scheduler.js";
import { readCentralDeliberationStream } from "./deliberation-stream.js";
import { createOpenAiTranslator } from "../../adapters/provider/openai-translate.js";
import { translateBody } from "../../adapters/provider/openai-stream.js";

test("a unique complete decision tool owns output independently of assistant prose", async () => {
  for (const mixed of [false, true]) {
    const events: ProviderEvent[] = [
      ...(mixed ? [{ type: "text_delta" as const, blockId: "text:one", text: "An unrelated answer before the decision." }] : []),
      { type: "tool_call", toolCallId: "decision:one", name: "submit_central_deliberation", arguments: { schemaVersion: 1 } },
      ...(mixed ? [{ type: "text_delta" as const, blockId: "text:after", text: "This footer is not a second decision." }] : []),
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
      { type: "usage", usage: { mode: "snapshot", inputTokens: 5, outputTokens: 5, totalTokens: 10,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
    ];
    const result = await readCentralDeliberationStream({ provider: { async *stream() { yield* events; } },
      request: { attemptId: "attempt:one", model: "local-contract", messages: [], tools: [] },
      signal: new AbortController().signal, enabled: () => true, maxTokens: 100, timeoutMs: 10000 });

    assert.equal(result.reason, undefined);
    assert.equal(result.boundary.kind, "complete");
    assert.deepEqual(result.output, { schemaVersion: 1 });
    assert.equal(result.diagnostics, undefined);
  }
});

test("actual SSE assistant preamble and private reasoning never mix into fragmented decision arguments", async () => {
  const output = { schemaVersion: 1, explanation: "Only the tool arguments are authoritative." };
  const args = JSON.stringify(output), name = "submit_learning_change";
  const frames = [
    { choices: [{ delta: { content: '{"schemaVersion":999,"untrusted":"assistant prose"}' }, finish_reason: null }] },
    { choices: [{ delta: { reasoning_content: "private-reasoning-sentinel" }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "decision:preamble", type: "function",
      function: { name, arguments: args.slice(0, 19) } }] }, finish_reason: null }] },
    { choices: [{ delta: { content: "Non-decision prose during argument streaming.", tool_calls: [{ index: 0,
      function: { arguments: args.slice(19) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } },
  ];
  const result = await readCentralDeliberationStream({ provider: { stream(_request, signal) {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"));
      controller.close();
    } });
    return translateBody(body, signal);
  } }, request: { attemptId: "reservation:preamble", model: "local-contract", messages: [],
    tools: [{ name, description: "The sole decision envelope", parameters: { type: "object" } }], maxOutputTokens: 512 },
  signal: new AbortController().signal, enabled: () => true, maxTokens: 1000, timeoutMs: 10000 });

  assert.equal(result.reason, undefined);
  assert.equal(result.boundary.kind, "complete");
  assert.deepEqual(result.output, output);
  assert.equal(result.diagnostics, undefined);
  assert.equal(result.reported, true);
  assert.equal(result.usage.totalTokens, 160);
});

function virtualStream(timeoutMs?: number) {
  let now = 0, nextTimer = 0, pulls = 0, returned = 0;
  const timers = new Map<number, { readonly at: number; readonly fire: () => void }>();
  const scheduler: TimerScheduler = (delay, fire) => {
    assert.ok(Number.isSafeInteger(delay) && delay > 0);
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, fire });
    return { cancel() { timers.delete(id); } };
  };
  let pending: ((value: IteratorResult<ProviderEvent>) => void) | undefined;
  let nextPull: (() => void) | undefined;
  let transportSignal: AbortSignal | undefined;
  const provider: ProviderPort = { stream(_request, signal) {
    transportSignal = signal;
    return { [Symbol.asyncIterator]() { return {
      next() {
        pulls += 1;
        nextPull?.();
        nextPull = undefined;
        return new Promise<IteratorResult<ProviderEvent>>(resolve => { pending = resolve; });
      },

      async return() {
        returned += 1;
        pending?.({ done: true, value: undefined });
        pending = undefined;
        return { done: true as const, value: undefined };
      },
    }; } };
  } };
  const controller = new AbortController();
  const result = readCentralDeliberationStream({ provider,
    request: { attemptId: "attempt:virtual-clock", model: "local-contract", messages: [], tools: [] },
    signal: controller.signal, enabled: () => true, maxTokens: 100, scheduler,
    ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const send = async (event: ProviderEvent) => {
    const resolve = pending;
    assert.ok(resolve, "the original transport is waiting for its next event");
    pending = undefined;
    const before = pulls;
    const readAgain = new Promise<void>(ready => { nextPull = ready; });
    resolve({ done: false, value: event });
    await readAgain;
    assert.equal(pulls, before + 1);
  };

  return { result, send, controller,

    advance(milliseconds: number) {
      const until = now + milliseconds;

      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fire();
      }

      now = until;
    },

    aborted: () => transportSignal?.aborted ?? false,
    timers: () => timers.size,
    returned: () => returned,

    async end() {
      const resolve = pending;
      assert.ok(resolve);
      pending = undefined;
      resolve({ done: true, value: undefined });
      return result;
    },
  };
}

const reasoning = (text = "active reasoning"): ProviderEvent => ({ type: "reasoning_delta", blockId: "reason:one", text, redacted: true });
const usage = (outputTokens: number, inputTokens = 5): ProviderEvent => ({ type: "usage", usage: {
  mode: "snapshot", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
  reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
} });
const finish = (reason: "stop" | "tool_calls" = "stop"): Extract<ProviderEvent, { type: "finish" }> => ({
  type: "finish", reason, rawReason: reason, requiresFollowUp: reason === "tool_calls",
});

test("default watchdog lets real reasoning, text and tool progress complete beyond the old 120 second total", async () => {
  const text = virtualStream();

  text.advance(90_000);
  await text.send(reasoning());
  text.advance(90_000);
  assert.equal(text.aborted(), false, "ongoing reasoning must not be cancelled by the old fixed total timeout");
  await text.send({ type: "text_delta", blockId: "text:one", text: '{"schemaVersion":1}' });
  await text.send(finish());
  await text.send(usage(5));
  const textResult = await text.end();

  assert.equal(textResult.reason, undefined);
  assert.equal(textResult.boundary.kind, "complete");
  assert.deepEqual(textResult.output, { schemaVersion: 1 });
  assert.equal(text.timers(), 0);

  const tool = virtualStream();

  await tool.send({ type: "tool_input_start", toolCallId: "decision:one", name: "submit_central_deliberation" });
  tool.advance(110_000);
  await tool.send({ type: "tool_input_delta", toolCallId: "decision:one", argumentsText: '{"schemaVersion":' });
  tool.advance(110_000);
  assert.equal(tool.aborted(), false);
  await tool.send({ type: "tool_input_delta", toolCallId: "decision:one", argumentsText: "1}" });
  tool.advance(110_000);
  await tool.send({ type: "tool_call", toolCallId: "decision:one", name: "submit_central_deliberation", arguments: { schemaVersion: 1 } });
  tool.advance(115_000);
  assert.equal(tool.aborted(), false, "a nonempty completed tool envelope is actual model progress");
  await tool.send(finish("tool_calls"));
  await tool.send(usage(5));
  const toolResult = await tool.end();

  assert.equal(toolResult.reason, undefined);
  assert.equal(toolResult.boundary.kind, "complete");
  assert.equal(tool.timers(), 0);
});

test("default watchdog bounds first progress and later stalls without extending for empty chunks or warning heartbeats", async () => {
  for (const hasProgress of [false, true]) {
    const stream = virtualStream();

    stream.advance(60_000);
    await stream.send({ type: "stream_start", providerId: "local", model: "local-contract", warnings: [] });

    if (hasProgress) await stream.send(reasoning());

    stream.advance(hasProgress ? 119_999 : 59_999);
    await stream.send(reasoning(""));
    await stream.send({ type: "text_delta", blockId: "text:one", text: "" });
    await stream.send({ type: "warning", code: "heartbeat", message: "No new model content" });
    await stream.send(usage(0));
    assert.equal(stream.aborted(), false);
    stream.advance(1);
    const result = await stream.result;

    assert.equal(result.reason, "central_deliberation_timeout");
    assert.equal(result.boundary.kind, "unknown");
    assert.equal(stream.returned(), 1);
    assert.equal(stream.timers(), 0);
  }

  const emptyTool = virtualStream();

  emptyTool.advance(119_999);
  await emptyTool.send({ type: "tool_input_start", toolCallId: "empty:one", name: "submit_central_deliberation" });
  await emptyTool.send({ type: "tool_input_delta", toolCallId: "empty:one", argumentsText: "" });
  await emptyTool.send({ type: "tool_call", toolCallId: "empty:one", name: "submit_central_deliberation", arguments: {} });
  emptyTool.advance(1);
  assert.equal((await emptyTool.result).reason, "central_deliberation_timeout");
});

test("only increasing generated usage extends the default idle watchdog", async () => {
  const stream = virtualStream();

  stream.advance(90_000);
  await stream.send(usage(1));
  stream.advance(90_000);
  assert.equal(stream.aborted(), false);
  await stream.send(usage(2));
  stream.advance(119_999);
  await stream.send(usage(2));
  await stream.send(usage(0));
  await stream.send(usage(2));
  await stream.send(usage(2, 10));
  assert.equal(stream.aborted(), false);
  stream.advance(1);
  const result = await stream.result;

  assert.equal(result.reason, "central_deliberation_timeout");
  assert.equal(result.boundary.kind, "unknown");
  assert.equal(result.reported, true);
  assert.equal(result.usage.outputTokens, 2);
});

test("default watchdog keeps a 600 second hard bound despite continuous real progress", async () => {
  const stream = virtualStream();
  for (let index = 0; index < 5; index++) {
    stream.advance(110_000);
    await stream.send(reasoning());
  }
  assert.equal(stream.aborted(), false);
  stream.advance(50_000);
  const result = await stream.result;
  assert.equal(result.reason, "central_deliberation_timeout");
  assert.equal(result.boundary.kind, "unknown");
  assert.equal(stream.returned(), 1);
  assert.equal(stream.timers(), 0);
});

test("explicit legacy timeout stays a total deadline and external cancellation retains its original reason", async () => {
  const legacy = virtualStream(5000);

  legacy.advance(4000);
  await legacy.send(reasoning());
  legacy.advance(1000);
  assert.equal((await legacy.result).reason, "central_deliberation_timeout");
  assert.equal(legacy.timers(), 0);
  const cancelled = virtualStream();

  await cancelled.send(usage(1));
  cancelled.advance(60_000);
  cancelled.controller.abort("scope stopped");
  const result = await cancelled.result;

  assert.equal(result.reason, "central_deliberation_cancelled");
  assert.equal(result.boundary.kind, "unknown");
  assert.equal(result.diagnostics, undefined, "transport cancellation alone never alleges a semantic refusal");
  assert.equal(cancelled.returned(), 1);
  assert.equal(cancelled.timers(), 0);
});

test("real SSE invalid arguments precede finish length but the same rejected request drains its actual usage", async () => {
  const argumentsText = '{"intents":[';
  const first = { choices: [{ delta: { tool_calls: [{ index: 0, id: "decision:one",
    function: { name: "submit_central_deliberation", arguments: argumentsText } }] }, finish_reason: null }] };
  const terminal = { choices: [{ delta: {}, finish_reason: "length" }] };
  const translator = createOpenAiTranslator();
  translator.push(first);
  const translatedTerminal = translator.push(terminal);

  assert.ok(translatedTerminal.findIndex(event => event.type === "tool_call_invalid")
    < translatedTerminal.findIndex(event => event.type === "finish"), "the real translator emits invalid before the terminal it must not hide");
  const frames = [first, terminal, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }];
  const attempts: string[] = [];
  const result = await readCentralDeliberationStream({ provider: { stream(request, signal) {
    attempts.push(request.attemptId);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"));
      controller.close();
    } });
    return translateBody(body, signal);
  } }, request: { attemptId: "reservation:original", model: "local-contract", messages: [], tools: [], maxOutputTokens: 8192 },
  signal: new AbortController().signal, enabled: () => true, maxTokens: 1000, timeoutMs: 10000 });

  assert.deepEqual(attempts, ["reservation:original"]);
  assert.equal(result.reason, "central_deliberation_tool_invalid");
  assert.equal(result.output, undefined);
  assert.equal(result.boundary.kind, "complete");
  assert.equal(result.usage.totalTokens, 160);
  assert.deepEqual(result.diagnostics, { schemaVersion: 1, rejectionReason: "central_deliberation_tool_invalid", cause: "open_json",
    argumentChars: argumentsText.length, requestedOutputTokens: 8192, toolStarts: 1, invalidTools: 1, finishReason: "length",
    usageObserved: true, streamExhausted: true, usageTailComplete: true });
});

const invalidDecision: ProviderEvent[] = [
  { type: "tool_input_start", toolCallId: "decision:one", name: "submit_central_deliberation" },
  { type: "tool_input_delta", toolCallId: "decision:one", argumentsText: '{"intents":[' },
  { type: "tool_call_invalid", toolCallId: "decision:one", name: "submit_central_deliberation", rawArguments: "", message: "invalid_arguments" },
];
const networkFailure: ProviderEvent = { type: "error", class: "network", retryable: false,
  phase: "after_stream_started", message: "stream interrupted" };

async function recordedStream(events: readonly ProviderEvent[], maxTokens = 100) {
  return readCentralDeliberationStream({ provider: { async *stream() { yield* events; } },
    request: { attemptId: "reservation:one", model: "local-contract", messages: [], tools: [] },
    signal: new AbortController().signal, enabled: () => true, maxTokens, timeoutMs: 10000 });
}

test("the sole advertised decision tool binds both opening and completed calls without accepting the legacy name", async () => {
  for (const name of ["submit_learning_change", "submit_central_deliberation"]) {
    const result = await readCentralDeliberationStream({ provider: { async *stream() {
      yield { type: "tool_input_start", toolCallId: "decision:advertised", name };
      yield { type: "tool_input_delta", toolCallId: "decision:advertised", argumentsText: '{"schemaVersion":1}' };
      yield { type: "tool_call", toolCallId: "decision:advertised", name, arguments: { schemaVersion: 1 } };
      yield finish("tool_calls");
      yield usage(5);
    } }, request: { attemptId: "reservation:advertised", model: "local-contract", messages: [],
      tools: [{ name: "submit_learning_change", description: "The original advertised decision schema", parameters: { type: "object" } }] },
    signal: new AbortController().signal, enabled: () => true, maxTokens: 100, timeoutMs: 10000 });

    assert.equal(result.boundary.kind, "complete");

    if (name === "submit_learning_change") {
      assert.equal(result.reason, undefined);
      assert.deepEqual(result.output, { schemaVersion: 1 });
    } else {
      assert.equal(result.reason, "central_deliberation_tool_forbidden");
      assert.equal(result.output, undefined);
      assert.equal(result.diagnostics?.cause, "unexpected_tool");
    }
  }
});

test("a rejected stream cannot be repaired by a later valid tool and uncertain tails remain unknown", async () => {
  const lateValid = await recordedStream([...invalidDecision,
    { type: "tool_call", toolCallId: "decision:one", name: "submit_central_deliberation", arguments: { schemaVersion: 1 } }, finish("tool_calls"), usage(5)]);

  assert.equal(lateValid.output, undefined);
  assert.equal(lateValid.reason, "central_deliberation_tool_invalid");
  assert.equal(lateValid.boundary.kind, "complete");
  assert.equal(lateValid.diagnostics?.cause, "open_json");

  for (const tail of [[usage(5)], [finish("tool_calls")],
    [finish("tool_calls"), usage(5), { type: "warning" as const, code: "stream_finish_tail_timeout", message: "Tail incomplete" }]]) {
    const result = await recordedStream([...invalidDecision, ...tail]);
    assert.equal(result.boundary.kind, "unknown");
    assert.equal(result.reason, "central_deliberation_tool_invalid");
    assert.equal(result.diagnostics?.usageTailComplete, false);
  }

  const failed = await recordedStream([...invalidDecision, networkFailure]);

  assert.equal(failed.reason, "central_deliberation_provider_network");
  assert.equal(failed.boundary.kind, "unknown");
  assert.equal(failed.diagnostics?.rejectionReason, "central_deliberation_tool_invalid");
  const overrun = await recordedStream([...invalidDecision, usage(101)]);

  assert.equal(overrun.reason, "central_deliberation_token_overrun");
  assert.equal(overrun.boundary.kind, "overrun");
  assert.equal(overrun.diagnostics?.rejectionReason, "central_deliberation_tool_invalid");
  const oversized = await recordedStream([...invalidDecision, { type: "text_delta", blockId: "text:late", text: "x".repeat(131073) }]);

  assert.equal(oversized.reason, "central_deliberation_output_limit");
  assert.equal(oversized.boundary.kind, "unknown");
});

test("length and empty normal output have diagnostics while an unobserved transport failure does not", async () => {
  const length = await recordedStream([{ type: "tool_call", toolCallId: "decision:one", name: "submit_central_deliberation",
    arguments: { schemaVersion: 1 } }, { ...finish("tool_calls"), reason: "length", rawReason: "length" }, usage(5)]);

  assert.equal(length.reason, "central_deliberation_incomplete");
  assert.equal(length.output, undefined);
  assert.equal(length.boundary.kind, "complete");
  assert.equal(length.diagnostics?.cause, "length_termination");
  const empty = await recordedStream([finish(), usage(5)]);

  assert.equal(empty.reason, "central_deliberation_json_invalid");
  assert.equal(empty.diagnostics?.cause, "missing_output");
  assert.equal(empty.diagnostics?.usageTailComplete, true);

  for (const events of [[networkFailure], [usage(5)]]) {
    const result = await recordedStream(events);
    assert.equal(result.boundary.kind, "unknown");
    assert.equal(result.diagnostics, undefined);
  }

  for (const cancelled of [false, true]) {
    const stream = virtualStream();
    for (const event of invalidDecision) await stream.send(event);
    if (cancelled) stream.controller.abort("scope stopped");else stream.advance(120_000);
    const result = await stream.result;
    assert.equal(result.reason, cancelled ? "central_deliberation_cancelled" : "central_deliberation_timeout");
    assert.equal(result.diagnostics?.rejectionReason, "central_deliberation_tool_invalid");
    assert.equal(result.boundary.kind, "unknown");
  }
});

test("assistant prose never repairs invalid, duplicate or incomplete decision tools and text fallback stays separate", async () => {
  const prose: ProviderEvent = { type: "text_delta", blockId: "text:preamble", text: '{"schemaVersion":999}' };
  const opening: ProviderEvent = { type: "tool_input_start", toolCallId: "decision:one", name: "submit_central_deliberation" };
  const complete: ProviderEvent = { type: "tool_call", toolCallId: "decision:one", name: "submit_central_deliberation", arguments: { schemaVersion: 1 } };
  const cases: { readonly events: readonly ProviderEvent[]; readonly reason: string }[] = [
    { events: [{ ...complete, name: "another_tool" }], reason: "central_deliberation_tool_forbidden" },
    { events: [complete, { ...complete, toolCallId: "decision:two" }], reason: "central_deliberation_tool_forbidden" },
    { events: [opening, opening, complete], reason: "central_deliberation_tool_forbidden" },
    { events: [opening, { type: "tool_input_delta", toolCallId: "decision:other", argumentsText: "{}" }],
      reason: "central_deliberation_tool_invalid" },
  ];

  for (const item of cases) {
    const result = await recordedStream([prose, ...item.events, finish("tool_calls"), usage(5)]);
    assert.equal(result.reason, item.reason);
    assert.equal(result.output, undefined);
    assert.equal(result.boundary.kind, "complete");
  }

  const incomplete = await recordedStream([prose, opening,
    { type: "tool_input_delta", toolCallId: "decision:one", argumentsText: '{"schemaVersion":1}' }, finish(), usage(5)]);

  assert.equal(incomplete.reason, "central_deliberation_incomplete");
  assert.equal(incomplete.output, undefined);
  const invalid = await recordedStream([prose, ...invalidDecision, finish("tool_calls"), usage(5)]);

  assert.equal(invalid.reason, "central_deliberation_tool_invalid");
  assert.equal(invalid.diagnostics?.cause, "open_json");
  assert.equal(invalid.output, undefined);
  assert.equal(invalid.usage.totalTokens, 10);
  const fallback = await recordedStream([prose, finish(), usage(5)]);

  assert.equal(fallback.reason, undefined);
  assert.deepEqual(fallback.output, { schemaVersion: 999 });
  const jsonToolEnd = await readCentralDeliberationStream({ provider: { async *stream() {
    yield prose;
    yield { type: "tool_input_end", toolCallId: "unexpected:tool" };
    yield finish();
    yield usage(5);
  } }, request: { attemptId: "reservation:json-tool-end", model: "local-contract", messages: [], tools: [], responseFormat: { type: "json_object" } },
  signal: new AbortController().signal, enabled: () => true, maxTokens: 100, timeoutMs: 10000 });

  assert.equal(jsonToolEnd.reason, "central_deliberation_tool_forbidden");
  assert.equal(jsonToolEnd.output, undefined);
});
