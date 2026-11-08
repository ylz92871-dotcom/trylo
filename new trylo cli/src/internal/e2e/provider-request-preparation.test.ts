import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn, type LoopPorts } from "../loop/runner.js";

const INPUT = { sessionId: "prepared-context", turnId: "turn", correlationId: "test", text: "Answer the current request." };

function preparedProvider(context: string) {
  const requests: ProviderRequest[] = [];
  let preparations = 0;
  const provider: ProviderPort & {
    prepareRequest(request: ProviderRequest, signal: AbortSignal): Promise<{ apply(request: ProviderRequest): ProviderRequest }>;
  } = {
    async prepareRequest() {
      preparations++;
      const message = { role: "system" as const, content: context };
      return { apply: request => ({ ...request, messages: [...request.messages, message] }) };
    },
    async *stream(request) {
      requests.push(request);
      yield { type: "text_delta", blockId: "answer", text: "Done." };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const ports: LoopPorts = { provider, tools: createFakeTools([], []), permission: createFakePermission("approved"),
    profile: emptyProfileLoader(), compaction: compactionWiring({ nowMs: 0 }) };

  return { requests, ports, preparations: () => preparations };
}

test("request preparation reaches the sender and the context gate uses that same snapshot", async () => {
  const fake = preparedProvider("HOST_CONTEXT_EXACTLY_ONCE");
  const result = await runTurn(fake.ports, { ...INPUT, budget: { contextTokenLimit: 10_000 } });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(fake.preparations(), 1);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.messages.filter(message => message.content === "HOST_CONTEXT_EXACTLY_ONCE").length, 1);
});

test("an irreducible prepared context cannot be sent beyond the configured window", async () => {
  const fake = preparedProvider("x".repeat(20_000));
  const result = await runTurn(fake.ports, { ...INPUT, budget: { contextTokenLimit: 1_000 } });
  assert.equal(fake.preparations(), 1);
  assert.equal(fake.requests.length, 0);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "context_limit"));
});

test("prepared context can compact old history and reuse its snapshot without another admission", async () => {
  const fake = preparedProvider("y".repeat(9_000));
  const result = await runTurn(fake.ports, { ...INPUT, budget: { contextTokenLimit: 6_000 }, resumedTranscript: [
    { kind: "user", sequence: 0, text: "An older completed task." },
    { kind: "assistant_text", sequence: 1, blockId: "old", text: "old history ".repeat(1_400) },
  ] });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(fake.preparations(), 1);
  assert.equal(fake.requests.length, 1);
  assert.ok(result.compactions.length > 0, "the prepared request, rather than only its old base, triggers rescue");
  assert.equal(fake.requests[0]!.messages.filter(message => message.content === "y".repeat(9_000)).length, 1);
});

test("final schema accounting measures the prepared tool table", async () => {
  const fake = preparedProvider("host context");
  const original = fake.ports.provider;
  const provider: typeof original & {
    prepareRequest(request: ProviderRequest, signal: AbortSignal): Promise<{ apply(request: ProviderRequest): ProviderRequest }>;
  } = { ...original, async prepareRequest() {
    return { apply: request => ({ ...request, tools: [{ name: "large_schema", description: "x".repeat(8_000), parameters: {} }] }) };
  } };
  const compaction = { ...compactionWiring({ nowMs: 0 }),
    estimateRequestOverheadTokens: (request: ProviderRequest) => request.tools.reduce((sum, tool) => sum + Math.ceil(tool.description.length / 4), 0) };
  const result = await runTurn({ ...fake.ports, provider, compaction }, { ...INPUT, budget: { contextTokenLimit: 1_000 } });

  assert.equal(fake.requests.length, 0);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "context_limit"));
});
