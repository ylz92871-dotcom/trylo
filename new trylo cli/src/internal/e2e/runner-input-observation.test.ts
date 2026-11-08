import assert from "node:assert/strict";
import test from "node:test";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createModelSummarizer } from "../surface/cli/compact-model-summarizer.js";
import { createOpenAiTranslator } from "../adapters/provider/openai-translate.js";
import { emptyUsage, type ProviderEvent, type ProviderPort } from "../ports/provider.js";
import { isSummaryRequestUsage } from "../ports/compaction.js";

function usage(input: number, output: number): ProviderEvent[] {
  return createOpenAiTranslator().push({ usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
}

test("runner keeps complete zero and the last valid past main basis without changing financial totals", async () => {
  let streams = 0;
  const provider: ProviderPort = {
    async prepareRequest() { return { apply: request => request }; },
    async *stream() {
      const index = streams++;
      if (index < 2) yield* usage(index === 0 ? 100 : 0, 2);
      if (index < 3) {
        yield { type: "tool_call", toolCallId: `read-${index}`, name: "echo", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "first completed"), toolResult({}, "second completed"), toolResult({}, "third completed")],
      [echoBinding({ needsApproval: false })]), compaction: compactionWiring({ nowMs: 0 }),
  }, { sessionId: "zero-basis", turnId: "current", correlationId: "c", model: "fixture", text: "Read three records then finish.",
    budget: { contextTokenLimit: 100000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(streams, 4);
  assert.deepEqual(result.usage, { ...emptyUsage(), inputTokens: 100, outputTokens: 4, totalTokens: 104 });
  assert.equal("inputTokenObservation" in result.usage, false);
  const observations = result.envelopes.filter(envelope => envelope.kind === "observation" && envelope.payload.component === "prompt_budget");

  assert.equal(observations.length, 4);
  assert.deepEqual(observations.map(envelope => envelope.payload.observedInputTokens), [undefined, 100, 0, 0]);
  assert.equal(observations[2]?.payload.basis, "server_plus_added");
  assert.equal(observations[3]?.payload.basis, "server_plus_added");

  for (const [index, envelope] of observations.entries()) {
    assert.equal(envelope.payload.streamIndex, index + 1);
    assert.equal(envelope.payload.attemptId, envelope.attemptId);
  }
});

test("auxiliary complete input is isolated from the main request basis and persisted financial receipt shape", async () => {
  let mainCalls = 0, auxiliaryCalls = 0;
  const provider: ProviderPort = {
    async prepareRequest() { return { apply: request => request }; },
    async *stream(request) {
      const auxiliary = request.attemptId === "compact-summary";
      if (auxiliary) auxiliaryCalls++;
      else mainCalls++;

      yield* usage(auxiliary ? 7000 : 100, auxiliary ? 5 : 2);

      if (auxiliary) {
        yield { type: "text_start", blockId: "summary" };
        yield { type: "text_delta", blockId: "summary", text: "The earlier synthetic record is completed; continue the current request." };
        yield { type: "text_end", blockId: "summary" };
      }

      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const estimate = (messages: readonly { readonly content?: string }[]) =>
    messages.some(message => message.content?.includes("OLDER_LARGE_CONTEXT")) ? 9500 : 100;
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], []), compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: estimate,
      summarize: createModelSummarizer({ provider, model: "fixture", contextTokenLimit: 10000 }) }),
  }, { sessionId: "aux-isolation", turnId: "main", correlationId: "c", model: "fixture", text: "Continue the current request.",
    budget: { contextTokenLimit: 10000 }, resumedTranscript: [
      { kind: "user", sequence: 0, text: "A finished earlier record." },
      { kind: "assistant_text", sequence: 1, blockId: "old-large", text: "OLDER_LARGE_CONTEXT " + "public synthetic material ".repeat(600) },
      { kind: "user", sequence: 2, text: "A finished recent record." },
      { kind: "assistant_text", sequence: 3, blockId: "recent", text: "The recent record is complete." },
    ] });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(mainCalls, 1);
  assert.equal(auxiliaryCalls, 1);
  assert.deepEqual(result.mainUsage, { ...emptyUsage(), inputTokens: 100, outputTokens: 2, totalTokens: 102 });
  assert.deepEqual(result.auxiliaryUsage, { ...emptyUsage(), inputTokens: 7000, outputTokens: 5, totalTokens: 7005 });
  assert.deepEqual(result.usage, { ...emptyUsage(), inputTokens: 7100, outputTokens: 7, totalTokens: 7107 });
  const receipt = result.auxiliaryRequests?.[0];

  assert.ok(receipt !== undefined && isSummaryRequestUsage(receipt));
  assert.equal("inputTokenObservation" in receipt, false);
  assert.equal("inputTokenObservation" in receipt.usage!, false);
  const persistedReceipt = JSON.parse(JSON.stringify(receipt));

  assert.equal(isSummaryRequestUsage(persistedReceipt), true);
  assert.deepEqual(persistedReceipt.usage, result.auxiliaryUsage);
  const observations = result.envelopes.filter(envelope => envelope.kind === "observation" && envelope.payload.component === "prompt_budget");

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.payload.basis, "local");
  assert.equal(observations[0]?.payload.observedInputTokens, undefined,
    "an auxiliary report cannot become the first main request's previous input basis");
});
