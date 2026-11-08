import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import type { ProviderEvent, ProviderRequest } from "../ports/provider.js";
import type { CompactionInput } from "../loop/compact-boundary.js";
import { createCompactionLedger } from "../loop/compact-boundary.js";
import { capturePromptMeasurement, localViewBasis, requestTokenBasis } from "../loop/prompt-measurement.js";
import { buildRequest } from "../loop/request.js";

test("a consumed full tool result keeps its unchanged server measurement authoritative", async () => {
  const requests: ProviderRequest[] = [];
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "x".repeat(90_000)), toolResult({}, "next result")],
      [echoBinding({ needsApproval: false, outputLimits: { maxBytes: 200_000, maxLines: 1_000 } })]),
    compaction: compactionWiring({ nowMs: 0, summarize: () => "Completed local inspection; continue the current task." }),
    provider: { async *stream(request): AsyncIterable<ProviderEvent> {
      const index = requests.length;

      requests.push(request);
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: index === 1 ? 23_000 : 100,
        outputTokens: 10, totalTokens: index === 1 ? 23_010 : 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

      if (index === 1) {
        yield { type: "text_start", blockId: "next" };
        yield { type: "text_delta", blockId: "next", text: "next ".repeat(800) };
        yield { type: "text_end", blockId: "next" };
      }

      if (index < 2) {
        yield { type: "tool_call", toolCallId: `call-${index}`, name: "echo", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } },
  }, { sessionId: "measurement", turnId: "turn", correlationId: "c", text: "Inspect and continue.",
    budget: { contextTokenLimit: 26_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 3);
  assert.equal(result.compactions.length, 1, "The full result is still present, so its valid measured usage can trigger compaction");
});

test("a stream without usage retains the last server measurement while its prefix is unchanged", async () => {
  let requests = 0;
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({}, "x".repeat(1_000)), toolResult({}, "y".repeat(1_000)), toolResult({}, "z".repeat(8_000))],
      [echoBinding({ needsApproval: false })]),
    compaction: compactionWiring({ nowMs: 0, summarize: () => "Completed inspections; continue the task." }),
    provider: { async *stream(): AsyncIterable<ProviderEvent> {
      const index = requests++;
      if (index === 1) yield { type: "usage", usage: { mode: "snapshot", inputTokens: 6_000, outputTokens: 10,
        totalTokens: 6_010, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

      if (index < 3) {
        yield { type: "tool_call", toolCallId: `call-${index}`, name: "echo", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } },
  }, { sessionId: "measurement", turnId: "turn", correlationId: "c", text: "Inspect and continue.",
    budget: { contextTokenLimit: 8_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests, 4);
  assert.equal(result.compactions.length, 1, "Omitted usage cannot erase a still-valid measured prefix");
});

function inputOf(): CompactionInput {
  return { seedMessages: [{ role: "system", content: "Fixed project guidance." }],
    transcript: [{ kind: "user", sequence: 0, text: "Complete the task." }], ledger: createCompactionLedger(),
    wiring: compactionWiring({ nowMs: 0 }), tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
    sessionId: "measurement", contextTokenLimit: 26_000, reported: undefined };
}

function requestOf(input: CompactionInput): ProviderRequest {
  assert.ok(input.tools);
  return buildRequest({ attemptId: "a", model: "fixture", tools: input.tools, prompt: input });
}

function withMeasurement(input: CompactionInput, request = requestOf(input)): CompactionInput {
  return { ...input, reported: { promptTokens: 7_000, transcriptLength: input.transcript.length,
    windowId: input.ledger.window?.windowId, measurement: capturePromptMeasurement(request) } };
}

test("unchanged measured messages retain server authority and price only newly appended messages", () => {
  const measured = withMeasurement(inputOf());
  const next: CompactionInput = { ...measured, transcript: [...measured.transcript,
    { kind: "assistant_text", sequence: 1, blockId: "new", text: "New saved progress." }] };
  const before = requestOf(measured), after = requestOf(next);

  assert.ok(next.wiring);
  assert.ok(localViewBasis(next) < 7_000);
  assert.equal(requestTokenBasis(next), 7_000 + next.wiring.estimatePromptTokens(after.messages.slice(before.messages.length)));
});

test("a changed tool schema invalidates a measurement even when tool names are unchanged", () => {
  const measured = withMeasurement(inputOf());
  const next: CompactionInput = { ...measured, tools: createFakeTools([], [echoBinding({ needsApproval: false,
    parameters: { type: "object", properties: { value: { type: "string" } } } })]) };
  assert.deepEqual(requestOf(next).messages, requestOf(measured).messages);
  assert.equal(requestTokenBasis(next), localViewBasis(next));
});

test("a removed transient system slot cannot leave its server usage as a permanent floor", () => {
  const input = inputOf();
  const request = requestOf(input);
  const measured = withMeasurement(input, { ...request, messages: [...request.messages,
    { role: "system", content: "Transient request-only instruction." }] });
  assert.equal(requestTokenBasis(measured), localViewBasis(measured));
});

test("a changed standing system append invalidates the old request measurement", () => {
  const measured = withMeasurement({ ...inputOf(), systemPromptAppend: "Original append." });
  const next = { ...measured, systemPromptAppend: "Changed append." };
  assert.equal(requestTokenBasis(next), localViewBasis(next));
});

test("a window change invalidates an otherwise identical measurement", () => {
  const input = inputOf();
  const measured = withMeasurement(input);
  const next = { ...measured, reported: { ...measured.reported!, windowId: "old-window" } };
  assert.equal(requestTokenBasis(next), localViewBasis(next));
});

test("a measurement lacking a verifiable request identity uses the current projection", () => {
  const input = inputOf();
  const next = { ...input, reported: { promptTokens: 7_000, transcriptLength: 1, windowId: undefined } };
  assert.equal(requestTokenBasis(next), localViewBasis(next));
});

test("measurement identities stay immutable without retaining raw message content", () => {
  const input = inputOf();
  const message = { role: "user" as const, content: "Original private content." };
  const request = { ...requestOf(input), messages: [message] };
  const measurement = capturePromptMeasurement(request);

  message.content = "Changed private content.";
  const next: CompactionInput = { ...input, seedMessages: [], transcript: [{ kind: "user", sequence: 0, text: message.content }],
    reported: { promptTokens: 7_000, transcriptLength: 1, windowId: undefined, measurement } };

  assert.doesNotMatch(JSON.stringify(measurement), /private content/);
  assert.equal(requestTokenBasis(next), localViewBasis(next));
});

test("an exchange reinserted only at a compaction boundary does not keep its old measurement after consumption", () => {
  const input = inputOf();

  input.ledger.window = { windowId: "w1", replacedFromSequence: 0, replacedToSequence: 3,
    summary: "Prior inspection completed.", formatVersion: "1" };
  input.ledger.replacedPrefix = 3;
  const measured = withMeasurement({ ...input, transcript: [input.transcript[0]!,
    { kind: "tool_call", sequence: 1, toolCallId: "read", name: "echo", arguments: {} },
    { kind: "tool_result", sequence: 2, toolCallId: "read", name: "echo", outcome: "succeeded", output: "old result", truncated: false }] });
  const next: CompactionInput = { ...measured, transcript: [...measured.transcript,
    { kind: "assistant_text", sequence: 3, blockId: "next", text: "The result has been consumed." }] };

  assert.equal(requestTokenBasis(next), localViewBasis(next));
});
