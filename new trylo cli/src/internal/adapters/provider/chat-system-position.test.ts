import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderMessage } from "../../ports/provider.js";

const endpoint = "https://developer.amd.com.cn/radeon/api/v1/chat/completions";

async function wire(model: string, messages: readonly ProviderMessage[], url = endpoint) {
  let body: { messages: readonly ProviderMessage[] } | undefined;
  const provider = createOpenAiCompatibleProvider({ endpoint: url, model, apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  for await (const event of provider.stream({ attemptId: "system-position", model, messages, tools: [] }, new AbortController().signal)) {
    assert.notEqual(event.type, "error");
  }

  assert.ok(body);

  return body.messages;
}

test("AMD DeepSeek final reporting sends one leading system segment and keeps the complete conversation", async () => {
  const history: readonly ProviderMessage[] = [
    { role: "system", content: "agent rules" }, { role: "user", content: "original task" },
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "call1", name: "verify", arguments: {} }] },
    { role: "tool", content: "actual result", toolCallId: "call1" },
    { role: "system", content: "final reporting rules" },
  ];
  const before = JSON.stringify(history);
  const messages = await wire("DeepSeek-V4-Flash-Vision-Exp", history);

  assert.deepEqual(messages.filter(m => m.role === "system"), [{ role: "system", content: "agent rules\n\nfinal reporting rules" }]);
  assert.deepEqual(messages.map(m => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(messages[3]?.content, "actual result");
  assert.deepEqual((messages[2] as { tool_calls?: unknown }).tool_calls,
    [{ id: "call1", type: "function", function: { name: "verify", arguments: "{}" } }]);
  assert.equal((messages[3] as { tool_call_id?: string }).tool_call_id, "call1");
  assert.equal(JSON.stringify(history), before);
});

test("AMD namespaced DeepSeek merges seed, project and current system facts in their original order", async () => {
  const messages = await wire("self-dploy/DeepSeek-V4-Flash-Vision-Exp", [
    { role: "system", content: "seed" }, { role: "system", content: "project" },
    { role: "user", content: "task" }, { role: "system", content: "current budget" },
  ]);
  assert.deepEqual(messages, [{ role: "system", content: "seed\n\nproject\n\ncurrent budget" }, { role: "user", content: "task" }]);
});

test("other hosts and models retain their system message positions", async () => {
  const messages: readonly ProviderMessage[] = [{ role: "user", content: "task" }, { role: "system", content: "last system" }];
  assert.deepEqual(await wire("DeepSeek-V4-Flash-Vision-Exp", messages, "https://example.test/chat"), messages);
  assert.deepEqual(await wire("another-model", messages), messages);
});
