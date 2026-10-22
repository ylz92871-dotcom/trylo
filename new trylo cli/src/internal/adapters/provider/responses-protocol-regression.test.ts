import assert from "node:assert/strict";
import { test } from "node:test";
import { createResponsesProvider } from "./responses.js";
import { createResponsesTranslator } from "./responses-translate.js";
import { translateResponsesBody } from "./responses-stream.js";
import { consumeProviderStream } from "../../loop/stream.js";
import type { ProviderEvent } from "../../ports/provider.js";

const frame = (event: string, payload: unknown): string => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const call = { type: "function_call", id: "item", call_id: "call", name: "echo", arguments: "{}" };
const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150,
  input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 40 } };
const completion = frame("response.completed", { response: { status: "completed", usage } });
async function observe(wire: string) {
  let sequence = 0;
  return consumeProviderStream({ port: createResponsesProvider({ endpoint: "http://local.invalid/responses", model: "synthetic",
    apiKey: "synthetic", fetchImpl: async () => new Response(wire) }),
    request: { attemptId: "a", model: "synthetic", messages: [], tools: [] }, signal: new AbortController().signal,
    startSequence: 0, nextEventId: () => String(++sequence) });
}

for (const withAdded of [true, false]) {
  test(`Responses tool blocks close under the actual call id, added=${withAdded}`, async () => {
    const wire = (withAdded ? frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } }) : "")
      + frame("response.function_call_arguments.delta", { item_id: "item", delta: "{}" })
      + frame("response.output_item.done", { output_index: 0, item: call }) + completion;
    const result = await observe(wire);
    assert.equal(result.unsettledToolInputCount, 0, "an item id must not leave a phantom partial beside the settled call id");
    assert.deepEqual(result.transcriptItems.filter(item => item.kind === "tool_call").map(item => item.toolCallId), ["call"]);
  });
}

test("Responses usage preserves reasoning and cache details without adding reasoning twice", async () => {
  const result = await observe(completion);
  assert.equal(result.usage.reasoningTokens, 40);
  assert.equal(result.usage.cacheReadTokens, 80);
  assert.equal(result.usage.outputTokens, 50);
  assert.equal(result.usage.totalTokens, 150);
});

test("Responses final arguments are authoritative and overlapping final snapshots do not repeat a call", () => {
  const translator = createResponsesTranslator();
  const item = { ...call, arguments: '{"value":7}' };
  const events = [
    ...translator.push("response.function_call_arguments.delta", { item_id: "item", delta: "{broken" }),
    ...translator.push("response.output_item.done", { output_index: 0, item }),
    ...translator.push("response.completed", { response: { status: "completed", output: [item] } }),
  ];
  assert.deepEqual(events.filter(event => event.type === "tool_call").map(event => event.arguments), [{ value: 7 }]);
  assert.equal(events.some(event => event.type === "tool_call_invalid"), false);
});

test("Responses completed-only output recovers its actual call instead of reporting empty success", () => {
  const events = createResponsesTranslator().push("response.completed", { response: { status: "completed", output: [call] } });
  assert.equal(events.filter(event => event.type === "tool_call").length, 1);
  assert.ok(events.some(event => event.type === "finish" && event.requiresFollowUp));
});

test("Responses message snapshots deliver missing text once across done and completed", () => {
  const translator = createResponsesTranslator();
  const item = { type: "message", id: "m", content: [{ type: "output_text", text: "COMPLETE" }] };
  const events = [
    ...translator.push("response.output_text.delta", { output_index: 0, delta: "COM" }),
    ...translator.push("response.output_item.done", { output_index: 0, item }),
    ...translator.push("response.completed", { response: { status: "completed", output: [item] } }),
  ];
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.text).join(""), "COMPLETE");
  assert.equal(events.filter(event => event.type === "text_end").length, 1);
});

test("Responses empty HTTP bodies fail explicitly rather than fabricating completion", async () => {
  const result = await observe("");
  assert.equal(result.sawFinish, false);
  assert.equal(result.sawError, true);
});

test("Responses token-sized reasoning fragments are coalesced without losing bytes", async () => {
  const wire = Array.from({ length: 5_000 }, () => frame("response.reasoning_summary_text.delta", { output_index: 0, delta: "x" })).join("") + completion;
  const events: ProviderEvent[] = [];
  for await (const event of translateResponsesBody(new Response(wire).body!, new AbortController().signal)) events.push(event);
  const deltas = events.filter(event => event.type === "reasoning_delta");
  assert.equal(deltas.map(event => event.text).join(""), "x".repeat(5_000));
  assert.ok(deltas.length <= 50, `expected bounded retained deltas, got ${deltas.length}`);
});
