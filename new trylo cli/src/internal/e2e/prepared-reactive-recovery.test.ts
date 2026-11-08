import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateMessagesTokens, estimateToolSpecsTokens } from "../compaction/token-estimate.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

const HOST = "STABLE_HOST_OBSERVATION ".repeat(180);
const PROMPT_TOO_LONG = { type: "error", class: "invalid_request", retryable: false, phase: "before_headers",
  message: "This model's maximum context length is 8000 tokens; however, your prompt has 9000" } as const;

async function rejectedRequest(prepared: boolean, oldText: string, summary: string) {
  const requests: ProviderRequest[] = [];
  let preparations = 0;
  const provider: ProviderPort = {
    ...(prepared ? { async prepareRequest() {
      preparations++;
      const host = { role: "system" as const, content: `${HOST} preparation:${preparations}` };
      return { apply: (request: ProviderRequest) => ({ ...request, messages: [...request.messages, host] }) };
    } } : {}),
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) yield PROMPT_TOO_LONG;
      else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const result = await runTurn({ provider, tools: createFakeTools([], []), permission: createFakePermission("approved"),
    profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0, summarize: () => summary }) },
  { sessionId: "prepared-reactive-recovery", turnId: "turn", correlationId: "test", text: "Continue the current task.",
    budget: { contextTokenLimit: 10_000 }, resumedTranscript: [
      { kind: "user", sequence: 0, text: "An older task." },
      { kind: "assistant_text", sequence: 1, blockId: "old", text: oldText },
    ] });

  return { requests, result, preparations };
}

function tokens(request: ProviderRequest): number {
  return estimateMessagesTokens(request.messages) + estimateToolSpecsTokens(request.tools);
}

for (const prepared of [false, true]) {
  test(`${prepared ? "prepared" : "ordinary"} rejected requests do not retry a larger post-compaction request`, async () => {
    const { requests, result, preparations } = await rejectedRequest(prepared, "Completed it.", "Known completed observation. ".repeat(35));
    assert.equal(result.state.terminalReason, "failed", "a larger replacement cannot recover the provider's context rejection");
    assert.equal(requests.length, 1, "the same full presentation must strictly decrease before another send");
    assert.equal(preparations, prepared ? 1 : 0, "the recovery reuses its original host admission");
    assert.ok(result.inputs.some(input => input.type === "transport_fail"), "the original provider failure remains observable");
  });
}

test("a shrinking prepared recovery reuses the original snapshot without another host admission", async () => {
  const { requests, result, preparations } = await rejectedRequest(true,
    "An older completed observation. ".repeat(300), "Earlier observations are complete.");

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 2);
  const canonicalAttempts = result.envelopes.filter(envelope => envelope.kind === "api_call")
    .map(envelope => envelope.payload["attemptId"]);

  assert.deepEqual(requests.map(request => request.attemptId), canonicalAttempts,
    "each sent recovery request must match a canonical stream boundary in the active attempt");
  assert.ok(tokens(requests[1]!) < tokens(requests[0]!), "the full prepared wire has made measured local progress");
  assert.equal(preparations, 1, "compaction rebases the same snapshot instead of reading host state again");
  const host = (request: ProviderRequest) => request.messages.filter(message => message.role === "system" && message.content.startsWith(HOST));

  assert.equal(host(requests[0]!).length, 1);
  assert.deepEqual(host(requests[1]!), host(requests[0]!), "the recovery preserves the originally priced host context");
});
