import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "./runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader } from "./fakes.js";
import type { ProviderEvent, ProviderRequest } from "../ports/provider.js";

test("per-response length limits continue the same task without an implicit continuation count", async () => {
  const requests: ProviderRequest[] = [];
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], []), provider: { async *stream(request): AsyncIterable<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      yield { type: "text_start", blockId: `block-${index}` };
      yield { type: "text_delta", blockId: `block-${index}`, text: `saved progress ${index}` };
      yield { type: "text_end", blockId: `block-${index}` };
      yield { type: "finish", reason: index < 6 ? "length" : "stop", rawReason: index < 6 ? "length" : "stop", requiresFollowUp: false };
    } } }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Finish the original task." });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 7);
  assert.ok(requests[1]?.messages.some(message => message.content.includes("saved progress 0")));
  assert.ok(requests[1]?.messages.some(message => message.content.includes("per-response output limit")));
  assert.ok(requests.every(request => request.maxOutputTokens === undefined));
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
});

test("provider truncation still honors an explicit cumulative output allowance", async () => {
  let calls = 0;
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], []), provider: { async *stream(): AsyncIterable<ProviderEvent> {
      calls++;
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 50,
        totalTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
    } } }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Do the task.", budget: { maxOutputTokens: 50 } });

  assert.equal(calls, 1);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.envelopes.some(envelope => envelope.payload.cause === "output_tokens_exhausted"));
});

test("identical truncated responses stop with a progress diagnosis instead of retrying forever", async () => {
  const requests: ProviderRequest[] = [];
  const explanation = "The continuation repeated unchanged output. The task remains unfinished; further work did not run.";
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], [echoBinding({ needsApproval: false })]), provider: { async *stream(request): AsyncIterable<ProviderEvent> {
      requests.push(request);
      const calls = requests.length;
      assert.ok(calls <= 3, "an interruption report cannot start another work or report loop");
      yield { type: "text_start", blockId: `block-${calls}` };
      yield { type: "text_delta", blockId: `block-${calls}`, text: calls === 3 ? explanation : "same unchanged partial answer" };
      yield { type: "text_end", blockId: `block-${calls}` };
      yield { type: "finish", reason: calls < 3 ? "length" : "stop", rawReason: calls < 3 ? "length" : "stop", requiresFollowUp: false };
    } } }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Finish." });

  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.tools.some(tool => tool.name === "echo"), true);
  assert.deepEqual(requests[2]?.tools, [], "the explanation request cannot execute another action");
  assert.ok(requests[2]?.messages.some(message => message.content.includes("repeated the same content without progress")));
  assert.ok(result.transcript.some(item => item.kind === "assistant_text" && item.text === explanation));
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.envelopes.some(envelope => envelope.payload.cause === "output_continuation_no_progress"));
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
});

test("cancellation between truncated responses does not start another provider request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], []), provider: { async *stream(): AsyncIterable<ProviderEvent> {
      calls++;
      yield { type: "text_start", blockId: "partial" };
      yield { type: "text_delta", blockId: "partial", text: "durable partial answer" };
      yield { type: "text_end", blockId: "partial" };
      controller.abort();
      yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
    } } }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Finish.", cancelSignal: controller.signal });

  assert.equal(calls, 1);
  assert.equal(result.state.terminalReason, "cancelled");
  assert.ok(result.transcript.some(item => item.kind === "assistant_text" && item.text === "durable partial answer"));
});
