import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { toolCentralCondition } from "./central-condition.js";

test("only a real target capability contract supplies the tool condition; current task metadata supplies none", async t => {
  const f = await seedToolProduction(t), loaded = await createBoardReader(f.root).load();
  assert.ok(loaded.ok);
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "TEST ONLY current task text",
    targetVersionId: f.origin.versionId, createdAt: productionTestTime, trigger: { runId: "task:first", proposalKey: "request:first",
      action: "user_requested", evidenceRefs: ["evidence:first-task"] } };
  const first = toolCentralCondition(loaded.state, plan);
  assert.ok(first);
  const otherTask = toolCentralCondition(loaded.state, { ...plan, capability: "TEST ONLY a different task's free wording",
    createdAt: "2026-11-04T15:00:00.000Z", trigger: { ...plan.trigger, runId: "task:second", proposalKey: "request:second", evidenceRefs: ["evidence:second-task"] } });

  assert.deepEqual(otherTask, first, "the reusable original input/usage contract excludes task IDs, prose and times");
  assert.equal(first.features.capabilityIdentity, "double");
  assert.deepEqual(first.features.inputSchema, { type: "number" });
  assert.equal(toolCentralCondition(loaded.state, { ...plan, targetVersionId: "tool:missing-target" }), undefined);
  const { targetVersionId: _target, ...unidentified } = plan;

  assert.equal(toolCentralCondition(loaded.state, unidentified), undefined, "an open-ended need has no declared input/capability class yet");
});
