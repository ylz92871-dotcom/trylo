import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { contentHashOf } from "../../../../control/hash.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { toolProductionScope } from "../domain/evolution/production-plan.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolLearningContext } from "../domain/evolution/learning-plan.js";
import { toolLearningPlanningPrompt } from "../domain/evolution/learning-plan.js";
import { boundToolLearningContext } from "../domain/evolution/learning-context-budget.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { activateToolProduction, reviewToolProductionActivation } from "./production-activation.js";
import { openToolProductionUse } from "./production-use.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { assessedUsageLessonsFromBoard } from "./usage-lessons.js";
import { toolParentUsageContext } from "./parent-usage-context.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";

test("a new public worker sees exact production-parent usage and correction without transferring support to the next version", async t => {
  const fx = await seedToolProduction(t);
  await fx.admit();
  const original = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(original.ok);
  const review = await reviewToolProductionActivation(fx.selection);
  assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });
  const grant = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: fx.selection.versionId,
    scope: toolProductionScope(fx.plan), issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(grant.ok);
  assert.ok((await activateToolProduction({ ...fx.selection, reviewId: review.reviewId, permission,
    token: { grantId: grant.grant.grantId }, issuedAt: productionTestTime })).ok);
  const signal = new AbortController().signal, sourceVersion = fx.selection.versionId;
  let uses = 0, calls = 0;
  const mount = () => openToolProductionUse({ ...fx.selection, sessionId: "old-version-session", now: () => 0,
    newId: () => `historical-use-${++uses}`, warn: () => {}, executor: { execute: async () => ({ kind: "value" as const, value: 4 }) } });
  const before = await mount();
  assert.ok(before.ok);
  t.after(before.mount.close);
  await before.mount.tools.execute({ name: before.mount.binding.name, toolCallId: "before-advice", arguments: { input: 2 } }, signal);
  const reasoning = { rationale: "TEST ONLY usage proposal", existingInsufficiency: "Input convention is unclear",
    expectedBenefit: "Make conditions explicit", constructionCost: "No source synthesis", alternatives: ["Preserve the existing implementation"] };
  const services = (inspect: (context: ToolLearningContext) => ReturnType<NonNullable<ToolPipelineServices["plan"]>>): ToolPipelineServices => ({
    executionAuthorized: true, allowance: async () => ({ grantId: "TEST ONLY controlled allowance", maxCalls: 2, callsRemaining: 2,
      maxTokens: 16000, tokensRemaining: 16000, maxPromptChars: 24000 }),
    context: async () => ({ availableTools: [{ toolId: "offered-double", versionId: sourceVersion, description: "TEST ONLY current offered tool" }], requirements: [] }),
    plan: context => {
      calls++;
      return inspect(context);
    },
    search: async () => { assert.fail("the exact parent is already known"); }, evolve: async () => { assert.fail("history projection must not synthesize source"); },
  });
  const work = async (key: string, inspect: Parameters<typeof services>[0]) => {
    const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double",
      targetVersionId: fx.origin.versionId, createdAt: productionTestTime,
      trigger: { runId: key, proposalKey: key, action: "user_requested", evidenceRefs: ["user:format-contract", sourceVersion, "historical-use-1"] } };
    const queued = await enqueueToolLearningPlan(fx.root, plan);
    assert.ok(queued.ok);
    const done = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", jobIds: [queued.jobId], mode: "manual",
      signal, now: () => 0, services: services(inspect) });
    assert.ok(done.ok);

    return done;
  };
  const exclusions = ["Identifier columns must preserve every character, including leading zeros."];

  await work("first-usage-job", async () => ({ ...reasoning, action: "reuse", toolId: "offered-double",
    usage: "Convert declared numeric strings before calling.", usageContext: { situations: ["csv-numeric", "json-numeric"], exclusions, evidenceRefs: ["user:format-contract"] } }));
  const late = await recordAndScheduleToolTaskFeedback(fx.root, { schemaVersion: 1, feedbackId: "late-old-task-success", versionId: sourceVersion,
    sessionId: "old-version-session", taskId: "task-before-advice", useIds: ["historical-use-1"], situation: "json-numeric",
    evidenceRefs: ["user:old-result"], source: "user", outcome: "solved", attribution: "usage", recommendation: "retain", summary: "The earlier task returned the expected answer." }, productionTestTime);

  assert.ok(late.ok);
  let captured: ToolLearningContext | undefined;

  await work("second-new-job", async context => {
    captured = context;
    const history = context.parentUsage?.parents.find(parent => parent.parentVersionId === fx.origin.versionId);
    const source = history?.sources.find(item => item.toolVersionId === sourceVersion), lesson = source?.lessons[0];

    assert.ok(lesson, "a new job must see the old production's usage proposal through its exact pure-candidate parent alias");
    assert.equal(source?.contentHash, contentHashOf(fx.plan));
    assert.equal(lesson.toolVersionId, sourceVersion);
    assert.equal(lesson.standing, "proposed");
    assert.deepEqual(lesson.exclusions, exclusions);
    assert.deepEqual(lesson.assessments[0]?.observedLessonUseIds, [], "late archival order cannot invent exposure on an older use");

    return { ...reasoning, action: "defer", reason: "more_evidence", neededEvidence: ["A returned use exposed to these conditions"] };
  });
  const capturedContext = captured as ToolLearningContext | undefined;
  assert.ok(capturedContext);
  const after = await mount();
  assert.ok(after.ok);
  t.after(after.mount.close);
  await after.mount.tools.execute({ name: after.mount.binding.name, toolCallId: "after-advice", arguments: { input: 2 } }, signal);

  for (const report of [
    { feedbackId: "csv-correction", taskId: "real-csv-task", situation: "csv-numeric", outcome: "unsolved", recommendation: "avoid", summary: "CSV identifiers must not be converted, even when they contain only digits." },
    { feedbackId: "json-followup", taskId: "real-json-task", situation: "json-numeric", outcome: "solved", recommendation: "retain", summary: "The later numeric JSON task used this proposal and returned the expected result." },
  ]) {
    assert.ok((await recordAndScheduleToolTaskFeedback(fx.root, { ...report, schemaVersion: 1, versionId: sourceVersion,
      sessionId: "old-version-session", useIds: ["historical-use-2"], evidenceRefs: [`user:${report.feedbackId}`],
      source: "user", attribution: "usage" }, productionTestTime)).ok);
  }

  await work("third-new-job", async context => {
    const lesson = context.parentUsage?.parents[0]?.sources.find(source => source.toolVersionId === sourceVersion)?.lessons[0];
    assert.ok(lesson);
    assert.deepEqual(lesson.situations, ["csv-numeric", "json-numeric"]);
    assert.deepEqual(lesson.exclusions, exclusions);
    assert.equal(lesson.conditionStandings.find(row => row.situation === "csv-numeric")?.standing, "withdrawn");
    assert.equal(lesson.conditionStandings.find(row => row.situation === "json-numeric")?.standing, "supported");
    assert.ok(lesson.assessments.some(row => row.feedback.feedbackId === "csv-correction" && row.observedLessonUseIds.includes("historical-use-2")));
    return { ...reasoning, action: "defer", reason: "more_evidence", neededEvidence: ["Preserve the CSV exception during a separately checked source revision"] };
  });
  const board = await createBoardReader(fx.root).load();
  assert.ok(board.ok);
  const foreign = toolParentUsageContext(board.state, { scope: "another-scope", parentVersionIds: [fx.origin.versionId] });
  assert.equal(foreign.ok, false);
  const unknown = toolParentUsageContext(board.state, { scope: "test", parentVersionIds: [fx.origin.versionId] });
  assert.ok(unknown.ok);
  assert.equal(unknown.context.parents[0]?.historyScope, "unknown");
  assert.equal(unknown.context.coverage, "partial");
  assert.deepEqual(unknown.context.parents[0]?.sources, [], "learning scope cannot manufacture a source-workspace binding");
  const candidate = { ...original.artifact.candidate, source: `${original.artifact.candidate.source}\n// TEST ONLY next immutable source` };
  const next = await createToolEvolutionArchive(fx.root).save({ ...original.artifact, candidate,
    request: { ...original.artifact.request, requestId: "next-version", operation: "improve", prior: { versionId: fx.origin.versionId, source: original.artifact.candidate.source } },
    verification: { ...original.artifact.verification, candidateHash: contentHashOf(candidate) } });
  assert.ok(next.ok);
  const updated = await createBoardReader(fx.root).load();
  assert.ok(updated.ok);
  const nextLessons = assessedUsageLessonsFromBoard(updated.state, next.versionId);
  assert.ok(nextLessons.ok);
  assert.deepEqual(nextLessons.lessons, [], "supported history remains bound to the old production version");
  assert.equal(calls, 3, "one planning call per job; history projection adds no model calls");

  const omitted = { coverage: "partial" as const, omittedParentVersionIds: [fx.origin.versionId], parents: [] };
  const baseline = boundToolLearningContext({ ...capturedContext, parentUsage: omitted });
  assert.ok(baseline);
  const limited = boundToolLearningContext({ ...capturedContext,
    allowance: { ...capturedContext.allowance, maxPromptChars: toolLearningPlanningPrompt(baseline).length + 24 } });
  assert.ok(limited);
  assert.equal(limited.parentUsage?.coverage, "partial");
  assert.ok(limited.parentUsage?.omittedParentVersionIds.includes(fx.origin.versionId));
  assert.deepEqual(limited.parentUsage?.parents, [], "an oversized history group is omitted whole, never stripped of exclusions");
  assert.ok(limited.priorVersions.some(parent => parent.versionId === fx.origin.versionId), "mandatory parent contracts remain available");
});
