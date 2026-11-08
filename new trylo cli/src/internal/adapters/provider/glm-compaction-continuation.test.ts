import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { runTurn } from "../../loop/runner.js";
import { createFakeCompaction, createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../../loop/fakes.js";
import { createCompactionLedger, promptMessages } from "../../loop/compact-boundary.js";
import type { Transcript } from "../../protocol/transcript.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const thought = "Synthetic tool continuation for compaction contracts.";

type WireMessage = { role: string; content: string; reasoning_content?: string; tool_call_id?: string; tool_calls?: { id: string }[] };

function fixture(count: number, text: string) {
  const bodies: { messages: WireMessage[] }[] = [];
  const provider = createOpenAiCompatibleProvider({ endpoint, model: "glm-5.3-flash", apiKey: "fixture-key",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: WireMessage[] });
      const frames = bodies.length === 1 ? [
        { choices: [{ delta: { reasoning_content: thought, content: text,
          tool_calls: Array.from({ length: count }, (_,i) => ({ index: i, id: `call-${i}`,
            function: { name: "echo", arguments: JSON.stringify({ value: i }) } })) }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ] : [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }];

      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    },
  });

  return { bodies, provider };
}

for (const count of [1, 2]) for (const text of ["", "Checking both tool outputs."]) {
  test(`GLM continuation survives real loop compaction: ${count} calls, text=${text.length > 0}`, async () => {
    const f = fixture(count, text);
    const compact = createFakeCompaction({ estimatedPromptTokens: 9_000, estimatedAfterCompactionTokens: 100 });
    const result = await runTurn({ provider: f.provider, permission: createFakePermission("approved"), profile: emptyProfileLoader(),
      tools: createFakeTools(Array.from({ length: count }, (_,i) => toolResult({ value: i }, `RESULT-${i}`)), [echoBinding({ needsApproval: false })]),
      compaction: compact.wiring,
    }, { sessionId: "s", turnId: "t", correlationId: "c", model: "glm-5.3-flash", text: "Run synthetic tools.", budget: { maxIterations: 4, contextTokenLimit: 8_000 } });

    assert.equal(result.compactions.length, 1, "the production compaction service actually stored a window");
    assert.equal(result.state.terminalReason, "completed");
    const messages = f.bodies[1]!.messages;
    const assistant = messages.find(message => message.role === "assistant")!;

    assert.equal(assistant.content, text);
    assert.equal(assistant.reasoning_content, thought);
    assert.deepEqual(assistant.tool_calls?.map(call => call.id), Array.from({ length: count }, (_,i) => `call-${i}`));
    assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), assistant.tool_calls?.map(call => call.id));
    assert.equal(messages.some(message => message.content.includes("SUMMARY-MARKER")), true);
    assert.equal(messages.some(message => message.content === "Run synthetic tools."), true, "original user instructions survive the lossy summary");
  });
}

test("a window cutting a tool exchange restores its missing prefix once, before the live results", () => {
  const transcript: Transcript = [
    { kind: "user", sequence: 0, text: "Old user input" },
    { kind: "assistant_text", sequence: 1, blockId: "b", text: "Checking." },
    { kind: "tool_call", sequence: 2, toolCallId: "a", name: "echo", arguments: {} },
    { kind: "tool_call", sequence: 3, toolCallId: "b", name: "echo", arguments: {} },
    { kind: "tool_result", sequence: 4, toolCallId: "a", name: "echo", output: "A", outcome: "succeeded", truncated: false },
    { kind: "tool_result", sequence: 5, toolCallId: "b", name: "echo", output: "B", outcome: "succeeded", truncated: false },
  ];
  for (const replacedPrefix of [3, 4, 5, 6]) {
    const ledger = createCompactionLedger();

    ledger.replacedPrefix = replacedPrefix;
    ledger.window = { windowId: "w1", replacedFromSequence: 0, replacedToSequence: replacedPrefix, summary: "Summary", formatVersion: "1" };
    const messages = promptMessages({ transcript, seedMessages: [], ledger });

    assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "tool", "tool"]);
    assert.equal(messages[1]!.content, "Old user input");
    assert.equal(messages[2]!.content, "Checking.");
    assert.deepEqual(messages[2]!.toolCalls?.map(call => call.toolCallId), ["a", "b"]);
    assert.deepEqual(messages.slice(3).map(message => message.toolCallId), ["a", "b"]);
  }
});

test("a new turn restores ordinary transcript but does not reuse the prior turn's native cache", async () => {
  const f = fixture(1, "Checking.");
  const ports = { provider: f.provider, permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    tools: createFakeTools([toolResult({ ok: true })], [echoBinding({ needsApproval: false })]) };
  const first = await runTurn(ports, { sessionId: "s", turnId: "t1", correlationId: "c1", model: "glm-5.3-flash", text: "First input", budget: { maxIterations: 4 } });

  await runTurn(ports, { sessionId: "s", turnId: "t2", correlationId: "c2", model: "glm-5.3-flash", text: "Second input", resumedTranscript: first.transcript, budget: { maxIterations: 4 } });
  const resumed = f.bodies.at(-1)!.messages;

  assert.equal(resumed.some(message => message.content === "First input"), true);
  assert.equal(resumed.some(message => message.content === "Second input"), true);
  assert.equal(resumed.some(message => message.role === "tool"), true);
  assert.equal(resumed.some(message => message.reasoning_content !== undefined), false);
});

test("resuming with a partial window preserves call pairing before the new user input", () => {
  const transcript: Transcript = [
    { kind: "user", sequence: 0, text: "Old input" },
    { kind: "assistant_text", sequence: 1, blockId: "b", text: "Checking." },
    { kind: "tool_call", sequence: 2, toolCallId: "a", name: "echo", arguments: {} },
    { kind: "tool_call", sequence: 3, toolCallId: "b", name: "echo", arguments: {} },
    { kind: "tool_result", sequence: 4, toolCallId: "a", name: "echo", output: "A", outcome: "succeeded", truncated: false },
    { kind: "tool_result", sequence: 5, toolCallId: "b", name: "echo", output: "B", outcome: "succeeded", truncated: false },
    { kind: "user", sequence: 6, text: "Resume" },
  ];
  for (const replacedPrefix of [2, 3, 4, 5]) {
    const ledger = createCompactionLedger();

    ledger.replacedPrefix = replacedPrefix;
    ledger.window = { windowId: "w1", replacedFromSequence: 0, replacedToSequence: replacedPrefix, summary: "Summary", formatVersion: "1" };
    const messages = promptMessages({ transcript, seedMessages: [], ledger });

    assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "tool", "tool", "user"]);
    assert.equal(messages[1]!.content, "Old input");
    assert.equal(messages[2]!.content, "Checking.");
    assert.deepEqual(messages[2]!.toolCalls?.map(call => call.toolCallId), ["a", "b"]);
    assert.deepEqual(messages.slice(3, 5).map(message => message.toolCallId), ["a", "b"]);
    assert.equal(messages.at(-1)!.content, "Resume");
  }
});
