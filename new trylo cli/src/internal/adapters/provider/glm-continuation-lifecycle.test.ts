import assert from "node:assert/strict";
import { test } from "node:test";
import { createGlmToolContinuation, type GlmToolContinuation } from "./glm-tool-continuation.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderMessage, ProviderRequest } from "../../ports/provider.js";
import { runTurn } from "../../loop/runner.js";
import { createFakeCompaction, createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";
import { createModelSummarizer } from "../../surface/cli/compact-model-summarizer.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", model = "glm-5.3-flash";
const call = { toolCallId: "reused-id", name: "echo", arguments: { value: 1 } };
const message: ProviderMessage = { role: "assistant", content: "Checking.", toolCalls: [call] };
const request: ProviderRequest = { attemptId: "a", continuationScope: JSON.stringify(["s", "t"]), model, messages: [], tools: [] };
function finish(capture: GlmToolContinuation | undefined, reasoning: string) {
  assert.ok(capture);
  capture.observe({ type: "reasoning_delta", blockId: "r", text: reasoning, redacted: false });
  capture.observe({ type: "text_delta", blockId: "b", text: "Checking." });
  capture.observe({ type: "tool_call", ...call });
  capture.observe({ type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true });
  capture.commit();
}

test("native Chinese reasoning uses the same UTF-8 context estimate as visible messages", () => {
  const continuation = createGlmToolContinuation(endpoint, model);
  const reasoning = "思考预算".repeat(1_000);
  finish(continuation.begin(request), reasoning);
  assert.equal(continuation.persistence!.estimateOverheadTokens!([message]), Math.ceil(Buffer.byteLength(reasoning, "utf8") / 4));
});

test("reused tool ids preserve distinct native reasoning in complete ordered history", () => {
  const c = createGlmToolContinuation(endpoint, model), first = { ...message }, second = { ...message };
  finish(c.begin(request), "FIRST"); finish(c.begin(request), "SECOND");
  const next = c.begin({ ...request, messages: [first, second] })!;
  assert.deepEqual([next.fieldsFor(first).reasoning_content, next.fieldsFor(second).reasoning_content], ["FIRST", "SECOND"]);
});

test("an ambiguous compacted or evicted repeated identity never receives a different response's reasoning", () => {
  const c = createGlmToolContinuation(endpoint, model);
  finish(c.begin(request), "FIRST"); finish(c.begin(request), "SECOND");
  assert.equal(c.begin({ ...request, messages: [message] })!.fieldsFor(message).reasoning_content, undefined);
});

test("a late overlapping request in the same scope cannot replace the newer checkpoint", () => {
  const c = createGlmToolContinuation(endpoint, model), older = c.begin(request), newer = c.begin({ ...request, attemptId: "b" });
  finish(newer, "NEWER"); finish(older, "OLDER");
  const assistant = c.persistence!.capture(request.continuationScope!)!["assistant"];
  assert.deepEqual(assistant, { reasoning: "NEWER", text: "Checking.", calls: [call] });
});

test("an unscoped auxiliary request cannot read, retain or erase the paused parent's native state", () => {
  const c = createGlmToolContinuation(endpoint, model);
  finish(c.begin(request), "PARENT");
  const { continuationScope: _scope, ...auxiliary } = request;
  assert.equal(c.begin({ ...auxiliary, messages: [message] }), undefined);
  assert.equal(c.persistence!.capture(request.continuationScope!), undefined);
  assert.equal(c.begin({ ...request, messages: [message] })!.fieldsFor(message).reasoning_content, "PARENT");
});

test("native overhead uses exactly the fields which will be replayed", () => {
  const c = createGlmToolContinuation(endpoint, model);
  finish(c.begin(request), "123456789");
  assert.equal(c.persistence!.estimateOverheadTokens!([message]), 3);
  assert.equal(c.persistence!.estimateOverheadTokens!([{ ...message, content: "Changed." }]), 0);
  assert.equal(c.persistence!.estimateOverheadTokens!([message, { ...message }]), 0);
});

test("completed final-answer native context is preserved without inventing a tool call", () => {
  const c = createGlmToolContinuation(endpoint, model), capture = c.begin(request)!;
  capture.observe({ type: "reasoning_delta", blockId: "r", text: "FINAL_NATIVE", redacted: false });
  capture.observe({ type: "text_delta", blockId: "b", text: "Final answer." });
  capture.observe({ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false });
  capture.commit();
  const final: ProviderMessage = { role: "assistant", content: "Final answer." };
  const checkpoint = c.persistence!.capture(request.continuationScope!)!;
  assert.ok(checkpoint);
  const next = c.begin({ ...request, messages: [final] })!;
  assert.equal(next.fieldsFor(final).reasoning_content, "FINAL_NATIVE");
  const restored = createGlmToolContinuation(endpoint, model);
  restored.persistence!.restore({ sessionId: "s", turnId: "next", records: [{ formatVersion: "1", sequence: 0,
    type: "envelope", sessionId: "s", turnId: "t", at: "2026-10-16T00:00:00Z",
    payload: { envelope: { kind: "stream_end" }, providerContinuation: checkpoint } }] });
  assert.equal(restored.begin({ ...request, continuationScope: JSON.stringify(["s", "next"]), messages: [final] })!
    .fieldsFor(final).reasoning_content, "FINAL_NATIVE");
});

test("native character-budget eviction never partially replays duplicate groups", () => {
  const c = createGlmToolContinuation(endpoint, model);
  for (let i = 0; i < 5; i++) finish(c.begin(request), String(i).repeat(262_144));
  const full = Array.from({ length: 5 }, () => ({ ...message }));
  assert.equal(c.persistence!.estimateOverheadTokens!(full), 0);
  const tail = full.slice(1), next = c.begin({ ...request, messages: tail })!;
  assert.deepEqual(tail.map(item => next.fieldsFor(item).reasoning_content), Array.from({ length: 4 }, (_, i) => String(i + 1).repeat(262_144)));
});

test("production model-summary compaction preserves the parent tool continuation", async () => {
  const bodies: Array<{ messages: Array<{ role: string; reasoning_content?: string }> }> = [];
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key", fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const frames = bodies.length === 1 ? [
      { choices: [{ delta: { reasoning_content: "PARENT", content: "Checking.", tool_calls: [{ index: 0, id: call.toolCallId,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ] : [{ choices: [{ delta: { content: bodies.length === 2 ? "Safe summary." : "Done." }, finish_reason: "stop" }] }];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
  } });
  const compact = createFakeCompaction({ estimatedPromptTokens: 9000, estimatedAfterCompactionTokens: 100 });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({ value: 1 })], [echoBinding({ needsApproval: false })]),
    compaction: { ...compact.wiring, summarize: createModelSummarizer({ provider, model }) },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Use echo.", model, budget: { maxIterations: 4, contextTokenLimit: 8000 } });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 1);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1]!.messages.some(item => item.reasoning_content !== undefined), false);
  assert.equal(bodies[2]!.messages.find(item => item.role === "assistant")?.reasoning_content, "PARENT");
});
