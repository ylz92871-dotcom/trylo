import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { RunScaffold } from "./run-command.js";
import { prepareGoalRun } from "./goal-run.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, emptyProfileLoader } from "../../loop/fakes.js";

function scaffoldFor(limits: Pick<RunScaffold, "maxIterations" | "maxTokens" | "maxBudgetUsd"> = {}): RunScaffold {
  const records: SessionRecord[] = [];
  const session: SessionPort = {
    async start() { throw new Error("unused"); }, async attach() { throw new Error("unused"); },
    async append(record) {
      records.push({ ...record, formatVersion: "1", sequence: records.length });
      return { ok: true, sequence: records.length - 1 };
    },
    async repairTornTail() { throw new Error("unused"); }, async read() { throw new Error("unused"); },
    async readRecords() { return { ok: true, view: { records, tornTail: false } }; }, async release() {},
  };

  return { providerId: "fixture", providerKind: "fixture", model: "fixture", endpoint: "invalid", apiKey: undefined,
    workspaceRoot: "/workspace", workspaceId: "workspace", checkpointRoot: "/checkpoints", sessionId: "session", session,
    format: "stream-json", warnings: [], close: async () => {}, ...limits };
}

async function prepare(scaffold: RunScaffold) {
  return prepareGoalRun(scaffold, {
    goalCommand: { version: 1, action: "create", objective: "Finish the caller's task" }, goalAction: () => undefined,
  }, { stdout: () => {}, stderr: () => {} }, { now: () => 0, newId: () => "goal-turn" });
}

test("a managed goal can continue beyond 100 requests without an injected task budget", async () => {
  const prepared = await prepare(scaffoldFor());
  assert.equal(prepared.kind, "run");
  const goal = prepared.scaffold.goal;
  assert.ok(goal);
  let requests = 0;
  const maxIterations = prepared.scaffold.maxIterations;
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: goal.tools, goal,
    provider: { async *stream() {
      requests += 1;
      if (requests === 102) {
        yield { type: "tool_call", toolCallId: "done", name: "update_goal", arguments: { status: "complete" } };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } },
  }, { sessionId: "session", turnId: "long-goal", correlationId: "correlation", text: "finish it",
    ...(maxIterations === undefined ? {} : { budget: { maxIterations } }) });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests, 103);
  assert.equal(prepared.scaffold.maxIterations, undefined);
  assert.equal(goal.current().status, "complete");
});

test("goal preparation preserves explicit caller request, token and cost budgets", async () => {
  const limits = { maxIterations: 7, maxTokens: 1234, maxBudgetUsd: 2 };
  const prepared = await prepare(scaffoldFor(limits));

  assert.equal(prepared.scaffold.maxIterations, limits.maxIterations);
  assert.equal(prepared.scaffold.maxTokens, limits.maxTokens);
  assert.equal(prepared.scaffold.maxBudgetUsd, limits.maxBudgetUsd);
});
