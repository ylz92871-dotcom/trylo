import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { seedToolProduction, productionTestTime } from "../../learning/agent/subsystems/tool/testing/production-fixtures.js";
import { toolLearningFundingIdentity } from "../../learning/agent/subsystems/tool/domain/evolution/funding-identity.js";
import { enqueueToolLearningPlan } from "../../learning/agent/subsystems/tool/runtime/pipeline-queue.js";
import { createToolPersonalAgentLearning } from "../../learning/agent/subsystems/tool/runtime/personal-agent.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createPersonalAgentCollaboration } from "../../learning/agent/subsystems/collaboration/personal-agent/service.js";
import type { ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";

test("PA stops after the actual tool owner runs even when its original queue remains queued", async t => {
  const fx = await seedToolProduction(t), scope = "D:\\workspace\\actual-owner-resume";
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", createdAt: productionTestTime,
    trigger: { runId: "actual-tool-run", proposalKey: "owner-resume", action: "user_requested", evidenceRefs: [fx.origin.versionId] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  const identity = toolLearningFundingIdentity(plan);
  const control = createCollaborationControl({ now: () => productionTestTime, ownerId: "actual-owner-resume",
    board: { load: () => createBoardReader(fx.root).load(), apply: command => withBoardWriter(fx.root, store => store.apply(command)) },
    worker: { async run() { throw new Error("No collaboration work was funded"); } } });
  const report = await control.report({ scope, issueId: identity.issueId, problemKey: "actual-tool-run", report: {
    reportId: "actual-tool-source", source: { subsystem: "tool", taskId: plan.trigger.runId, versionId: queued.jobId },
    facts: ["Actual canonical tool plan"], evidenceRefs: plan.trigger.evidenceRefs } });
  assert.ok(report.ok);
  let toolRuns = 0, laterRuns = 0;
  const tool = createToolPersonalAgentLearning({ boardRoot: fx.root, scope: plan.scope, centralScope: scope,
    now: () => Date.parse(productionTestTime), authorized: () => true,

    async run(jobId) {
      assert.equal(jobId, queued.jobId);
      toolRuns++;
      return { ok: true };
    } });
  const focused = await tool.focus({ issueId: identity.issueId, expectedRevision: report.issue.revision,
    reason: "Continue this original tool plan", sourceRefs: plan.trigger.evidenceRefs }, new AbortController().signal);

  assert.ok(focused.ok);
  assert.equal(focused.status, "idle");
  assert.equal(focused.workAttempted, true);
  const service = createPersonalAgentCollaboration({ control, scope, turnId: "actual-resume", allowance: {
    schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 },
    currentResources: async () => ({ view: {}, revision: "same-resources" }), focusedLearning: { tool,
      skill: { async focus() { throw new Error("Do not focus or fund another issue"); },

        async resume() {
          laterRuns++;
          return { ok: true, status: "completed" };
        } } } });
  const done = await service.resume(new AbortController().signal);

  assert.ok(done.ok);
  assert.equal(done.status, "idle");
  assert.equal(done.workAttempted, true);
  assert.equal(toolRuns, 2);
  assert.equal(laterRuns, 0, "one resume invocation must not consume a second owner's work");
  const state = await createBoardReader(fx.root).load();
  assert.ok(state.ok);
  assert.equal(state.state.jobs.find(job => job.jobId === queued.jobId)?.state, "queued");
  assert.equal(state.state.centralLearningGrants?.length, 1);
});
