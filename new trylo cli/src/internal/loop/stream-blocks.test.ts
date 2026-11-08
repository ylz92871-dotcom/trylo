import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent } from "../ports/provider.js";
import { consumeProviderStream } from "./stream.js";
import {
  TOOL_ARGUMENT_CHAR_LIMIT,
  applyReasoningBlock,
  applyTextBlock,
  applyToolCall,
  applyToolInput,
  createStreamAccumulator,
} from "./stream-blocks.js";
import { createFakeProvider } from "./fakes.js";

/**
 * Block assembly, tested at the layer that owns it.
 *
 * The reducer's contract is "closed facts only", so the interesting cases are
 * the ones where the wire is *not* closed: arguments that are not JSON,
 * arguments that are JSON but not an object, a tool input block the stream
 * never ends, and the same call announced twice. Each is asserted here without
 * a provider, a process or a clock. The last test walks one whole stream
 * through `consumeProviderStream` to prove the classifier really delegates to
 * these assemblers.
 */

test("a closed text block becomes exactly one transcript item, sequenced from the start", () => {
  const acc = createStreamAccumulator(7);

  applyTextBlock(acc, { type: "text_start", blockId: "b1" });
  applyTextBlock(acc, { type: "text_delta", blockId: "b1", text: "hel" });
  applyTextBlock(acc, { type: "text_delta", blockId: "b1", text: "lo" });
  applyTextBlock(acc, { type: "text_end", blockId: "b1" });
  assert.deepEqual(acc.transcriptItems, [
    { kind: "assistant_text", sequence: 7, blockId: "b1", text: "hello" },
  ]);
  assert.equal(acc.textBlocks.size, 0);
});

test("an empty text block is not a fact and produces nothing", () => {
  const acc = createStreamAccumulator(0);
  applyTextBlock(acc, { type: "text_start", blockId: "b1" });
  applyTextBlock(acc, { type: "text_end", blockId: "b1" });
  assert.deepEqual(acc.transcriptItems, []);
  assert.equal(acc.sequence, 0);
});

test("redaction on any reasoning delta survives to the closed block", () => {
  const acc = createStreamAccumulator(0);

  applyReasoningBlock(acc, { type: "reasoning_start", blockId: "r1", redacted: false });
  applyReasoningBlock(acc, { type: "reasoning_delta", blockId: "r1", text: "a", redacted: false });
  applyReasoningBlock(acc, { type: "reasoning_delta", blockId: "r1", text: "b", redacted: true });
  applyReasoningBlock(acc, { type: "reasoning_end", blockId: "r1" });
  assert.deepEqual(acc.transcriptItems, [
    { kind: "assistant_reasoning", sequence: 0, blockId: "r1", text: "ab", redacted: true },
  ]);
});

test("arguments that are not JSON become an explicit invalid event, never a throw", () => {
  const acc = createStreamAccumulator(3);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "echo" }, "e1");
  applyToolInput(acc, { type: "tool_input_delta", toolCallId: "t1", argumentsText: "{not json" }, "e2");
  applyToolInput(acc, { type: "tool_input_end", toolCallId: "t1" }, "e3");

  assert.deepEqual(acc.inputs, [
    {
      type: "tool_arguments_invalid",
      eventId: "e3",
      toolCallId: "t1",
      name: "echo",
      message: "invalid_arguments",
    },
  ]);
  // The stream records closed conversation feedback; the reducer separately
  // emits the failed journal event without executing any arguments.
  assert.deepEqual(acc.transcriptItems, [{ kind: "tool_result", sequence: 3, toolCallId: "t1", name: "echo", output: "invalid_arguments", truncated: false, outcome: "failed" }]);
  assert.equal(acc.toolInputs.size, 0);
});

test("arguments that parse to a non-object are reported distinctly", () => {
  const acc = createStreamAccumulator(0);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "echo" }, "e1");
  applyToolInput(acc, { type: "tool_input_delta", toolCallId: "t1", argumentsText: "[1,2]" }, "e2");
  applyToolInput(acc, { type: "tool_input_end", toolCallId: "t1" }, "e3");
  assert.deepEqual(acc.inputs, [
    {
      type: "tool_arguments_invalid",
      eventId: "e3",
      toolCallId: "t1",
      name: "echo",
      message: "invalid_arguments:not_object",
    },
  ]);
  assert.deepEqual(acc.transcriptItems, [{ kind: "tool_result", sequence: 0, toolCallId: "t1", name: "echo", output: "invalid_arguments:not_object", truncated: false, outcome: "failed" }]);
});

test("an empty argument stream closes as an empty object, not as a parse error", () => {
  const acc = createStreamAccumulator(0);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "noargs" }, "e1");
  applyToolInput(acc, { type: "tool_input_end", toolCallId: "t1" }, "e2");
  assert.deepEqual(acc.inputs, [
    {
      type: "tool_request",
      eventId: "e2",
      toolCallId: "t1",
      name: "noargs",
      arguments: {},
      needsApproval: false,
    },
  ]);
});

test("a tool input block the stream never closes stays unsettled and reaches no reducer input", () => {
  const acc = createStreamAccumulator(0);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "echo" }, "e1");
  applyToolInput(acc, { type: "tool_input_delta", toolCallId: "t1", argumentsText: '{"a":1}' }, "e2");
  assert.equal(acc.toolInputs.size, 1);
  assert.deepEqual(acc.inputs, []);
  assert.deepEqual(acc.transcriptItems, []);
  assert.equal(acc.emittedToolCalls.size, 0);
});

test("a call announced by fragments and then by the adapter reaches the reducer once", () => {
  const acc = createStreamAccumulator(0);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "echo" }, "e1");
  applyToolInput(acc, { type: "tool_input_delta", toolCallId: "t1", argumentsText: '{"a":1}' }, "e2");
  applyToolInput(acc, { type: "tool_input_end", toolCallId: "t1" }, "e3");
  applyToolCall(acc, { type: "tool_call", toolCallId: "t1", name: "echo", arguments: { a: 1 } }, "e4");
  const requests = acc.inputs.filter((input) => input.type === "tool_request");

  assert.deepEqual(requests, [
    {
      type: "tool_request",
      eventId: "e3",
      toolCallId: "t1",
      name: "echo",
      arguments: { a: 1 },
      needsApproval: false,
    },
  ]);
});

test("an adapter-parsed tool_call is authoritative and discards buffered fragments", () => {
  const acc = createStreamAccumulator(0);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "echo" }, "e1");
  applyToolInput(acc, { type: "tool_input_delta", toolCallId: "t1", argumentsText: '{"a"' }, "e2");
  applyToolCall(acc, { type: "tool_call", toolCallId: "t1", name: "echo", arguments: { a: 1 } }, "e3");
  assert.equal(acc.toolInputs.size, 0);
  assert.deepEqual(acc.inputs, [
    {
      type: "tool_request",
      eventId: "e3",
      toolCallId: "t1",
      name: "echo",
      arguments: { a: 1 },
      needsApproval: false,
    },
  ]);
  assert.deepEqual(acc.transcriptItems, [
    { kind: "tool_call", sequence: 0, toolCallId: "t1", name: "echo", arguments: { a: 1 } },
  ]);
});

test("argument fragments past the ceiling are dropped rather than buffered", () => {
  const acc = createStreamAccumulator(0);

  applyToolInput(acc, { type: "tool_input_start", toolCallId: "t1", name: "echo" }, "e1");
  applyToolInput(
    acc,
    { type: "tool_input_delta", toolCallId: "t1", argumentsText: "x".repeat(TOOL_ARGUMENT_CHAR_LIMIT) },
    "e2",
  );
  applyToolInput(acc, { type: "tool_input_delta", toolCallId: "t1", argumentsText: "tail" }, "e3");
  assert.equal(acc.toolInputs.get("t1")?.text.length, TOOL_ARGUMENT_CHAR_LIMIT);
});

test("a whole stream is assembled through the classifier: fragments close, terminal stops", async () => {
  const events: ReadonlyArray<ProviderEvent> = [
    { type: "stream_start", providerId: "p", model: "m", warnings: [] },
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text: "hi" },
    { type: "text_end", blockId: "b1" },
    { type: "tool_input_start", toolCallId: "t1", name: "echo" },
    { type: "tool_input_delta", toolCallId: "t1", argumentsText: "{oops" },
    { type: "tool_input_end", toolCallId: "t1" },
    { type: "tool_input_start", toolCallId: "t2", name: "echo" },
    { type: "usage", usage: { mode: "snapshot", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 3 } },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
    { type: "text_start", blockId: "b2" },
  ];
  const observation = await consumeProviderStream({
    port: createFakeProvider([events]),
    request: { attemptId: "att-1", model: "m", messages: [], tools: [] },
    signal: new AbortController().signal,
    startSequence: 0,
    nextEventId: (() => {
      let n = 0;
      return () => `e${n++}`;
    })(),
  });

  assert.equal(observation.sawFinish, true);
  assert.equal(observation.usage.totalTokens, 3);
  assert.deepEqual(observation.transcriptItems.map((item) => item.kind), [
    "assistant_text",
    "tool_result",
  ]);
  // t1 closed as invalid; t2 was opened and the stream ended at `finish`, so it
  // is unsettled rather than silently dropped.
  assert.equal(observation.unsettledToolInputCount, 1);
  assert.deepEqual(
    observation.inputs.filter((input) => input.type === "tool_arguments_invalid").length,
    1,
  );
  // Nothing after the terminal signal became a fact.
  assert.equal(observation.transcriptItems.some((item) => item.kind === "assistant_text" && item.blockId === "b2"), false);
});
