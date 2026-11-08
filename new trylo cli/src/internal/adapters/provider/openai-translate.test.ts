import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiTranslator } from "./openai-translate.js";
import { INVALID_TOOL_INPUT_MESSAGE } from "./invalid-tool-input.js";

/**
 * The translator is pure, so every wire family can be driven directly: one
 * positive case for the shape it must produce, one negative for the chunk that
 * must produce nothing at all.
 */

const chunk = (delta: Record<string, unknown>, finishReason?: string): unknown => ({
  choices: [{ delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
});

test("usage: a usage-only frame reports every dimension, including the cached one", () => {
  const events = createOpenAiTranslator().push({
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  });
  assert.deepEqual(events, [
    {
      type: "usage",
      inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 10 },
      usage: {
        mode: "snapshot",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 15,
      },
    },
  ]);
});

test("usage: a frame without usage fields reports zeroes rather than guessing", () => {
  const events = createOpenAiTranslator().push({ usage: {} });
  assert.deepEqual(events, [
    {
      type: "usage",
      usage: {
        mode: "snapshot",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
    },
  ]);
});

test("text: the first content opens the block, later content only extends it", () => {
  const translator = createOpenAiTranslator();

  assert.deepEqual(translator.push(chunk({ content: "he" })), [
    { type: "text_start", blockId: "text-0" },
    { type: "text_delta", blockId: "text-0", text: "he" },
  ]);
  assert.deepEqual(translator.push(chunk({ content: "llo" })), [
    { type: "text_delta", blockId: "text-0", text: "llo" },
  ]);
});

test("text: empty content and a non-string content are not events", () => {
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(chunk({ content: "" })), []);
  assert.deepEqual(translator.push(chunk({ content: 42 })), []);
});

test("reasoning: the block opens once and stays unredacted on the wire's word", () => {
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(chunk({ reasoning_content: "think" })), [
    { type: "reasoning_start", blockId: "reasoning-0", redacted: false },
    { type: "reasoning_delta", blockId: "reasoning-0", text: "think", redacted: false },
  ]);
  assert.deepEqual(translator.push(chunk({ reasoning_content: "" })), []);
});

test("reasoning arriving as `reasoning` (not `reasoning_content`) is still surfaced", () => {
  // Measured on the AMD Radeon endpoint (MiMo-V2.6-Flash): the thinking channel
  // comes as `delta.reasoning`, while content frames carry a
  // `reasoning_content: null` placeholder. Reading only `reasoning_content` made
  // the model's reasoning invisible with no error anywhere — evidence in
  // docs/.../evidence/2026-10-07-WP26/11-real-provider-batch.md §四.
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(chunk({ role: "assistant", reasoning: "The" })), [
    { type: "reasoning_start", blockId: "reasoning-0", redacted: false },
    { type: "reasoning_delta", blockId: "reasoning-0", text: "The", redacted: false },
  ]);
});

test("a null `reasoning_content` placeholder does not mask the field that carries text", () => {
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(chunk({ reasoning_content: null, reasoning: "x" })), [
    { type: "reasoning_start", blockId: "reasoning-0", redacted: false },
    { type: "reasoning_delta", blockId: "reasoning-0", text: "x", redacted: false },
  ]);
});

test("when both spellings are filled, `reasoning_content` wins and nothing doubles", () => {
  const translator = createOpenAiTranslator();

  assert.deepEqual(translator.push(chunk({ reasoning_content: "a", reasoning: "b" })), [
    { type: "reasoning_start", blockId: "reasoning-0", redacted: false },
    { type: "reasoning_delta", blockId: "reasoning-0", text: "a", redacted: false },
  ]);
  assert.deepEqual(translator.push(chunk({ reasoning_content: "a2", reasoning: "b2" })), [
    { type: "reasoning_delta", blockId: "reasoning-0", text: "a2", redacted: false },
  ]);
});

test("a null placeholder alone with content invents no reasoning", () => {
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(chunk({ reasoning_content: null, content: "1" })), [
    { type: "text_start", blockId: "text-0" },
    { type: "text_delta", blockId: "text-0", text: "1" },
  ]);
});

test("tool calls: fragments append to the call opened by the first mention", () => {
  const translator = createOpenAiTranslator();

  assert.deepEqual(
    translator.push(
      chunk({
        tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"pa' } }],
      }),
    ),
    [
      { type: "tool_input_start", toolCallId: "call_a", name: "read" },
      { type: "tool_input_delta", toolCallId: "call_a", argumentsText: '{"pa' },
    ],
  );
  assert.deepEqual(
    translator.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] })),
    [{ type: "tool_input_delta", toolCallId: "call_a", argumentsText: 'th":"x"}' }],
  );
});

test("tool calls: a nameless index still gets a stable id, and a late name is adopted", () => {
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(chunk({ tool_calls: [{ function: { arguments: "{}" } }] })), [
    { type: "tool_input_start", toolCallId: "call-0", name: "" },
    { type: "tool_input_delta", toolCallId: "call-0", argumentsText: "{}" },
  ]);
  assert.deepEqual(translator.push(chunk({ tool_calls: [{ index: 0, function: { name: "late" } }] })), []);
});

test("finish: a tool_calls finish closes the open text block, settles the call, then finishes", () => {
  const translator = createOpenAiTranslator();

  translator.push(chunk({ content: "ok" }));
  translator.push(chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"path":"x"}' } }] }));
  assert.deepEqual(translator.push(chunk({}, "tool_calls")), [
    { type: "text_end", blockId: "text-0" },
    { type: "tool_call", toolCallId: "call_a", name: "read", arguments: { path: "x" } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ]);
});

test("finish: an unknown reason maps to other and never asks for a follow-up", () => {
  const events = createOpenAiTranslator().push(chunk({}, "mystery"));
  assert.deepEqual(events, [
    { type: "finish", reason: "other", rawReason: "mystery", requiresFollowUp: false },
  ]);
});

test("finish: a chunk with no reason is not a finish", () => {
  assert.deepEqual(createOpenAiTranslator().push(chunk({ content: "x" })).filter((e) => e.type === "finish"), []);
  assert.deepEqual(createOpenAiTranslator().push({ choices: [{ delta: {}, finish_reason: "" }] }), []);
});

test("invalid arguments stay visible instead of being dropped or guessed", () => {
  const translator = createOpenAiTranslator();

  translator.push(chunk({ tool_calls: [{ index: 0, id: "call_bad", function: { name: "write", arguments: "{not json" } }] }));
  const events = translator.push(chunk({}, "tool_calls"));
  const invalid = events[0];

  assert.ok(invalid?.type === "tool_call_invalid");
  assert.ok(invalid.message.startsWith(INVALID_TOOL_INPUT_MESSAGE));
  assert.match(invalid.message, /ended with an open JSON string or container/);
  assert.deepEqual(events, [
    {
      type: "tool_call_invalid",
      toolCallId: "call_bad",
      name: "write",
      rawArguments: "",
      message: invalid.message,
    },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ]);
});

test("arguments that parse to a non-object are invalid too, empty arguments are {}", () => {
  const asArray = createOpenAiTranslator();

  asArray.push(chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "[1]" } }] }));
  assert.equal(asArray.push(chunk({}, "tool_calls")).at(0)?.type, "tool_call_invalid");

  const empty = createOpenAiTranslator();

  empty.push(chunk({ tool_calls: [{ index: 0, id: "c2", function: { name: "f", arguments: "  " } }] }));
  assert.deepEqual(empty.push(chunk({}, "tool_calls")).at(0), {
    type: "tool_call",
    toolCallId: "c2",
    name: "f",
    arguments: {},
  });
});

test("complete: a stream that ends without a finish reason still closes what it opened", () => {
  const translator = createOpenAiTranslator();

  translator.push(chunk({ reasoning_content: "r" }));
  translator.push(chunk({ tool_calls: [{ index: 0, id: "call_c", function: { name: "f", arguments: "{}" } }] }));
  assert.deepEqual(translator.complete(), [
    { type: "reasoning_end", blockId: "reasoning-0" },
    { type: "tool_call", toolCallId: "call_c", name: "f", arguments: {} },
  ]);
  assert.deepEqual(translator.complete(), []);
});

test("a chunk that is not an object, or carries no choices, produces nothing", () => {
  const translator = createOpenAiTranslator();
  assert.deepEqual(translator.push(null), []);
  assert.deepEqual(translator.push("not a chunk"), []);
  assert.deepEqual(translator.push({ choices: [] }), []);
  assert.deepEqual(translator.push({ choices: [{ delta: null }] }), []);
  assert.deepEqual(translator.push({ choices: [{ delta: { tool_calls: "nope" } }] }), []);
});
