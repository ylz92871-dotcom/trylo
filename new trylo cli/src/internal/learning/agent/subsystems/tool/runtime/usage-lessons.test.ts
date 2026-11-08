import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { openToolCandidateUse } from "./evolution-use.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { readToolUsageGuidance } from "./usage-lessons.js";
import { readToolUsageContext } from "./usage-context.js";
import { assessToolUsageLessons, toolUsageLessonGuidance, type ToolUsageAssessment, type ToolUsageLesson } from "../domain/evolution/usage-learning.js";
import { nominateToolLearningSource } from "./learning-funding.js";
import { readToolCentralFeedback } from "./central-history.js";

test("a correction retracts only its condition and the display never truncates a qualifying exception", () => {
  const lesson: ToolUsageLesson = { decisionVersionId: "usage:first", toolVersionId: "version:one", toolId: "numeric", order: 1,
    usage: "Normalize decimals before calling.", situations: ["csv-decimals", "json-decimals"], exclusions: ["identifiers"], evidenceRefs: ["user:format"] };
  const correction: ToolUsageAssessment = { feedbackVersionId: "feedback:csv", order: 2, feedback: { schemaVersion: 1,
    feedbackId: "csv-correction", versionId: lesson.toolVersionId, sessionId: "session", taskId: "csv-task", useIds: ["use"],
    situation: "csv-decimals", evidenceRefs: ["user:column"], source: "user", outcome: "unsolved", attribution: "usage",
    recommendation: "avoid", summary: "CSV identifier columns must preserve their exact text." } };
  const assessed = assessToolUsageLessons([lesson], [correction]);

  assert.deepEqual(assessed[0]?.effectiveSituations, ["json-decimals"]);
  assert.equal(assessed[0]?.conditionStandings.find(condition => condition.situation === "csv-decimals")?.standing, "withdrawn");
  assert.match(toolUsageLessonGuidance(assessed).join("\n"), /json-decimals/);
  assert.doesNotMatch(toolUsageLessonGuidance(assessed).join("\n"), /csv-decimals/);
  const oversized = assessToolUsageLessons([{ ...lesson, exclusions: ["long exception ".repeat(40)] }], []);

  assert.deepEqual(toolUsageLessonGuidance(oversized), [], "keep the complete exception in explicit context instead of silently broadening advice");
});

test("late positive feedback on an old use cannot support advice that was never exposed", () => {
  const lesson: ToolUsageLesson = { decisionVersionId: "usage:exact", toolVersionId: "version:one", toolId: "numeric", order: 1,
    usage: "Use declared numeric fields.", situations: ["import"], exclusions: ["identifiers"], evidenceRefs: ["user:schema"] };
  const assessment: ToolUsageAssessment = { feedbackVersionId: "feedback:late", order: 2,
    feedback: { schemaVersion: 1, feedbackId: "late-success", versionId: lesson.toolVersionId, sessionId: "session", taskId: "older-task",
      useIds: ["old-use"], situation: "import", evidenceRefs: ["user:result"], source: "user", outcome: "solved", attribution: "usage",
      recommendation: "retain", summary: "The old task succeeded." } };

  assert.equal(assessToolUsageLessons([lesson], [assessment])[0]?.standing, "proposed", "archive ordering alone is not downstream use evidence");
  assert.equal(assessToolUsageLessons([lesson], [{ ...assessment, observedLessonRefs: ["usage:other"] }])[0]?.standing, "proposed");
  assert.equal(assessToolUsageLessons([lesson], [{ ...assessment, observedLessonRefs: [lesson.decisionVersionId] }])[0]?.standing, "supported");
  assert.equal(assessToolUsageLessons([lesson], [{ ...assessment, observedLessonRefs: [lesson.decisionVersionId],
    feedback: { ...assessment.feedback, source: "model" } }])[0]?.standing, "proposed", "model self-report does not verify the proposal");
});

test("a learned conditional use reaches the next normal catalog, can be withdrawn, and is revised from the correction", async t => {
  const fx = await seedToolProduction(t), versionId = fx.origin.versionId;
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double",
    createdAt: productionTestTime, trigger: { runId: "import-task", proposalKey: "numeric-import-usage", action: "user_requested",
      evidenceRefs: ["user:column-contract"] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  const nominated = await nominateToolLearningSource({ boardRoot: fx.root, scope: "test", centralScope: "central:test", now: () => 0 },
    plan, new AbortController().signal);
  assert.ok(nominated.ok);
  const historyInput = { boardRoot: fx.root, scope: "test", centralScope: "central:test", issueId: nominated.issueId };
  const advice = "Convert numeric strings before calling.";
  const revised = "Call only for values confirmed numeric by the input schema.";
  const services = (usage: string, evidenceRef: string): ToolPipelineServices => ({ executionAuthorized: true,
    allowance: async () => ({ grantId: "TEST-only-allowance", maxCalls: 2, maxTokens: 16000, callsRemaining: 2,
      tokensRemaining: 16000, maxPromptChars: 24000 }),
    context: async () => ({ availableTools: [{ toolId: "learned:numeric", description: "Double a finite number", versionId }], requirements: [] }),
    search: async () => { assert.fail("a usage correction already identifies its tool"); },
    evolve: async () => { assert.fail("usage learning must not turn into source modification"); },
    plan: async () => ({ action: "refine", toolId: "learned:numeric", usage,
      usageContext: { situations: ["numeric-import"], exclusions: ["columns declared as identifiers"], evidenceRefs: [evidenceRef] },
      rationale: "The input interpretation changes the correct way to call this version", existingInsufficiency: "The description omitted column semantics",
      expectedBenefit: "Fewer wrong conversions; no measured gain", constructionCost: "One scoped usage revision", alternatives: ["No new package is needed"] }),
  });
  const signal = new AbortController().signal;
  const first = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", mode: "manual", now: () => 0,
    services: services(advice, "user:column-contract"), signal, jobIds: [queued.jobId] });

  assert.ok(first.ok);
  assert.equal(first.results[0]?.code, "usage_revision_proposed");
  const proposalHistory = await readToolCentralFeedback(historyInput);
  assert.ok(proposalHistory);
  const proposedLessonRef = proposalHistory.records.find(row => row.unit === "tool_conditional_usage_proposal")?.factRef;

  assert.equal(typeof proposedLessonRef, "string");
  let useSequence = 0;
  const mount = () => openToolCandidateUse({ boardRoot: fx.root, versionId, sessionId: "import-session", workspaceId: "workspace-test",
    now: () => 0, newId: () => `import-use-${++useSequence}`, warn: message => assert.fail(message),
    executor: { execute: async () => ({ kind: "value", value: 6 }) } });
  const frozen = await mount();
  assert.ok(frozen.ok);
  t.after(frozen.mount.close);
  assert.match(frozen.mount.binding.description, /Convert numeric strings/, "the normal model catalog receives the proposed instruction without an exact task tag");
  assert.match(frozen.mount.binding.description, /numeric-import/);
  assert.match(frozen.mount.binding.description, /identifiers/);
  await frozen.mount.tools.execute({ toolCallId: "import-call", name: frozen.mount.binding.name, arguments: { input: 3 } }, signal);
  const correction = await recordAndScheduleToolTaskFeedback(fx.root, { schemaVersion: 1, feedbackId: "identifier-correction", versionId,
    sessionId: "import-session", taskId: "import-task", useIds: ["import-use-1"], situation: "numeric-import", evidenceRefs: ["user:identifier-column"],
    source: "user", outcome: "unsolved", attribution: "usage", recommendation: "avoid",
    summary: "Do not coerce numeric-looking identifiers. Preserve identifiers and skip this numeric tool for those columns." }, productionTestTime);

  assert.ok(correction.ok);
  const correctedHistory = await readToolCentralFeedback(historyInput);
  assert.ok(correctedHistory);
  assert.notEqual(correctedHistory.sourceRef, proposalHistory.sourceRef, "the real invocation and user correction change the next source context");
  const assessment = correctedHistory.records.find(row => row.factRef === correction.feedbackVersionId);
  assert.ok(assessment);
  assert.equal(assessment.unit, "tool_task_assessment");
  assert.equal(assessment.economicComparison, "unregistered");
  assert.deepEqual(assessment.observedStageLessonRefs, [proposedLessonRef], "history binds the advice actually rendered in this call");
  const afterCorrection = await readToolUsageGuidance(fx.root, versionId, "workspace-test");
  assert.ok(afterCorrection.ok);
  assert.equal(afterCorrection.lessons[0]?.standing, "withdrawn");
  const next = await mount();
  assert.ok(next.ok);
  t.after(next.mount.close);
  assert.doesNotMatch(next.mount.binding.description, /Convert numeric strings/);
  assert.match(next.mount.binding.description, /Preserve identifiers/);
  assert.match(frozen.mount.binding.description, /Convert numeric strings/, "the already mounted task keeps its frozen description");
  const context = await readToolUsageContext(fx.root, "test", "numeric-import");
  assert.ok(context.ok);
  assert.equal(context.guidance[0]?.standing, "withdrawn", "explicit retrieval must not recommend a withdrawn lesson");

  // The corrective report starts a new scoped investigation; its exact parent and
  // independent user text are visible before the replacement usage is proposed.
  assert.equal(correction.learning.kind, "not_requested", "avoid retracts advice but does not grant tool-modification authority");
  const change = await recordAndScheduleToolTaskFeedback(fx.root, { schemaVersion: 1, feedbackId: "identifier-revision", versionId,
    sessionId: "import-session", taskId: "import-task", useIds: ["import-use-1"], situation: "numeric-import", evidenceRefs: ["user:identifier-column"],
    source: "user", outcome: "partial", attribution: "usage", recommendation: "change_usage", summary: "Only the declared numeric schema permits using this tool." }, productionTestTime);

  assert.ok(change.ok);
  assert.equal(change.learning.kind, "queued");
  if (change.learning.kind !== "queued") assert.fail("missing revision work");

  const second = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", mode: "manual", now: () => 0,
    services: services(revised, change.feedbackVersionId), signal, jobIds: [change.learning.jobId] });

  assert.ok(second.ok);
  assert.equal(second.results[0]?.code, "usage_revision_proposed");
  const afterRevision = await mount();
  assert.ok(afterRevision.ok);
  t.after(afterRevision.mount.close);
  assert.match(afterRevision.mount.binding.description, /confirmed numeric by the input schema/);
  assert.doesNotMatch(afterRevision.mount.binding.description, /Convert numeric strings/);
  const board = await createBoardReader(fx.root).load();
  assert.ok(board.ok);
  assert.deepEqual(board.state.activations, []);
  assert.deepEqual(board.state.approvals, []);
  assert.equal(board.state.toolUses?.[0]?.quality, "unverified");
  assert.deepEqual(board.state.toolUses?.[0]?.usageLessonRefs, [afterCorrection.lessons[0]?.decisionVersionId], "the invocation binds the exact advice rendered in its frozen catalog");
  await afterRevision.mount.tools.execute({ toolCallId: "follow-up-call", name: afterRevision.mount.binding.name, arguments: { input: 3 } }, signal);
  const supported = await recordAndScheduleToolTaskFeedback(fx.root, { schemaVersion: 1, feedbackId: "follow-up-success", versionId,
    sessionId: "import-session", taskId: "new-follow-up-task", useIds: ["import-use-2"], situation: "numeric-import", evidenceRefs: ["user:follow-up-result"],
    source: "user", outcome: "solved", attribution: "usage", recommendation: "retain", summary: "The later task used the declared numeric schema and succeeded." }, productionTestTime);

  assert.ok(supported.ok);
  const observed = await readToolUsageGuidance(fx.root, versionId, "workspace-test");
  assert.ok(observed.ok);
  assert.equal(observed.lessons.at(-1)?.standing, "supported", "only a real returned call exposed to this advice can support it");
});
