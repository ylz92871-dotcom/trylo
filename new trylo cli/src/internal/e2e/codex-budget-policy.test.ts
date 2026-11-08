import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import type { ProviderEvent, ProviderRequest } from "../ports/provider.js";
import type { IterationBudget } from "../domain/iteration.js";
import { PACKAGED_DEFAULTS } from "../settings/schema.js";
import { budgetOf } from "../surface/cli/turn-execution.js";
import type { TurnHostInput } from "../surface/cli/host.js";
import { shouldCompact } from "../compaction/policy.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";

const input: TurnHostInput = {
  text: "Complete the synthetic workflow", sessionId: "s", turnId: "t", correlationId: "c",
  workspaceRoot: "/ws", workspaceId: "w", checkpointRoot: "/undo", providerId: "fixture",
  model: "m", endpoint: "", apiKey: undefined, permission: createFakePermission("approved"),
  format: "stream-json", sink: { stdout: () => undefined, stderr: () => undefined }, now: () => 0,
};

function packagedBudget() {
  const maxIterations = PACKAGED_DEFAULTS["maxIterations"], maxTokens = PACKAGED_DEFAULTS["maxTokens"];
  return budgetOf({ ...input, contextTokenLimit: 128_000,
    ...(typeof maxIterations === "number" ? { maxIterations } : {}),
    ...(typeof maxTokens === "number" ? { maxTokens } : {}),
  });
}

async function workflow(budget?: IterationBudget) {
  const requests: ProviderRequest[] = [];
  const result = await runTurn({
    permission: input.permission, profile: emptyProfileLoader(), tools: createFakeTools([], []),
    provider: { async *stream(request): AsyncIterable<ProviderEvent> {
      requests.push(request);
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: 2_000,
        totalTokens: 2_100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1_900 } };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: requests.length < 41 };
    } },
  }, { sessionId: input.sessionId, turnId: input.turnId, correlationId: input.correlationId, text: input.text,
    ...(budget === undefined ? {} : { budget }) });

  return { result, requests };
}

test("ordinary library execution can finish beyond 32 requests without an implicit cap", async () => {
  const { result, requests } = await workflow();
  assert.equal(requests.length, 41);
  assert.equal(result.state.terminalReason, "completed");
});

test("default CLI execution can exceed 65536 cumulative output without setting a per-request maximum", async () => {
  const { result, requests } = await workflow(packagedBudget());
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 41);
  assert.equal(result.usage.outputTokens, 82_000);
  assert.equal(requests.every(request => request.maxOutputTokens === undefined), true);
});

test("an explicit output or context budget does not create an implicit request-count limit", () => {
  for (const settings of [{ maxTokens: 4_000 }, { contextTokenLimit: 128_000 }, { maxBudgetUsd: 2 }]) {
    const budget = budgetOf({ ...input, ...settings })!;
    assert.equal(budget.maxIterations, undefined);
    assert.equal(budget.finalRequest, undefined);
  }
});

test("explicit request and cumulative output ceilings remain enforced", async () => {
  const requests = await workflow({ maxIterations: 3 });

  assert.equal(requests.requests.length, 3);
  assert.equal(requests.result.state.terminalReason, "failed");
  assert.ok(requests.result.envelopes.some(e => e.payload.cause === "iterations_exhausted"));
  const output = await workflow({ maxIterations: 64, maxOutputTokens: 4_000 });

  assert.deepEqual(output.requests.map(r => r.maxOutputTokens), [4_000, 2_000]);
  assert.ok(output.result.envelopes.some(e => e.payload.cause === "output_tokens_exhausted"));
});

test("automatic compaction starts at 90 percent of a declared window", () => {
  const view = { items: [{ kind: "user" as const, sequence: 0, text: "Original constraint" }], window: undefined, horizonSequence: undefined };
  assert.equal(shouldCompact({ view, contextTokenLimit: 10_000, estimatedPromptTokens: 8_999 }).outcome, "hold");
  assert.equal(shouldCompact({ view, contextTokenLimit: 10_000, estimatedPromptTokens: 9_000 }).outcome, "compact");
});

test("a resumed conversation near its window compacts before the first send", async () => {
  const requests: ProviderRequest[] = [];
  const result = await runTurn({
    permission: input.permission, profile: emptyProfileLoader(), tools: createFakeTools([], []),
    compaction: compactionWiring({ nowMs: 0 }),
    provider: { async *stream(request): AsyncIterable<ProviderEvent> {
      requests.push(request);
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Follow the original constraint.",
    resumedTranscript: [{ kind: "user", sequence: 0, text: "Original constraint" },
      { kind: "assistant_text", sequence: 1, blockId: "old", text: "x".repeat(36_000) }],
    budget: { maxIterations: 3, contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 1);
  assert.equal(requests[0]!.messages.some(m => m.content.startsWith("[compacted history")), true);
  assert.ok(requests[0]!.messages.some(m => m.role === "user" && m.content === "Original constraint"));
});
