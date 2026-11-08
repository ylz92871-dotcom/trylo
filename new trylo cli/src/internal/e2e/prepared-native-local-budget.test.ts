import assert from "node:assert/strict";
import test from "node:test";
import { createChatToolContinuation } from "../adapters/provider/glm-tool-continuation.js";
import { providerContinuationScope, type ProviderMessage, type ProviderPort, type ProviderRequest } from "../ports/provider.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", model = "glm-5.3-flash";
const INPUT = { sessionId: "native-local-budget", turnId: "current", correlationId: "test", model,
  text: "Report the already completed synthetic check.", budget: { contextTokenLimit: 1_000 } };
const scope = providerContinuationScope(INPUT.sessionId, INPUT.turnId);
const call = { toolCallId: "call:frozen-check", name: "echo", arguments: { value: 1 } };
const assistant: ProviderMessage = { role: "assistant", content: "The frozen check completed.", toolCalls: [call] };
const exchange: readonly ProviderMessage[] = [assistant, { role: "tool", toolCallId: call.toolCallId, content: "Completed successfully." }];
const reasoning = "x".repeat(36_000); // 9000 units in the existing UTF-8/4 estimator.

function fixture(cacheScope: string, oldEstimate: "with_cached_native" | "text_only") {
  const native = createChatToolContinuation(endpoint, model);
  const capture = native.begin({ attemptId: "seed", continuationScope: cacheScope, model, messages: [], tools: [] });

  assert.ok(capture);
  capture.observe({ type: "reasoning_delta", blockId: "r", text: reasoning, redacted: false });
  capture.observe({ type: "text_delta", blockId: "b", text: assistant.content });
  capture.observe({ type: "tool_call", ...call });
  capture.observe({ type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true });
  capture.commit();
  assert.ok(native.persistence);
  assert.equal(native.persistence.estimateOverheadTokens!([assistant]), 9_000);
  const requests: ProviderRequest[] = [], measured: ProviderRequest[] = [];
  const continuation = native.persistence;
  const provider: ProviderPort = {
    continuation: { ...continuation, measureRequestIdentity(request) {
      measured.push(request);
      return continuation.measureRequestIdentity!(request);
    } },
    async prepareRequest() {
      // A valid provider-owned frozen exchange is presentation input. History
      // compaction cannot make it disappear by rebuilding only the base view.
      return { apply: request => ({ ...request, messages: [...request.messages, ...exchange] }) };
    },
    async *stream(request) {
      requests.push(request);
      const sending = native.begin(request);
      assert.ok(sending);
      assert.equal(sending.fieldsFor(assistant).reasoning_content, cacheScope === scope ? reasoning : undefined);
      yield { type: "text_delta", blockId: "answer", text: "Done." };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const compaction = compactionWiring({ nowMs: 0,
    estimatePromptTokens: messages => 100 + (oldEstimate === "with_cached_native" ? continuation.estimateOverheadTokens!(messages) : 0),
    estimateTextPromptTokens: () => 100,
  });

  return { requests, measured, provider, compaction };
}

test("a prepared request does not pay native input that its real scope transition will clear", async () => {
  const h = fixture(providerContinuationScope(INPUT.sessionId, "earlier"), "with_cached_native");
  const result = await runTurn({ provider: h.provider, compaction: h.compaction,
    profile: emptyProfileLoader(), tools: createFakeTools([], []), permission: createFakePermission("approved") }, INPUT);

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(h.requests.length, 1, "100 text + zero actual native fits the 1000 window");
  assert.equal(result.compactions.length, 0, "a cache from a different scope must not provoke a false rescue");
  assert.ok(h.measured.some(request => request.messages.includes(assistant)));
});

test("actual prepared native input cannot bypass the window through an old text-only estimate", async () => {
  const h = fixture(scope, "text_only");
  const result = await runTurn({ provider: h.provider, compaction: h.compaction,
    profile: emptyProfileLoader(), tools: createFakeTools([], []), permission: createFakePermission("approved") }, INPUT);

  assert.equal(h.requests.length, 0, "the frozen native exchange alone exceeds the actual configured window");
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "context_limit"));
  assert.ok(h.measured.some(request => request.messages.includes(assistant)));
});
