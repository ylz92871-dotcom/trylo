import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { createToolPersonalAgentLearning } from "./personal-agent.js";
import { createToolLearningFunding } from "./learning-funding.js";

test("PA tool focus validates authorization before deciding and spends the original tool grant in central workspace scope", async t => {
  const fx = await seedToolProduction(t), centralScope = "D:\\workspace\\tool-pa";
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", createdAt: productionTestTime,
    trigger: { runId: "actual-tool-task", proposalKey: "pa-tool-focus", action: "user_requested", evidenceRefs: [fx.origin.versionId] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  const identity = toolLearningFundingIdentity(plan);

  assert.ok((await withBoardWriter(fx.root, store => store.apply({ type: "coordinate_learning", commandId: "pa-test:source", issuedAt: productionTestTime,
    action: { kind: "report", issueId: identity.issueId, scope: centralScope, problemKey: "exact-tool-task", expectedRevision: 0,
      report: { reportId: "actual-tool-task-report", source: { subsystem: "tool", taskId: plan.trigger.runId, versionId: queued.jobId }, facts: ["TEST ONLY canonical task source"], evidenceRefs: plan.trigger.evidenceRefs } } }))).ok);
  const before = await createBoardReader(fx.root).load();
  assert.ok(before.ok);
  const issue = before.state.learningIssues?.find(row => row.issueId === identity.issueId);
  assert.ok(issue);
  let authorized = false, calls = 0;
  const port = createToolPersonalAgentLearning({ boardRoot: fx.root, scope: plan.scope, centralScope, now: () => Date.parse(productionTestTime),
    authorized: () => authorized, run: async jobId => {
      calls++;
      assert.equal(jobId, queued.jobId);
      assert.ok((await withBoardWriter(fx.root, store => store.apply({ type: "start_job", commandId: `${jobId}:test-start`, issuedAt: productionTestTime, jobId }))).ok);
      const funding = createToolLearningFunding({ boardRoot: fx.root, scope: plan.scope, centralScope, now: () => Date.parse(productionTestTime) });
      const allowance = await funding.allowance(plan);
      assert.ok(allowance);
      assert.equal(allowance.grantId, identity.grantId);
      assert.ok((await funding.reserve("test-only-reservation", 128)).ok);
      assert.ok((await funding.settle("test-only-reservation", { kind: "reported", totalTokens: 20 })).ok);
      await funding.release();
      assert.ok((await withBoardWriter(fx.root, store => store.apply({ type: "complete_job", commandId: `${jobId}:test-complete`, issuedAt: productionTestTime, jobId, next: "succeeded" }))).ok);

      return { ok: true };
    } });
  const focus = { issueId: issue.issueId, expectedRevision: issue.revision, reason: "Focus the canonical tool task", sourceRefs: plan.trigger.evidenceRefs };

  assert.deepEqual(await port.resume(new AbortController().signal), { ok: true, status: "idle" });
  assert.deepEqual(await port.focus(focus, new AbortController().signal), { ok: false, reason: "tool_learning_authorization_required" });
  const unchanged = await createBoardReader(fx.root).load();
  assert.ok(unchanged.ok);
  assert.deepEqual(unchanged.state.learningIssues, before.state.learningIssues);
  assert.equal(unchanged.state.centralLearningGrants?.length ?? 0, 0);
  authorized = true;
  const completed = await port.focus(focus, new AbortController().signal);
  assert.ok(completed.ok);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workAttempted, true);
  const after = await createBoardReader(fx.root).load();
  assert.ok(after.ok);
  const grant = after.state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
  assert.ok(grant);
  assert.equal(grant.domain, "tool");
  assert.equal(grant.scope, centralScope);
  assert.equal(grant.allowance.maxTokens, 96000);
  assert.equal(grant.reservations.length, 1);
  assert.equal(grant.reservations[0]?.usage?.kind, "reported");
  assert.equal(calls, 1);
  authorized = false;
  assert.deepEqual(await port.resume(new AbortController().signal), { ok: true, status: "idle" });
});

test("PA tool resume requires execution authorization once a funded queue task is selected", async t => {
  const fx = await seedToolProduction(t), centralScope = "D:\\workspace\\tool-pa-resume";
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", createdAt: productionTestTime,
    trigger: { runId: "resume-task", proposalKey: "pa-tool-resume", action: "user_requested", evidenceRefs: [fx.origin.versionId] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  const identity = toolLearningFundingIdentity(plan);
  const reported = await withBoardWriter(fx.root, store => store.apply({ type: "coordinate_learning", commandId: "pa-resume:source", issuedAt: productionTestTime,
    action: { kind: "report", issueId: identity.issueId, scope: centralScope, problemKey: "resume-tool-task", expectedRevision: 0,
      report: { reportId: "resume-report", source: { subsystem: "tool", taskId: plan.trigger.runId, versionId: queued.jobId }, facts: ["TEST ONLY"], evidenceRefs: plan.trigger.evidenceRefs } } }));

  assert.ok(reported.ok);
  const issue = reported.state.learningIssues?.find(row => row.issueId === identity.issueId);
  assert.ok(issue);
  let authorized = true, calls = 0;
  const port = createToolPersonalAgentLearning({ boardRoot: fx.root, scope: plan.scope, centralScope, now: () => Date.parse(productionTestTime),
    authorized: () => authorized, run: async () => {
      calls++;
      return { ok: true };
    } });
  const attempted = await port.focus({ issueId: issue.issueId, expectedRevision: issue.revision, reason: "Resume exact queue task", sourceRefs: plan.trigger.evidenceRefs }, new AbortController().signal);

  assert.ok(attempted.ok);
  assert.equal(attempted.status, "idle");
  assert.equal(attempted.workAttempted, true);
  authorized = false;
  assert.deepEqual(await port.resume(new AbortController().signal), { ok: false, reason: "tool_learning_authorization_required" });
  assert.equal(calls, 1);
});
