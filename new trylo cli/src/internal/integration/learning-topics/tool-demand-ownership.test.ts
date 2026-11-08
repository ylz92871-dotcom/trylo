import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RewardExposureDraft } from "../../learning/reward/contracts.js";
import { createRewardBoardPort } from "../reward/board-port.js";
import { createReadTopicDemandPolicy, readStrategyBoard, readStrategyExecution,
  READ_STRATEGY_COST_METRIC } from "../../learning/agent/subsystems/tool/read-strategy/index.js";

const scope = "tool-demand-ownership", conditions = { fileBytes: 100, range: "bounded" as const, streaming: true };

function ordinary(eventId: string, occurredAt: number): RewardExposureDraft {
  return readStrategyExecution({ scope, sessionId: "session", turnId: "turn", nowMs: occurredAt,
    record: { executionId: eventId, conditions, decision: { path: "stream", reason: "no_policy" },
      actualPath: "stream", outcome: "completed", bytesRead: 100, latencyMs: 1 } }).exposure;
}

test("retired routing history remains on Board without becoming unknown tool demand", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-demand-owner-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board"), ledger = createRewardBoardPort(boardRoot);
  const current = ordinary("current-tool-read", 100), original = ordinary("retired-routing-read", 99);
  const historical: RewardExposureDraft = { ...original, id: "retired-read-history", context: { ...original.context,
    metric: { ...READ_STRATEGY_COST_METRIC, id: "routing.read.cost", version: "1" } },
    targets: original.targets.map(target => target.kind === "tool_read_path" ? { ...target, kind: "routing_path" } : target) };

  assert.ok((await ledger.expose(historical)).ok);
  assert.ok((await ledger.expose(current)).ok);
  const before = await readStrategyBoard(boardRoot), policy = createReadTopicDemandPolicy({ boardRoot, scope,
    enabled: () => true, conditions: () => conditions, horizon: 16, windowSize: 64, prior: { alpha: 1, beta: 1 } });
  const demand = await policy({ boardSequence: before.sequence, signal: new AbortController().signal });

  assert.equal(demand.status, "ready", JSON.stringify(demand));
  if (demand.status !== "ready") return;

  assert.equal(demand.futureUses, 32 / 3);
  const basis = JSON.parse(demand.provenanceJson);
  assert.equal(basis.n, 1);
  assert.equal(basis.k, 1);
  assert.deepEqual(basis.executions.map((row: { eventId: string }) => row.eventId), ["current-tool-read"]);
  const after = await readStrategyBoard(boardRoot);
  assert.equal(after.sequence, before.sequence);
  assert.deepEqual(after.rewardExposures, before.rewardExposures);
});

test("malformed current tool measurements still stop demand rather than being dropped as legacy", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-demand-current-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board"), ledger = createRewardBoardPort(boardRoot), current = ordinary("current-tool-read", 100);
  const other = ordinary("incompatible-current-read", 101);
  const incompatible: RewardExposureDraft = { ...other, context: { ...other.context,
    environment: "unparseable-current-read-conditions" } };

  assert.ok((await ledger.expose(current)).ok);
  assert.ok((await ledger.expose(incompatible)).ok);
  const before = await readStrategyBoard(boardRoot), policy = createReadTopicDemandPolicy({ boardRoot, scope,
    enabled: () => true, conditions: () => conditions, horizon: 16, windowSize: 64, prior: { alpha: 1, beta: 1 } });
  const demand = await policy({ boardSequence: before.sequence, signal: new AbortController().signal });

  assert.deepEqual(demand, { status: "unmodelled", reason: "read_topic_demand_unclassified" });
  assert.equal((await readStrategyBoard(boardRoot)).sequence, before.sequence);
});
