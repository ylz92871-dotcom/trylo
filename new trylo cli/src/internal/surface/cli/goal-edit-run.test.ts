import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { RunScaffold } from "./run-command.js";
import { prepareGoalRun } from "./goal-run.js";
import { parseGoalCommand } from "./goal-session.js";
import { isGoalRecord } from "../../domain/goal.js";

test("goal edit acknowledges a durable snapshot and a single zero-usage terminal without a model turn", async () => {
  const records: SessionRecord[] = [{ formatVersion: "1", sequence: 0, type: "goal_state", sessionId: "session", turnId: "old", at: "fixture",
    payload: { version: 1, goal: { objective: "Old outcome", status: "paused_by_user", tokensUsed: 42, tokenBudget: 100,
      createdAtTurn: "first", updatedAtTurn: "old" }, usageWatermarks: {} } }];
  const session: SessionPort = {
    async start() { throw new Error("unused"); }, async attach() { throw new Error("unused"); },

    async append(record) {
      records.push({ ...record, formatVersion: "1", sequence: records.length });
      return { ok: true, sequence: records.length - 1 };
    },

    async repairTornTail() { throw new Error("unused"); }, async read() { throw new Error("unused"); },
    async readRecords() { return { ok: true, view: { records, tornTail: false } }; }, async release() {},
  };
  const scaffold: RunScaffold = { providerId: "fixture", providerKind: "fixture", model: "must-not-be-called", endpoint: "invalid", apiKey: undefined,
    workspaceRoot: "/workspace", workspaceId: "workspace", checkpointRoot: "/checkpoints", sessionId: "session", session, resumeRecords: records,
    format: "stream-json", warnings: [], close: async () => {} };
  const lines: string[] = [];
  const result = await prepareGoalRun(scaffold, { goalCommand: parseGoalCommand({ version: 1, action: "edit", objective: "Revised outcome" }), goalAction: () => undefined },
    { stdout: line => {
      assert.equal(records.at(-1)?.type, "goal_state");
      lines.push(line);
    }, stderr: () => {} }, { now: () => 0, newId: () => "edit-turn" });

  assert.equal(result.kind, "updated");
  const frames = lines.map(line => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(frames.map(frame => frame.type), ["goal_state", "run_start", "run_result"]);
  assert.equal(frames[2]?.iterations, 0);
  assert.equal(frames[2]?.finishReason, "goal_edited");
  assert.deepEqual(frames[2]?.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const snapshot = records.at(-1)?.payload.goal;

  assert.ok(isGoalRecord(snapshot));
  assert.equal(snapshot.tokensUsed, 42);
});
