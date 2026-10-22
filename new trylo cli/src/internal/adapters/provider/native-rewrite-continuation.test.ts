import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { consumeProviderStream } from "../../loop/stream.js";
import { transcriptToMessages } from "../../loop/transcript-messages.js";
import { createMethodChannel } from "../../loop/method-channel.js";
import { createToolGapChannel } from "../../loop/tool-gap-channel.js";
import { createMethodFeedbackChannel } from "../../loop/method-feedback-channel.js";
import { providerContinuationScope } from "../../ports/provider.js";
import type { SessionRecord } from "../../ports/session.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const model = "ark-code-latest", native = "NATIVE_EXACT_FROM_WIRE";
const variants = [
  { name: "method", fence: 'trylo-learning\n{"hint":"read","summary":"Learned."}',
    channels: () => ({ channel: createMethodChannel() }) },
  { name: "tool-gap", fence: 'trylo-tool-gap\n{"need":"read"}',
    channels: () => ({ toolGapChannel: createToolGapChannel() }) },
  { name: "feedback", fence: 'trylo-method-feedback\n{"items":[{"ref":"m1","helped":true}]}',
    channels: () => ({ feedbackChannel: createMethodFeedbackChannel([
      { ref: "m1", versionId: "v1", proposalId: "p1", nicheId: "n1" },
    ]) }) },
];

for (const variant of variants) for (const restart of [false, true]) {
  test(`native continuation survives ${variant.name} projection, restart=${restart}`, async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string; reasoning_content?: string }> }> = [];
    const raw = `Working.\n\`\`\`${variant.fence}\n\`\`\``;
    const config = { endpoint, model, apiKey: "synthetic-only", fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const delta = bodies.length === 1 ? { content: raw, reasoning_content: native,
        tool_calls: [{ index: 0, id: "call", function: { name: "echo", arguments: "{}" } }] } : { content: "DONE" };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } };
    let provider = createOpenAiCompatibleProvider(config), sequence = 0;
    const scope = providerContinuationScope("s", "t1");
    const request = { attemptId: "a", continuationScope: scope, model, messages: [], tools: [] };
    const observed = await consumeProviderStream({ port: provider, request, signal: new AbortController().signal,
      startSequence: 0, nextEventId: () => String(++sequence), ...variant.channels() });
    const messages = transcriptToMessages(observed.transcriptItems);
    const visible = messages.find(message => message.role === "assistant");
    assert.ok(visible); assert.equal(visible.content.includes("```"), false);
    const saved = provider.continuation!.capture(scope);
    assert.ok(saved);
    // A stale scope or a different tool response must never rebind this answer.
    provider.continuation!.bindCanonicalResponse?.({ scope: "stale", message: { ...visible, content: "WRONG" } });
    provider.continuation!.bindCanonicalResponse?.({ scope, message: { ...visible, content: "WRONG", toolCalls: [
      { toolCallId: "foreign", name: "echo", arguments: {} },
    ] } });
    assert.deepEqual(provider.continuation!.capture(scope), saved);
    if (restart) {
      const records: SessionRecord[] = [{ formatVersion: "1", sequence: 0, type: "envelope", sessionId: "s", turnId: "t1", at: "fixture",
        payload: { envelope: { kind: "stream_end" }, providerContinuation: saved } }];
      provider = createOpenAiCompatibleProvider(config);
      provider.continuation!.restore({ sessionId: "s", turnId: "t2", records });
    }
    await consumeProviderStream({ port: provider, request: { ...request, continuationScope: restart ? providerContinuationScope("s", "t2") : scope,
      messages: [...messages, { role: "tool", content: "OK", toolCallId: "call" }] },
    signal: new AbortController().signal, startSequence: 0, nextEventId: () => String(++sequence) });
    const replay = bodies[1]?.messages.find(message => message.role === "assistant");
    assert.equal(replay?.reasoning_content, native, "the trusted visible projection must retain its exact native continuation");
    assert.equal(replay.content, visible.content, "hidden learning cards must not return in public messages");
  });
}
