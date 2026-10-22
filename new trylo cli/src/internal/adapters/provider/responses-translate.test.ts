import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesTranslator } from "./responses-translate.js";

/**
 * WP18.2 (C68) contract: the Responses wire families translate to the same
 * canonical events the chat wire produces, and every terminal path is
 * explicit. Red was the missing module; green is these cases.
 */

function textFlow() {
  const translator = createResponsesTranslator();
  const events = [
    ...translator.push("response.output_text.delta", { output_index: 0, delta: "hel" }),
    ...translator.push("response.output_text.delta", { output_index: 0, delta: "lo" }),
    ...translator.push("response.completed", {
      response: {
        status: "completed",
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    }),
  ];
  return events;
}

test("text deltas open one block and usage precedes finish", () => {
  const events = textFlow();
  assert.deepEqual(events[0], { type: "text_start", blockId: "text-0" });
  assert.deepEqual(events[1], { type: "text_delta", blockId: "text-0", text: "hel" });
  assert.deepEqual(events[2], { type: "text_delta", blockId: "text-0", text: "lo" });
  const usage = events.find((event) => event.type === "usage");
  const finish = events.find((event) => event.type === "finish");
  assert.ok(usage !== undefined && usage.type === "usage" && usage.usage.inputTokens === 12);
  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "stop");
  assert.equal(finish.type === "finish" && finish.requiresFollowUp, false);
  assert.ok(events.indexOf(usage) < events.indexOf(finish));
});

test("a completed reasoning item seals its summary before the assistant answer", () => {
  const translator = createResponsesTranslator();
  translator.push("response.reasoning_summary_text.delta", { output_index: 0, delta: "Inspect the target." });
  assert.deepEqual(
    translator.push("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs-1" } }),
    [{ type: "reasoning_end", blockId: "reasoning-0" }],
  );
  translator.push("response.output_text.delta", { output_index: 1, delta: "Done." });
  assert.deepEqual(
    translator.push("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg-1" } }),
    [{ type: "text_end", blockId: "text-1" }],
  );
  assert.deepEqual(translator.push("response.completed", { response: { status: "completed" } }), [
    { type: "finish", reason: "stop", rawReason: "completed", requiresFollowUp: false },
  ]);
});

test("a completed item without deltas invents no summary and duplicate endings are silent", () => {
  const translator = createResponsesTranslator();
  const item = { output_index: 0, item: { type: "reasoning", id: "rs-1" } };
  assert.deepEqual(translator.push("response.output_item.done", item), []);
  translator.push("response.reasoning_summary_text.delta", { output_index: 0, delta: "Summary." });
  assert.deepEqual(translator.push("response.output_item.done", item), [{ type: "reasoning_end", blockId: "reasoning-0" }]);
  assert.deepEqual(translator.push("response.output_item.done", item), []);
});

test("function calls assemble across deltas and settle with the wire call id", () => {
  const translator = createResponsesTranslator();
  const events = [
    ...translator.push("response.function_call_arguments.delta", { item_id: "item-1", delta: '{"pa' }),
    ...translator.push("response.function_call_arguments.delta", { item_id: "item-1", delta: 'th":"x"}' }),
    ...translator.push("response.output_item.done", {
      item_id: "item-1",
      item: { type: "function_call", id: "item-1", call_id: "fc-9", name: "read_file", arguments: "" },
    }),
    ...translator.push("response.completed", { response: { status: "completed" } }),
  ];
  const call = events.find((event) => event.type === "tool_call");
  assert.ok(call !== undefined);
  assert.deepEqual(call, {
    type: "tool_call",
    toolCallId: "fc-9",
    name: "read_file",
    arguments: { path: "x" },
  });
  const finish = events.find((event) => event.type === "finish");
  assert.ok(finish !== undefined && finish.type === "finish" && finish.requiresFollowUp === true);
});

test("failed and incomplete responses end explicitly, never silently", () => {
  const failed = createResponsesTranslator().push("response.failed", { message: "boom" });
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], {
    type: "error",
    class: "server",
    retryable: false,
    phase: "after_stream_started",
    message: "boom",
  });
  const incomplete = createResponsesTranslator().push("response.incomplete", {});
  const finish = incomplete.find((event) => event.type === "finish");
  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "length");
});

test("lifecycle frames carry no fact and EOF without a terminal frame is a protocol failure", () => {
  const translator = createResponsesTranslator();
  assert.deepEqual(translator.push("response.created", { response: { id: "r-1" } }), []);
  assert.deepEqual(translator.push("response.in_progress", {}), []);
  assert.deepEqual(translator.push("response.output_item.added", { output_index: 0 }), []);
  const done = translator.complete();
  assert.equal(done.some(event => event.type === "finish"), false);
  assert.ok(done.some(event => event.type === "error" && event.class === "protocol"));
  assert.deepEqual(translator.complete(), []);
});
