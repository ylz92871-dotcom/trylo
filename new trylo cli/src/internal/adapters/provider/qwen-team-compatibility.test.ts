import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderEvent, ProviderMessage } from "../../ports/provider.js";

const endpoint = "https://developer.amd.com.cn/radeon/api/v1/chat/completions";

for (const model of ["Qwen3.8-Flash-Next", "self-dploy/Qwen3.8-Flash-Next"]) {
  test(`AMD ${model} team instructions lead the wire conversation without losing tool results`, async () => {
    const messages: readonly ProviderMessage[] = [
      { role: "system", content: "member policy" }, { role: "user", content: "assignment" },
      { role: "assistant", content: "", toolCalls: [{ toolCallId: "read", name: "read_file", arguments: { path: "input.json" } }] },
      { role: "tool", toolCallId: "read", content: "actual input" },
      { role: "user", content: "follow-up" }, { role: "system", content: "current tools and budget" },
    ];
    const before = JSON.stringify(messages);
    let actual: { messages: Array<Record<string, unknown>> } | undefined;
    const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "unit-key", fetchImpl: async (_url, init) => {
      actual = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } });

    for await (const event of provider.stream({ attemptId: "team-follow-up", model, messages, tools: [] }, new AbortController().signal)) {
      assert.notEqual(event.type, "error");
    }

    assert.ok(actual);
    assert.deepEqual(actual.messages.map(message => message.role), ["system", "user", "assistant", "tool", "user"]);
    assert.equal(actual.messages[0]?.content, "member policy\n\ncurrent tools and budget");
    assert.equal(actual.messages[3]?.tool_call_id, "read");
    assert.equal(actual.messages[3]?.content, "actual input");
    assert.equal(JSON.stringify(messages), before, "wire normalization never mutates canonical history");
  });
}

test("AMD BadRequest SSE errors are typed invalid requests without exposing upstream text or replaying", async () => {
  let requests = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint, model: "Qwen3.8-Flash-Next", apiKey: "unit-key", fetchImpl: async () => {
    requests += 1;
    return new Response('event: error\ndata: {"error":{"type":"BadRequest","code":"client_error","message":"PRIVATE_MESSAGE","responseText":"PRIVATE_RESPONSE"}}\n\ndata: [DONE]\n\n');
  } });
  const events: ProviderEvent[] = [];

  for await (const event of provider.stream({ attemptId: "bad-request", model: "Qwen3.8-Flash-Next", messages: [], tools: [] }, new AbortController().signal)) events.push(event);

  assert.deepEqual(events.filter(event => event.type === "error"), [{ type: "error", class: "invalid_request", retryable: false,
    phase: "after_stream_started", message: "provider_stream_invalid_request_error" }]);
  assert.equal(requests, 1);
  assert.equal(events.some(event => event.type === "finish"), false);
  assert.equal(JSON.stringify(events).includes("PRIVATE_"), false);
});
