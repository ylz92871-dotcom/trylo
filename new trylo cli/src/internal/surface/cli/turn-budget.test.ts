import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import type { TurnHostInput } from "./host.js";
import { budgetOf } from "./turn-execution.js";
import { PACKAGED_DEFAULTS } from "../../settings/schema.js";

const INPUT: TurnHostInput = {
  text: "Complete all ten stages", sessionId: "s", turnId: "t", correlationId: "c",
  workspaceRoot: "/ws", workspaceId: "w", checkpointRoot: "/undo", providerId: "fixture",
  model: "m", endpoint: "", apiKey: undefined, permission: createFakePermission("approved"),
  format: "stream-json", sink: { stdout: () => undefined, stderr: () => undefined }, now: () => 0,
};

test("other CLI budgets do not invent an iteration limit", () => {
  for (const option of [{ contextTokenLimit: 128_000 }, { maxTokens: 40_000 }, { maxBudgetUsd: 2 }]) {
    assert.equal(budgetOf({ ...INPUT, ...option })!.maxIterations, undefined);
  }
  assert.equal(budgetOf(INPUT), undefined);
  assert.equal(budgetOf({ ...INPUT, maxIterations: 2, contextTokenLimit: 128_000 })!.maxIterations, 2);
});

test("a CLI task with an automatic context ceiling can complete more than eight iterations", async () => {
  let requests = 0;
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: INPUT.permission, tools: createFakeTools([], []),
    provider: { async *stream() {
      requests += 1;
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: requests < 10 };
    } },
  }, {
    sessionId: "s", turnId: "t", correlationId: "c", text: INPUT.text,
    budget: budgetOf({ ...INPUT, contextTokenLimit: 128_000 })!,
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests, 10);
});

test("the packaged defaults allow a workflow beyond sixty-five thousand output tokens", async () => {
  let requests = 0;
  const maxIterations = PACKAGED_DEFAULTS["maxIterations"];
  const maxTokens = PACKAGED_DEFAULTS["maxTokens"];

  assert.equal(maxIterations, undefined);
  assert.equal(maxTokens, undefined);
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: INPUT.permission, tools: createFakeTools([], []),
    provider: { async *stream() {
      requests += 1;
      yield { type: "usage", usage: { mode: "snapshot" as const, inputTokens: 100, outputTokens: 2000, totalTokens: 2100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: requests < 40 };
    } },
  }, {
    sessionId: "s", turnId: "t", correlationId: "c", text: INPUT.text,
    budget: budgetOf({ ...INPUT, contextTokenLimit: 128_000 })!,
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests, 40);
  assert.equal(result.usage.outputTokens, 80_000);
});
