import assert from "node:assert/strict";
import { test } from "node:test";
import { discoveryProvider, INVOKE_SPEC, MCP_INVOKE, MCP_SEARCH } from "../adapters/mcp-runtime/discovery-provider.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

const INPUT = { sessionId: "preparation-boundary", turnId: "turn", correlationId: "test", text: "Answer the current task." };

test("a failed preparation has one durable failure terminal without sending", async () => {
  let sends = 0;
  const provider: ProviderPort = { async prepareRequest() { throw new Error("preparation source unavailable"); },
    async *stream() { sends++; } };
  const result = await runTurn({ provider, tools: createFakeTools([], []), permission: createFakePermission("approved"),
    profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0 }) }, INPUT);

  assert.equal(sends, 0);
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
  assert.ok(result.inputs.some(input => input.type === "transport_fail" && input.message === "request_preparation_failed"));
});

for (const failOn of [1, 2]) test(`a prepared request application failure at application ${failOn} settles once without sending`, async () => {
  let sends = 0, applications = 0;
  const provider: ProviderPort = {
    async prepareRequest() {
      return { apply: request => {
        if (++applications === failOn) throw new Error("presentation unavailable");
        return { ...request, messages: [...request.messages, { role: "system" as const, content: "context ".repeat(1_200) }] };
      } };
    },
    async *stream() { sends++; },
  };
  const result = await runTurn({ provider, tools: createFakeTools([], []), permission: createFakePermission("approved"),
    profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0 }) },
  { ...INPUT, budget: { contextTokenLimit: 6_000 }, resumedTranscript: [
    { kind: "user", sequence: 0, text: "An older completed task." },
    { kind: "assistant_text", sequence: 1, blockId: "old", text: "old history ".repeat(1_400) },
  ] });

  assert.equal(sends, 0);
  assert.equal(applications, failOn);
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
  assert.ok(result.inputs.some(input => input.type === "transport_fail" && input.message === "request_preparation_failed"));
});

test("a preparation rejected after cancellation still records a cancelled turn without sending", async () => {
  const cancellation = new AbortController();
  let sends = 0;
  const provider: ProviderPort = {
    async prepareRequest(_request, signal) {
      cancellation.abort();
      signal.throwIfAborted();
      return { apply: request => request };
    },
    async *stream() {
      sends++;
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const result = await runTurn({ provider, tools: createFakeTools([], []), permission: createFakePermission("approved"),
    profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0 }) },
  { ...INPUT, cancelSignal: cancellation.signal, budget: { contextTokenLimit: 10_000 } });

  assert.equal(sends, 0);
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
});

test("a large loaded MCP catalog cannot stop a small presented request before preparation", async () => {
  const requests: ProviderRequest[] = [];
  const provider = discoveryProvider({ async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "answer", text: "Completed the current answer." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } }, () => false);
  const common = echoBinding({ needsApproval: false });
  const tools = createFakeTools([], [
    { ...common, name: MCP_SEARCH, description: "Search external definitions." },
    { ...common, ...INVOKE_SPEC },
    { ...common, name: "mcp__server__loaded", description: "Loaded external schema observation. ".repeat(500) },
  ]);
  const result = await runTurn({ provider, tools, permission: createFakePermission("approved"),
    profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0 }) },
  { ...INPUT, budget: { contextTokenLimit: 1_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.tools.map(tool => tool.name), [MCP_SEARCH, MCP_INVOKE]);
  assert.ok(requests[0]?.messages.filter(message => message.role === "system")
    .every(message => !message.content.includes("mcp__server__loaded")));
});
