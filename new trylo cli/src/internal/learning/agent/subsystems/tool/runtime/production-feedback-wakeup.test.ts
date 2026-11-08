import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { toolProductionScope } from "../domain/evolution/production-plan.js";
import { TOOL_JOB_PREFIX } from "../domain/evolution/pipeline.js";
import { activateToolProduction, reviewToolProductionActivation } from "./production-activation.js";
import { openToolProductionUse } from "./production-use.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { createFileToolLedger } from "./ledger-file.js";
import { createToolGapRuntime } from "./awareness-runtime.js";
import { createToolLearningReportTools } from "./learning-report-tool.js";
import { planForJob, nextToolLearningDispatch } from "./pipeline-queue.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";

test("a production inquiry wakes for real new use and external correction across its production scope, while model rewording cannot wake or refuel it", async t => {
  const fx = await seedToolProduction(t);
  await fx.admit();
  const review = await reviewToolProductionActivation(fx.selection);
  assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });
  const issued = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: fx.selection.versionId,
    scope: toolProductionScope(fx.plan), issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(issued.ok);
  assert.ok((await activateToolProduction({ ...fx.selection, reviewId: review.reviewId, permission,
    token: { grantId: issued.grant.grantId }, issuedAt: productionTestTime })).ok);
  let useCount = 0, plans = 0;
  const signal = new AbortController().signal, sessionId = "production-followup-session";
  const opened = await openToolProductionUse({ ...fx.selection, sessionId, now: () => 0, newId: () => `production-task-use-${++useCount}`,
    warn: message => assert.fail(message), executor: { execute: async () => ({ kind: "value" as const, value: 4 }) } });

  assert.ok(opened.ok);
  t.after(opened.mount.close);
  const actualUse = (id: string) => opened.mount.tools.execute({ name: opened.mount.binding.name, toolCallId: id, arguments: { input: 2 } }, signal);

  assert.equal((await actualUse("actual-production-first")).outcome, "result");
  const report = { schemaVersion: 1, versionId: fx.selection.versionId, sessionId, taskId: "original-real-task",
    useIds: ["production-task-use-1"], situation: "batch", evidenceRefs: ["user:batch-result"], source: "user",
    outcome: "unsolved", attribution: "implementation", recommendation: "improve", summary: "The caller needs an explicit batch interface." };
  const feedback = await recordAndScheduleToolTaskFeedback(fx.root, { ...report, feedbackId: "initial-external-question" }, productionTestTime);

  assert.ok(feedback.ok);
  assert.equal(feedback.learning.kind, "queued");

  if (feedback.learning.kind !== "queued") assert.fail("missing original learning job");

  const jobId = feedback.learning.jobId;
  const initial = await createBoardReader(fx.root).load();
  assert.ok(initial.ok);
  const plan = planForJob(initial.state, jobId);
  assert.ok(plan);
  assert.notEqual(initial.state.toolUses?.[0]?.scope, plan.scope, "this is the actual production-scope/original-learning-scope boundary");
  const grantsSeen: string[] = [];
  const services: ToolPipelineServices = {
    executionAuthorized: true,
    allowance: async () => { grantsSeen.push("TEST ONLY original lifetime grant");
    return { grantId: "TEST ONLY original lifetime grant",
      maxCalls: 3, callsRemaining: 3 - plans, maxTokens: 48000, tokensRemaining: 48000, maxPromptChars: 24000 }; },
    context: async () => ({ availableTools: [{ toolId: "offered-production", versionId: fx.selection.versionId, description: "TEST ONLY current production ABI" }], requirements: [] }),
    plan: async context => {
      plans++;
      if (plans === 2) assert.ok(context.requirements.some(row => row.text.includes("Actual external correction")));
      return { action: "defer", reason: "more_evidence", neededEvidence: ["A separately approved batch contract"],
        rationale: "TEST ONLY original unresolved inquiry", existingInsufficiency: "Batch behavior lacks a supplied oracle",
        expectedBenefit: "Unknown", constructionCost: "Use only the remaining original allowance", alternatives: ["Do not fabricate batch expectations"] };
    },
    search: async () => { assert.fail("the exact question already identifies its parent"); },
    evolve: async () => { assert.fail("an ungrounded inquiry must not generate source"); },
  };
  const work = () => workToolLearningPipeline({ boardRoot: fx.root, scope: plan.scope, mode: "after_turn", now: () => 0,
    signal, jobIds: [jobId], services });

  assert.ok((await work()).ok);
  assert.equal(plans, 1);
  const beforeText = await createBoardReader(fx.root).load();
  assert.ok(beforeText.ok);
  const frozenFingerprint = toolLearningInputFingerprint(beforeText.state, plan);
  const runtime = createToolGapRuntime({ ledger: createFileToolLedger(path.join(fx.root, "tool-ledger")), now: () => 0, warn: () => {} });

  t.after(runtime.close);

  for (const ordinal of [1, 2]) {
    const tools = createToolLearningReportTools({ runtime, boardRoot: fx.root, workspaceId: fx.plan.workspaceId,
      sessionId, taskId: `model-turn-${ordinal}`, now: () => 1 });
    const recorded = await tools.execute({ name: "tool_learning_report", toolCallId: `model-feedback-${ordinal}`,
      arguments: { operation: "feedback", report: { ...report, situation: `model-reworded-${ordinal}`, evidenceRefs: [`model:claim-${ordinal}`],
        summary: `The same actual use is described again ${ordinal}`, source: "verifier" } } }, signal);
    assert.equal(recorded.outcome, "result", JSON.stringify(recorded));
  }

  const afterText = await createBoardReader(fx.root).load();
  assert.ok(afterText.ok);
  assert.equal(toolLearningInputFingerprint(afterText.state, plan), frozenFingerprint, "model IDs, task labels, situations and prose are not new host facts");
  assert.equal(afterText.state.jobs.filter(job => job.jobId.startsWith(TOOL_JOB_PREFIX)).length, 1, "rewording one already assigned use cannot purchase another inquiry");
  const quiet = await nextToolLearningDispatch(fx.root, plan.scope, true, [jobId]);
  assert.ok(quiet.ok);
  assert.equal(quiet.jobId, undefined);
  assert.ok((await work()).ok);
  assert.equal(plans, 1);

  assert.ok((await recordAndScheduleToolTaskFeedback(fx.root, { ...report, feedbackId: "actual-user-correction", taskId: "user-correction",
    summary: "Actual external correction: preserve each item and return an ordered batch result." }, productionTestTime)).ok);
  const corrected = await nextToolLearningDispatch(fx.root, plan.scope, true, [jobId]);
  assert.ok(corrected.ok);
  assert.equal(corrected.jobId, jobId);
  assert.ok((await work()).ok);
  assert.equal(plans, 2, "external correction must reach the waiting inquiry despite the separate production scope");
  assert.ok((await work()).ok);
  assert.equal(plans, 2, "its own archived decision/result is not a fresh input");
  assert.equal((await actualUse("actual-production-second")).outcome, "result");
  const used = await nextToolLearningDispatch(fx.root, plan.scope, true, [jobId]);
  assert.ok(used.ok);
  assert.equal(used.jobId, jobId);
  assert.ok((await work()).ok);
  assert.equal(plans, 3, "a genuinely new returned production invocation is a new host fact");
  assert.deepEqual([...new Set(grantsSeen)], ["TEST ONLY original lifetime grant"]);
  assert.equal(3 - plans, 0, "new facts wake the original task but never replenish its total call allowance");
});
