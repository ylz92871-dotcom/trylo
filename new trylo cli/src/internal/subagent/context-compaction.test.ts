import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import { estimateMessagesTokens } from "../compaction/token-estimate.js";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";

const permission = { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } };
const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "error", code: "unused", message: "unused" }), cancel: async () => {} };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
function value(result: Awaited<ReturnType<ToolPort["execute"]>>): JsonObject { assert.equal(result.outcome, "result"); return result.outcome === "result" ? result.value : {}; }

test("long child history is compacted under a real request ceiling and stays compacted after parking", async t => {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) { requests.push(request); yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: "old observation ".repeat(1500) }; yield { type: "text_end", blockId: "answer" }; yield finish; } };
  const runtime = new SubagentRuntime({ tools });
  const control = createSubagentControlTool({ runtime, provider, permission, childBudget: { contextTokenLimit: 2400 },
    callerMessages: [{ role: "system", content: "PROJECT_FIXED_RULE_81" }] });
  t.after(async () => { await runtime.cancelAll(); });
  let seq = 0;
  const call = async (name: string, args: JsonObject) => value(await control.execute({ name, toolCallId: `call-${++seq}`, arguments: args }, new AbortController().signal));
  const id = String((await call("spawn_agent", { message: "ORIGINAL_USER_RULE_42" }))["agent_id"]);
  await call("wait_agent", { targets: [id], timeout_ms: 1000 });
  await call("send_input", { target: id, message: "CORRECTION_USER_RULE_13" });
  await call("wait_agent", { targets: [id], timeout_ms: 1000, release_on_ready: true });
  await call("send_input", { target: id, message: "AFTER_PARK_23" });
  const last = await call("wait_agent", { targets: [id], timeout_ms: 1000 });
  assert.equal(requests.length, 3, JSON.stringify(last));
  for (const request of requests) assert.ok(estimateMessagesTokens(request.messages) < 2400, "every sent request fits its context ceiling");
  assert.ok(requests[1]?.messages.some(message => message.content.includes("[compacted history")), "child loop must actually compact");
  const final = JSON.stringify(requests.at(-1)?.messages);
  for (const token of ["PROJECT_FIXED_RULE_81", "ORIGINAL_USER_RULE_42", "CORRECTION_USER_RULE_13", "AFTER_PARK_23", "[compacted history"]) assert.ok(final.includes(token), token);
});

test("one child's tool continuation is not evicted by a sibling provider request", async t => {
  const wire: JsonObject[] = [];
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const echo: ToolPort = { snapshot: () => [{ name: "echo", description: "read", parameters: {}, sideEffect: "read_only", needsApproval: false,
    timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 10 } }], execute: async () => { entered(); await gate;
    return { outcome: "result", value: {}, output: "ECHO_A_RESULT", truncated: false }; }, cancel: async () => {} };
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", model: "glm-5.3-flash", apiKey: "fixture-only",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject; wire.push(body);
      const messages = body["messages"] as JsonObject[];
      const a = messages.some(message => message["content"] === "TASK_A");
      const follow = messages.some(message => message["role"] === "tool");
      if (a && follow) assert.equal(messages.find(message => message["role"] === "assistant")?.["reasoning_content"], "SYNTHETIC_A_NATIVE");
      const delta = a && !follow ? { content: "A checking", reasoning_content: "SYNTHETIC_A_NATIVE", tool_calls: [{ index: 0, id: "a-call", type: "function", function: { name: "echo", arguments: "{}" } }] }
        : { content: a ? "A done" : "B done", reasoning_content: a ? "SYNTHETIC_A_END" : "SYNTHETIC_B_NATIVE" };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: a && !follow ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
  const runtime = new SubagentRuntime({ tools: echo });
  const control = createSubagentControlTool({ runtime, provider, permission, model: "glm-5.3-flash", allowedTools: ["echo"] });
  t.after(async () => { release(); await runtime.cancelAll(); });
  let seq = 0;
  const call = async (name: string, args: JsonObject) => value(await control.execute({ name, toolCallId: `native-${++seq}`, arguments: args }, new AbortController().signal));
  const a = String((await call("spawn_agent", { message: "TASK_A" }))["agent_id"]); await blocked;
  const b = String((await call("spawn_agent", { message: "TASK_B" }))["agent_id"]); await call("wait_agent", { targets: [b], timeout_ms: 1000 });
  release(); const answer = (await call("wait_agent", { targets: [a], timeout_ms: 1000 }))["results"] as JsonObject;
  assert.match(String((answer[a] as JsonObject)["output"]), /A done$/);
  assert.equal(wire.length, 3);
  const final = JSON.stringify(wire.at(-1));
  assert.ok(final.includes("SYNTHETIC_A_NATIVE")); assert.ok(!final.includes("SYNTHETIC_B_NATIVE"));
});
