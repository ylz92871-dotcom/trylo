import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicTranslator } from "./anthropic-translate.js";

/**
 * WP18.3 (L68) contract: the Anthropic Messages wire translates to canonical
 * events with the wire's own ids, and the native wire is the only one claimed
 * (Bedrock/Vertex/Foundry stay source_missing: no SDK, no credential chain).
 */

test("text and usage flow through with the wire block index", () => {
  const translator = createAnthropicTranslator();
  const events = [
    ...translator.push("message_start", { message: { usage: { input_tokens: 8 } } }),
    ...translator.push("content_block_start", { index: 0, content_block: { type: "text" } }),
    ...translator.push("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
    ...translator.push("content_block_stop", { index: 0 }),
    ...translator.push("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
  ];

  assert.deepEqual(events[0], {
    type: "usage",
    usage: {
      mode: "snapshot",
      inputTokens: 8,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 8,
    },
  });
  assert.deepEqual(events[1], { type: "text_start", blockId: "text-0" });
  assert.deepEqual(events[2], { type: "text_delta", blockId: "text-0", text: "hi" });
  const finish = events.find((event) => event.type === "finish");

  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "stop");
  assert.equal(finish.type === "finish" && finish.requiresFollowUp, false);
});

test("tool_use assembles input_json fragments and settles with the wire id", () => {
  const translator = createAnthropicTranslator();
  const events = [
    ...translator.push("content_block_start", {
      index: 1,
      content_block: { type: "tool_use", id: "toolu-7", name: "read_file" },
    }),
    ...translator.push("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    }),
    ...translator.push("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"x"}' },
    }),
    ...translator.push("content_block_stop", { index: 1 }),
    ...translator.push("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
  ];
  const call = events.find((event) => event.type === "tool_call");

  assert.deepEqual(call, {
    type: "tool_call",
    toolCallId: "toolu-7",
    name: "read_file",
    arguments: { path: "x" },
  });
  const finish = events.find((event) => event.type === "finish");

  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "tool_calls");
  assert.equal(finish.type === "finish" && finish.requiresFollowUp, true);
});

test("max_tokens ends length, errors end explicitly, pings are silent", () => {  const stopped = createAnthropicTranslator().push("message_delta", {
    delta: { stop_reason: "max_tokens" },
    usage: { output_tokens: 64 },
  });
  const finish = stopped.find((event) => event.type === "finish");

  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "length");
  const failed = createAnthropicTranslator().push("error", { error: { message: "overloaded" } });

  assert.deepEqual(failed, [
    {
      type: "error",
      class: "server",
      retryable: false,
      phase: "after_stream_started",
      message: "overloaded",
    },
  ]);
  assert.deepEqual(createAnthropicTranslator().push("ping", {}), []);
});

test("F7: signature deltas are silent and all-zero usage is suppressed", () => {
  const translator = createAnthropicTranslator();
  const opened = translator.push("content_block_start", {
    index: 2,
    content_block: { type: "thinking" },
  });

  assert.deepEqual(opened, [{ type: "reasoning_start", blockId: "reasoning-2", redacted: false }]);
  assert.deepEqual(
    translator.push("content_block_delta", { index: 2, delta: { type: "signature_delta", signature: "opaque" } }),
    [],
  );
  const terminal = translator.push("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } });

  assert.equal(
    terminal.some((event) => event.type === "usage"),
    false,
  );
  const finish = terminal.find((event) => event.type === "finish");

  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "stop");
});
