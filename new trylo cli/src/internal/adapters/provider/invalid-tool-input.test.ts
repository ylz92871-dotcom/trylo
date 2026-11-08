import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnthropicTranslator } from "./anthropic-translate.js";
import { createOpenAiTranslator } from "./openai-translate.js";
import { createResponsesTranslator } from "./responses-translate.js";
import type { ProviderEvent } from "../../ports/provider.js";

function assertRecoveryHint(events: readonly ProviderEvent[]): void {
  const invalid = events.find(event => event.type === "tool_call_invalid");
  assert.ok(invalid?.type === "tool_call_invalid");
  assert.equal(invalid.rawArguments, "");
  assert.match(invalid.message, /valid JSON object/);
  assert.match(invalid.message, /without an arguments wrapper/);
  assert.equal(events.some(event => event.type === "tool_call"), false);
}

test("Chat invalid tool input reports how to repair it without echoing malformed arguments", () => {
  const translator = createOpenAiTranslator();
  translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "write_file", arguments: '{"arguments":{' } }] } }] });
  assertRecoveryHint(translator.complete());
});

test("Responses invalid tool input shares the same non-executing repair contract", () => {
  const translator = createResponsesTranslator();
  assertRecoveryHint(translator.push("response.output_item.done", { item: { type: "function_call", id: "i", call_id: "bad", name: "write_file", arguments: '{"arguments":{' } }));
});

test("Anthropic invalid tool input shares the same non-executing repair contract", () => {
  const translator = createAnthropicTranslator();
  translator.push("content_block_start", { index: 0, content_block: { type: "tool_use", id: "bad", name: "write_file" } });
  translator.push("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"arguments":{' } });
  assertRecoveryHint(translator.complete());
});

for (const family of ["Chat", "Responses", "Anthropic"] as const) {
  test(`${family} reports unclosed JSON input with a smaller-call recovery hint, never its contents`, () => {
    const raw = '{"content":"fixture-private-sentinel ' + "repeated code ".repeat(200);
    let events: readonly ProviderEvent[];

    if (family === "Chat") {
      const translator = createOpenAiTranslator();
      translator.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "write_file", arguments: raw } }] } }] });
      events = translator.complete();
    } else if (family === "Responses") {
      events = createResponsesTranslator().push("response.output_item.done", { item: { type: "function_call", id: "i", call_id: "bad", name: "write_file", arguments: raw } });
    } else {
      const translator = createAnthropicTranslator();
      translator.push("content_block_start", { index: 0, content_block: { type: "tool_use", id: "bad", name: "write_file" } });
      translator.push("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: raw } });
      events = translator.complete();
    }

    assertRecoveryHint(events);
    const invalid = events.find(event => event.type === "tool_call_invalid");

    assert.ok(invalid?.type === "tool_call_invalid");
    assert.match(invalid.message, /ended with an open JSON string or container/);
    assert.match(invalid.message, /smaller complete call/);
    assert.equal(invalid.message.includes("fixture-private-sentinel"), false);
  });
}
