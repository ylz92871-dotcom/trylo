import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createNpmToolProductionPlan, NPM_CLI_INPUT_SCHEMA } from "../domain/evolution/npm-production-plan.js";
import { toolProductionScope, toolProductionVersion } from "../domain/evolution/production-plan.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { ToolTaskFeedback } from "../domain/evolution/task-feedback.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { saveToolProductionPlan } from "./production-assets.js";
import { recordAndScheduleToolTaskFeedback, resumeToolFeedbackLearning } from "./feedback-learning.js";
import { readToolLearningPipeline } from "./pipeline-queue.js";
import { toolLearningNpmParents, toolLearningPriorVersions, toolLearningFeedbackRequirements } from "./learning-context.js";
import { readToolUsageContext } from "./usage-context.js";
import { readToolDecisionHistory } from "./decision-history.js";
import { toolTaskFeedbackContext } from "./tool-task-feedback.js";

const issuedAt = "2026-11-04T00:00:00.000Z";

/** TEST ONLY source/use facts exercise Board lineage and feedback handoff.
 * This fixture does not execute npm, claim OS isolation or activate a tool. */
async function fixture(t: TestContext) {
  const base = testScratchPath("npm-feedback-learning");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const data = npmTreeTestData();
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "frozen-interface", scope: data.plan.tree.scope,
    capability: "normalize data with an existing package", operation: "create", evidence: [
      { sampleId: "one", role: "source", input: { argv: [], stdin: "1" }, expected: { kind: "value", value: 1 } },
      { sampleId: "two", role: "source", input: { argv: [], stdin: "2" }, expected: { kind: "value", value: 2 } },
      { sampleId: "vary", role: "variation", input: { argv: [], stdin: "3" }, expected: { kind: "value", value: 3 } },
      { sampleId: "invalid", role: "counterexample", input: { argv: [], stdin: "bad" }, expected: { kind: "error", code: "cli_exit_1" } },
    ] };
  const plan = createNpmToolProductionPlan({ workspaceId: "npm-workspace", installation: data.plan, checks,
    descriptor: { identity: "normalized", description: "TEST ONLY npm interface", inputSchema: NPM_CLI_INPUT_SCHEMA,
      mastery: { whenToUse: ["Normalize known-format input"], preconditions: ["The supplied format matches the interface"], pitfalls: ["Check malformed data"] } },
    runtime: { profile: "confined_npm_cli_v1", bin: "test-cli", entrypoint: "cli.cjs" } });

  assert.ok(plan);
  const saved = await saveToolProductionPlan(boardRoot, plan, issuedAt);
  assert.ok(saved.ok);
  const versionId = toolProductionVersion(plan);
  const use = { schemaVersion: 1 as const, useId: "npm-use", versionId, scope: toolProductionScope(plan), sessionId: "npm-session",
    toolCallId: "npm-call", workspaceId: plan.workspaceId, contentHash: contentHashOf(plan), inputHash: contentHashOf("1"),
    outputHash: contentHashOf(1), execution: "returned" as const, quality: "unverified" as const, occurredAt: issuedAt };
  const recorded = await withBoardWriter(boardRoot, store => store.apply({ type: "record_tool_use", commandId: "npm-use:record", issuedAt, record: use }));

  assert.ok(recorded.ok);
  const feedback: ToolTaskFeedback = { schemaVersion: 1, feedbackId: "npm-feedback", versionId, sessionId: "npm-session", taskId: "normalize-task",
    useIds: [use.useId], situation: "ragged-table", evidenceRefs: ["user-contract:ragged-table"], source: "user", outcome: "partial",
    attribution: "implementation", summary: "Preserve empty trailing columns; input a,b, must retain all three columns", recommendation: "improve",
    observedMetrics: { toolCalls: 4, rework: 2 }, baselineMetrics: { toolCalls: 1, rework: 0 } };

  return { boardRoot, plan, versionId, feedback };
}

test("npm feedback retains the exact production parent, frozen contract and external correction", async t => {
  const fx = await fixture(t);
  const handed = await recordAndScheduleToolTaskFeedback(fx.boardRoot, fx.feedback, issuedAt);

  assert.ok(handed.ok);
  assert.equal(handed.learning.kind, "queued", "installed packages must participate in feedback learning");

  if (handed.learning.kind !== "queued") assert.fail("npm feedback did not enter learning");

  const jobId = handed.learning.jobId;
  const pipeline = await readToolLearningPipeline(fx.boardRoot);
  assert.ok(pipeline.ok);
  const learning = pipeline.jobs.find(job => job.jobId === jobId)?.plan;
  assert.ok(learning);
  assert.equal(learning.targetVersionId, fx.versionId);
  assert.notEqual(learning.targetVersionId, fx.plan.origin.versionId, "different adapters of one installation are different parents");
  assert.equal(learning.scope, fx.plan.origin.scope, "the production activation slot is not the learning workspace");
  const board = await createBoardReader(fx.boardRoot).load();
  assert.ok(board.ok);
  const npm = toolLearningNpmParents(board.state, learning);
  assert.ok(npm.ok);
  assert.equal(npm.parents.length, 1);
  assert.deepEqual(npm.parents[0]?.checks, fx.plan.checks);
  assert.deepEqual(npm.parents[0]?.runtime, fx.plan.runtime);
  assert.match(npm.parents[0]?.feedback ?? "", /trailing columns/);
  assert.match(npm.parents[0]?.feedback ?? "", /reported_comparison_not_controlled_gain/);
  const pure = toolLearningPriorVersions(board.state, learning);
  assert.ok(pure.ok);
  assert.deepEqual(pure.versions, []);
  const requirements = toolLearningFeedbackRequirements(board.state, learning);
  assert.ok(requirements.ok);
  assert.equal(requirements.requirements[0]?.ref, handed.feedbackVersionId);
  assert.match(requirements.requirements[0]?.text ?? "", /three columns/);
  const context = await readToolUsageContext(fx.boardRoot, fx.plan.workspaceId, "ragged-table");
  assert.ok(context.ok);
  assert.equal(context.feedback[0]?.versionId, fx.versionId);
  assert.match(context.feedback[0]?.evidence ?? "", /partial/);
  assert.deepEqual(board.state.activations, []);
  assert.deepEqual(board.state.approvals, []);
});

test("new assessments enrich one pending question while model hypotheses cannot become independent requirements", async t => {
  const fx = await fixture(t);
  const first = await recordAndScheduleToolTaskFeedback(fx.boardRoot, fx.feedback, issuedAt);
  assert.ok(first.ok);
  const second = await recordAndScheduleToolTaskFeedback(fx.boardRoot, { ...fx.feedback, feedbackId: "model-followup", source: "model",
    summary: "Maybe a parser adapter can preserve trailing columns" }, issuedAt);
  assert.ok(second.ok);
  assert.equal(first.learning.kind, "queued");
  if (first.learning.kind !== "queued") assert.fail("missing pending question");

  assert.deepEqual(second.learning, { kind: "not_requested", reason: "already_scheduled", jobId: first.learning.jobId }, "a model hypothesis does not schedule or recharge the existing learning question");
  const recovered = await resumeToolFeedbackLearning(fx.boardRoot, fx.plan.origin.scope);
  assert.ok(recovered.ok);
  assert.equal(recovered.jobIds.length, 1);
  const board = await createBoardReader(fx.boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs.length, 1);
  const pipeline = await readToolLearningPipeline(fx.boardRoot);
  assert.ok(pipeline.ok);
  const learning = pipeline.jobs[0]?.plan;
  assert.ok(learning);
  const requirements = toolLearningFeedbackRequirements(board.state, learning);
  assert.ok(requirements.ok);
  assert.equal(requirements.requirements.length, 1);
  assert.equal(requirements.requirements[0]?.kind, "user_requirement");
  const npm = toolLearningNpmParents(board.state, learning);
  assert.ok(npm.ok);
  assert.match(npm.parents[0]?.feedback ?? "", /Maybe a parser/);
  const environment = await recordAndScheduleToolTaskFeedback(fx.boardRoot, { ...fx.feedback, feedbackId: "environment", attribution: "environment" }, issuedAt);

  assert.ok(environment.ok);
  assert.deepEqual(environment.learning, { kind: "not_requested", reason: "no_attributed_change" });
  const jobId = first.learning.jobId;

  await withBoardWriter(fx.boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", commandId: "fixture:start", issuedAt, jobId })).ok);
    assert.ok((await store.apply({ type: "complete_job", commandId: "fixture:complete", issuedAt, jobId, next: "succeeded" })).ok);
  });
  const afterCompletion = await resumeToolFeedbackLearning(fx.boardRoot, fx.plan.origin.scope);
  assert.ok(afterCompletion.ok);
  assert.deepEqual(afterCompletion.jobIds, [], "merged assessments cannot become new jobs after completion and restart");
  const after = await createBoardReader(fx.boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.jobs.length, 1);
});

test("later external correction retracts an earlier successful task without converting returned calls to quality passes", async t => {
  const fx = await fixture(t);
  const solved = await recordAndScheduleToolTaskFeedback(fx.boardRoot, { ...fx.feedback, feedbackId: "solved", outcome: "solved", recommendation: "retain" }, issuedAt);

  assert.ok(solved.ok);
  assert.equal((await readToolDecisionHistory(fx.boardRoot, fx.boardRoot, fx.plan.candidate.identity)).successfulTrajectories, 1);
  assert.ok((await recordAndScheduleToolTaskFeedback(fx.boardRoot, fx.feedback, issuedAt)).ok);
  assert.equal((await readToolDecisionHistory(fx.boardRoot, fx.boardRoot, fx.plan.candidate.identity)).successfulTrajectories, 0);
  const records = [{ ...fx.feedback, feedbackId: "external", source: "verifier" as const, outcome: "unsolved" as const },
    ...Array.from({ length: 10 }, (_, index) => ({ ...fx.feedback, feedbackId: `model-${index}`, source: "model" as const, outcome: "solved" as const }))];
  const summary = toolTaskFeedbackContext(records) ?? "";

  assert.match(summary, /external/);
  assert.match(summary, /unsolved/);
  assert.match(summary, /model-9/);
  const board = await createBoardReader(fx.boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.toolUses?.[0]?.quality, "unverified");
});
