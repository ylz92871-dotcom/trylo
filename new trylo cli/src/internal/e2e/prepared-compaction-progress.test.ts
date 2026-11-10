import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { runTurn, type LoopPorts } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { emptyUsage, type ProviderEvent, type ProviderRequest } from "../ports/provider.js";
import { boundMessagesTextTokens, estimateMessagesTokens, estimateToolSpecsTokens } from "../compaction/token-estimate.js";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";

/** The installed long-task failure: a byte bound stays above the window even
 * though complete provider measurements leave ample space after one cut. */
for (const prepared of [true, false]) for (const reportsUsage of [true, false]) test(`irreducible text does not resummarize every tool step; prepared=${prepared}; usage=${reportsUsage}`, async () => {
  let authored = 0;
  const sent: ProviderRequest[] = [];
  const ports: LoopPorts = {
    profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, summarize: () => {
      authored++;
      return "Earlier work completed. Continue from the latest tool result.";
    } }),
    provider: {
      ...(prepared ? { async prepareRequest() {
        const context = { role: "system" as const, content: "fixed host input ".repeat(1_500) };
        return { apply: (request: ProviderRequest) => ({ ...request, messages: [...request.messages, context] }) };
      } } : {}),
      async *stream(request): AsyncIterable<ProviderEvent> {
        sent.push(request);
        if (reportsUsage) yield { type: "usage", usage: { ...emptyUsage("snapshot"), inputTokens: 7_000, totalTokens: 7_000 },
          inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 7_000 } };
        if (sent.length <= 60) {
          yield { type: "tool_call", toolCallId: `step-${sent.length}`, name: "echo", arguments: {} };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  };
  const result = await runTurn(ports, { sessionId: "compression-progress", turnId: "long-task", correlationId: "c",
    model: "fixture", text: "Finish the remaining operations.", budget: { contextTokenLimit: 10_000 },
    ...(prepared ? {} : { callerMessages: [{ role: "system" as const, content: "fixed host input ".repeat(1_500) }] }),
    resumedTranscript: [
      { kind: "user", sequence: 0, text: "Complete the task without replaying finished actions." },
      { kind: "assistant_text", sequence: 1, blockId: "old", text: "completed old observation ".repeat(700) },
    ] });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(sent.length, 61, "all sixty tool steps continue under the original task");
  assert.equal(authored, 1, "an ineffective byte-bound cut stays latched until real capacity clears it");
  assert.equal(result.compactions.length, 1);
  assert.equal(result.envelopes.filter(e => e.payload.component === "compaction" && e.payload.status === "started").length, 1);
  assert.ok(sent.every(request => request.messages.some(message => message.content === "Finish the remaining operations.")));
  if (reportsUsage) assert.ok(result.envelopes.filter(e => e.payload.component === "prompt_budget"
    && e.payload.basis === "server_plus_added").length >= 59, "new tool results reuse the matching complete input basis");
});

test("a prepared cut that cannot shrink the request preserves the previous view and emits no completed window", async () => {
  let authored = 0;
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: createFakeTools([], []),
    compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: boundMessagesTextTokens, estimateAccuracy: "text_upper_bound",
      summarize: () => { authored++; return "No older actions exist to replace."; } }),
    provider: {
      async prepareRequest() { return { apply: (request: ProviderRequest) => request }; },
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  }, { sessionId: "no-reduction", turnId: "t", correlationId: "c", text: "Preserved user input. ".repeat(1_000),
    budget: { contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "completed", "a text upper bound alone cannot prove model overflow");
  assert.equal(authored, 1);
  assert.equal(result.compactions.length, 0, "non-reducing drafts must not replace the prompt or its measured identity");
  assert.equal(result.envelopes.filter(e => e.kind === "compact").length, 0);
  assert.ok(result.envelopes.some(e => e.payload.component === "compaction" && e.payload.reason === "nothing_to_reduce"));
});

test("new measured pressure can compact repeatedly after earlier windows cleared the trigger", async () => {
  let sends = 0;
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools(Array.from({ length: 40 }, (_, index) => toolResult({}, `Observation ${index}: ` + "result ".repeat(700))),
      [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: estimateMessagesTokens,
      summarize: () => "Earlier observations were inspected. Continue without replaying actions." }),
    provider: {
      async prepareRequest() { return { apply: (request: ProviderRequest) => request }; },
      async *stream(request): AsyncIterable<ProviderEvent> {
        sends++;
        const tokens = estimateMessagesTokens(request.messages) + estimateToolSpecsTokens(request.tools);
        yield { type: "usage", usage: { ...emptyUsage("snapshot"), inputTokens: tokens, totalTokens: tokens },
          inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens } };
        if (sends <= 40) {
          yield { type: "tool_call", toolCallId: `growth-${sends}`, name: "echo", arguments: {} };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  }, { sessionId: "real-growth", turnId: "t", correlationId: "c", model: "fixture", text: "Inspect all forty observations.",
    budget: { contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(sends, 41);
  assert.ok(result.compactions.length >= 4, "there is no turn-wide count limit on useful compaction");
  for (const event of result.envelopes.filter(e => e.kind === "compact")) {
    assert.ok(Number(event.payload.tokensAfter) < Number(event.payload.tokensBefore));
    assert.ok(Number(event.payload.tokensAfter) < 9_000, "a cleared window re-arms the next growth cycle");
  }
});

for (const model of ["ark-code-latest", "deepseek-v4.1-flash"]) test(`real Chat serialization survives sixty steps without a compaction storm; model=${model}`, async () => {
  let authored = 0, sends = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
    model, apiKey: "fixture-key", fetchImpl: async (_url, init) => {
      sends++;
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; reasoning_content?: string }[] };
      if (sends > 1 && model === "deepseek-v4.1-flash") {
        assert.ok(body.messages.some(message => message.reasoning_content === "Synthetic native continuation."));
      }
      const more = sends <= 60;
      const delta = more ? { reasoning_content: "Synthetic native continuation.", tool_calls: [{ index: 0, id: `native-${sends}`,
        function: { name: "echo", arguments: "{}" } }] } : { content: "Completed all sixty observations." };
      const frames = [{ choices: [{ delta, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: more ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 7_000, completion_tokens: 50, total_tokens: 7_050 } }];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
    compaction: { ...compactionWiring({ nowMs: 0, summarize: () => { authored++; return "Earlier work completed. Continue the task."; } }),
      estimatePromptTokens: messages => boundMessagesTextTokens(messages)
        + (provider.continuation?.estimateOverheadTokens?.(messages) ?? 0) },
  }, { sessionId: "native-compression-progress", turnId: "t", correlationId: "c", model,
    text: "Finish the requested task.", budget: { contextTokenLimit: 10_000 },
    callerMessages: [{ role: "system", content: "Immutable host input ".repeat(1_200) }], resumedTranscript: [
      { kind: "user", sequence: 0, text: "Complete all observations." },
      { kind: "assistant_text", sequence: 1, blockId: "old", text: "Finished old work ".repeat(1_000) },
    ] });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(sends, 61);
  assert.equal(authored, 1);
  assert.equal(result.compactions.length, 1);
});
