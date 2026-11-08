import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "./runner.js";
import { createFakePermission, emptyProfileLoader, toolResult } from "./fakes.js";
import type { GoalRecord } from "../domain/goal.js";
import type { ProviderEvent, ProviderRequest } from "../ports/provider.js";
import type { GoalExecutionPort } from "../ports/goal.js";

const request = { sessionId: "s", turnId: "t", correlationId: "c", text: "Finish the explicit goal." };

async function scenario(stopAt: number, maxIterations = 5, finalReport = false, cancelOnCheckpoint = false) {
  let goal: GoalRecord = { objective: "Finish the work", status: "active", tokensUsed: 0, createdAtTurn: "t", updatedAtTurn: "t" };
  const requests: ProviderRequest[] = [];
  const cancelled = new AbortController();
  const tools = { snapshot: () => [], execute: async () => toolResult({}), cancel: async () => undefined };
  const controller: GoalExecutionPort = { tools, current: () => goal,
    checkpoint: async total => { goal = { ...goal, tokensUsed: total, ...(requests.length >= stopAt ? { status: "complete" as const } : {}) };
      if (cancelOnCheckpoint && requests.length > 0) cancelled.abort(); }, reminder: () => "Continue the explicit goal with existing permissions." };
  const ports = { tools, goal: controller, permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    provider: { async *stream(input: ProviderRequest): AsyncIterable<ProviderEvent> {
      requests.push(input);
      yield { type: "text_start", blockId: `b${requests.length}` };
      yield { type: "text_delta", blockId: `b${requests.length}`, text: "Progress made." };
      yield { type: "text_end", blockId: `b${requests.length}` };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } } };
  const result = await runTurn(ports, { ...request, cancelSignal: cancelled.signal,
    budget: { maxIterations, ...(finalReport ? { finalRequest: "report_only" as const } : {}) } });

  return { requests, result };
}

test("goal keeps an ordinary completed response going through the existing loop", async () => {
  const { requests, result } = await scenario(2);
  assert.equal(requests.length, 2);
  assert.equal(result.state.terminalReason, "completed");
  assert.ok(requests[1]!.messages.some(m => m.role === "system" && m.content.includes("Continue the explicit goal")));
  assert.equal(requests[1]!.messages.filter(m => m.role === "user").length, 1, "automatic continuation is not a new user request");
});

test("goal continuation cannot forgive the iteration ceiling", async () => {
  const { requests, result } = await scenario(99, 2);
  assert.equal(requests.length, 2);
  assert.notEqual(result.state.terminalReason, "completed");
});

test("goal cannot revive the reserved final-report request", async () => {
  const { requests } = await scenario(99, 2, true);
  assert.equal(requests.length, 2);
});

test("cancellation during a goal checkpoint cannot begin another request", async () => {
  const { requests, result } = await scenario(99, 5, false, true);
  assert.equal(requests.length, 1);
  assert.equal(result.state.terminalReason, "cancelled");
});
