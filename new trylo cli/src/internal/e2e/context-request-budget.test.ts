import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import type { ProviderEvent, ProviderRequest } from "../ports/provider.js";
import { estimateMessagesTokens, estimateToolSpecsTokens } from "../compaction/token-estimate.js";

function fixture() {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    ports: {
      profile: emptyProfileLoader(), permission: createFakePermission("approved"),
      tools: createFakeTools([], []), compaction: compactionWiring({ nowMs: 0 }),
      provider: { async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        requests.push(request);
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      } },
    },
  };
}

test("an oversized first user input is refused before a provider request", async () => {
  const f = fixture();
  const result = await runTurn(f.ports, { sessionId: "s", turnId: "t", correlationId: "c",
    text: "x".repeat(12_000), budget: { maxIterations: 4, contextTokenLimit: 2_000 } });
  assert.equal(f.requests.length, 0, "the context gate must run before the first network request");
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.envelopes.some(e => e.payload.cause === "context_limit"), true);
});

test("appended system instructions count before the first provider request", async () => {
  const f = fixture();
  const result = await runTurn(f.ports, { sessionId: "s", turnId: "t", correlationId: "c", text: "Hi",
    systemPromptAppend: "a".repeat(12_000), budget: { maxIterations: 4, contextTokenLimit: 2_000 } });
  assert.equal(f.requests.length, 0);
  assert.equal(result.state.terminalReason, "failed");
});

test("replaced seed instructions do not consume the actual request budget", async () => {
  const f = fixture();
  const result = await runTurn(f.ports, { sessionId: "s", turnId: "t", correlationId: "c", text: "Hi",
    callerMessages: [{ role: "system", content: "a".repeat(12_000) }],
    systemPrompt: { mode: "replace", text: "Be concise." }, budget: { maxIterations: 4, contextTokenLimit: 2_000 } });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.messages.some(m => m.content.includes("a".repeat(500))), false);
});

test("a reserved final report is also budgeted after its extra instructions are assembled", async () => {
  const f = fixture();
  const result = await runTurn(f.ports, { sessionId: "s", turnId: "t", correlationId: "c", text: "Hi",
    budget: { maxIterations: 1, finalRequest: "report_only", contextTokenLimit: 100 } });
  assert.equal(f.requests.length, 0, "late request decoration cannot bypass the context ceiling");
  assert.equal(result.state.terminalReason, "failed");
});

test("an explicit output allowance cannot overbook the declared context window", async () => {
  const f = fixture();
  const result = await runTurn(f.ports, { sessionId: "s", turnId: "t", correlationId: "c", text: "Hi",
    systemPromptAppend: "recent instructions ".repeat(25),
    budget: { maxOutputTokens: 65_536, contextTokenLimit: 2_000 } });
  assert.equal(result.state.terminalReason, "completed");
  const request = f.requests[0]!;
  const prompt = estimateMessagesTokens(request.messages) + estimateToolSpecsTokens(request.tools);
  assert.ok(request.maxOutputTokens! > 0);
  assert.ok(prompt + request.maxOutputTokens! <= 2_000, "input and reserved output must fit together");
});
