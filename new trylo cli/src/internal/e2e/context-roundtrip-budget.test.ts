import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { compactionWiring, estimatePromptTokens } from "../surface/cli/compaction-wiring.js";

type Body = { max_tokens: number; reasoning_effort: string; messages: { role: string; content: string; reasoning_content?: string; tool_call_id?: string }[] };

test("parallel results, native reasoning and remaining output budget survive the real Chat serializer", async () => {
  const bodies: Body[] = [];
  const reasoning = "Synthetic continuation.";
  const outputs = ["A", "B"].map(marker => marker.repeat(12_000) + `MIDDLE-${marker}` + marker.repeat(12_000));
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
    model: "ark-code-latest", apiKey: "fixture-key", reasoningEffort: "high",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const first = bodies.length === 1;
      const delta = first ? { reasoning_content: reasoning, tool_calls: [0, 1].map(index => ({ index, id: `call-${index}`,
        function: { name: "echo", arguments: "{}" } })) } : { reasoning_content: "Synthetic final thought.", content: "Compared both." };
      const usage = { prompt_tokens: first ? 100 : 12_500, completion_tokens: first ? 180 : 60,
        completion_tokens_details: { reasoning_tokens: first ? 160 : 50 }, total_tokens: first ? 280 : 12_560 };
      const frames = [{ choices: [{ delta, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: first ? "tool_calls" : "stop" }] }, { choices: [], usage }];

      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools(outputs.map(output => toolResult({}, output)), [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: messages => estimatePromptTokens(messages)
      + (provider.continuation?.estimateOverheadTokens?.(messages) ?? 0) }),
  }, { sessionId: "s", turnId: "t", correlationId: "c", model: "ark-code-latest", text: "Compare both tool results.",
    budget: { maxIterations: 4, maxOutputTokens: 256, contextTokenLimit: 20_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map(body => body.max_tokens), [256, 76], "reasoning is already included in completion tokens");
  assert.deepEqual(bodies.map(body => body.reasoning_effort), ["high", "high"]);
  assert.deepEqual(bodies[1]!.messages.filter(m => m.role === "tool").map(m => m.content), outputs);
  assert.equal(bodies[1]!.messages.find(m => m.role === "assistant")!.reasoning_content, reasoning);
  assert.equal(result.usage.outputTokens, 240);
  assert.equal(result.usage.reasoningTokens, 210);
});
