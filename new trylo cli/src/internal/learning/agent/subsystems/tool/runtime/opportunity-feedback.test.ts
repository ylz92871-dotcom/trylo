import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createToolGapRuntime } from "./awareness-runtime.js";
import type { ToolLedgerRecord } from "./ledger-file.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { openToolCandidateUse } from "./evolution-use.js";
import { prepareToolImprovement } from "./evolution-trials.js";
import { readToolDecisionHistory } from "./decision-history.js";
import { recordToolTaskFeedback, readToolTaskFeedback, type ToolTaskFeedback } from "./tool-task-feedback.js";
import { recordAndScheduleToolTaskFeedback, resumeToolFeedbackLearning } from "./feedback-learning.js";
import type { ToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import type { CandidateExecutor } from "../domain/evolution/execution.js";
import { createToolLearningReportTools } from "./learning-report-tool.js";

function awareness() {
  const rows: ToolLedgerRecord[] = [];
  const runtime = createToolGapRuntime({ now: () => 0, warn: () => {}, ledger: {
    append: async row => { rows.push(row); }, tail: async () => rows },
    decisionHistory: async () => ({ refinementAttemptedFor: ["read_file"], successfulTrajectories: 2 }) });
  return { runtime, rows };
}

test("successful calls corroborate one semantic report in the normal model turn and preserve separate expected benefit", async () => {
  const { runtime, rows } = awareness();

  await runtime.port.observe({ turnId: "t", beat: 1, failures: [], toolNames: ["read_file"], executions: [
    { tool: "read_file", toolCallId: "read-1", execution: "returned" }, { tool: "read_file", toolCallId: "read-2", execution: "returned" },
  ] });
  assert.equal(runtime.port.intentOn("t", 2), true);
  assert.ok(await runtime.port.requestPrompt({ turnId: "t", beat: 2, toolNames: ["read_file"] }));
  assert.equal(runtime.port.intentOn("t", 2), true, "same beat must still strip the report channel");
  assert.equal(runtime.port.intentOn("t", 3), false, "reporting is bounded, not attached to every call");
  const report = { kind: "opportunity", need: "read related sections together", reason: "two successful reads repeated navigation",
    tool: "read_file", toolCallIds: ["read-1", "read-2"], existingCapability: "insufficient", expectedBenefit: "fewer repeated reads" };

  assert.deepEqual(await runtime.reportOpportunity({ turnId: "t", reportId: "op", source: "model", report }), { kind: "accepted", reportId: "op" });
  assert.equal(rows.filter(row => row.kind === "proposal").length, 1);
  const detail = runtime.proposalDetails()[0];
  assert.equal(detail?.signal.kind, "opportunity");
  assert.equal(detail?.action.kind, "heavy_upgrade", "real history makes the previously unreachable branch usable");
  assert.equal(detail?.opportunity?.executions.every(fact => fact.execution === "returned"), true);
  assert.equal(detail?.opportunity?.assessment.expectedBenefit, "fewer repeated reads");
  assert.deepEqual(await runtime.reportOpportunity({ turnId: "t", reportId: "op", source: "model", report }), { kind: "ignored", reason: "duplicate" });
});

test("model reports cannot fabricate calls; configuration-only needs and ordinary successes do not create learning work", async () => {
  const { runtime, rows } = awareness();
  const report = { kind: "opportunity", need: "combine data", reason: "repeated transforms", toolCallIds: ["made-up"], existingCapability: "insufficient" };

  assert.deepEqual(await runtime.reportOpportunity({ turnId: "t", reportId: "r", source: "model", report,
    executions: [{ tool: "fake", toolCallId: "made-up", execution: "returned" }] }), { kind: "invalid", code: "unbound_tool_calls" });
  assert.deepEqual(await runtime.reportOpportunity({ turnId: "t", reportId: "r", source: "user", report: { ...report, existingCapability: "configuration_sufficient" } }),
    { kind: "ignored", reason: "existing_configuration_sufficient" });
  await runtime.port.observe({ turnId: "ordinary", beat: 1, failures: [], toolNames: ["read_file"], executions: [{ tool: "read_file", toolCallId: "success", execution: "returned" }] });
  assert.deepEqual(rows, []);
});

async function seed(t: TestContext) {
  const base = testScratchPath("tool-feedback-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = { identity: "double", description: "Double a number", source: "module.exports = input => input * 2", inputSchema: { type: "number" },
    mastery: { whenToUse: ["Double finite numbers"], preconditions: [], pitfalls: [] } };
  const request: ToolEvolutionArtifact["request"] = { schemaVersion: 1, requestId: "seed", scope: "test", capability: "double", operation: "create", evidence: [
    { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } }, { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
    { sampleId: "v", role: "variation", input: -1, expected: { kind: "value", value: -2 } }, { sampleId: "e", role: "counterexample", input: "bad", expected: { kind: "error", code: "invalid_input" } },
  ] };
  const artifact: ToolEvolutionArtifact = { schemaVersion: 1, generatedAt: new Date(0).toISOString(), candidate, request,
    verification: { verdict: "pass", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "TEST ONLY: archive fixture" })) } };
  const saved = await createToolEvolutionArchive(root).save(artifact);
  assert.ok(saved.ok, JSON.stringify(saved));
  const executor: CandidateExecutor = { execute: async () => ({ kind: "value", value: 6 }) };
  const options = { boardRoot: root, versionId: saved.versionId, sessionId: "session", workspaceId: "workspace", now: () => 0,
    newId: () => "use-1", warn: () => {}, executor };

  return { root, saved, options, artifact };
}

test("version-bound task feedback reaches improvement, later situation-specific selection and honest execution history", async t => {
  const fx = await seed(t), opened = await openToolCandidateUse(fx.options);
  assert.ok(opened.ok);
  t.after(opened.mount.close);
  await opened.mount.tools.execute({ toolCallId: "correct-but-costly", name: opened.mount.binding.name, arguments: { input: 3 } }, new AbortController().signal);
  const feedback: ToolTaskFeedback = { schemaVersion: 1, feedbackId: "task-fb", versionId: fx.saved.versionId, sessionId: "session", taskId: "task-double",
    useIds: ["use-1"], situation: "large-batch", evidenceRefs: ["task-result:double"], source: "user", outcome: "solved", attribution: "usage",
    summary: "Use one batch operation for many numbers; repeated single calls caused rework", recommendation: "change_usage",
    observedMetrics: { toolCalls: 4, rework: 1 }, baselineMetrics: { toolCalls: 1, rework: 0 } };
  const persisted = await recordToolTaskFeedback(fx.root, feedback, new Date(1).toISOString());
  assert.ok(persisted.ok);
  assert.equal(persisted.duplicate, false);
  const beforeRecovery = await createBoardReader(fx.root).load();
  assert.ok(beforeRecovery.ok);
  assert.equal(beforeRecovery.state.jobs.length, 0);
  const recovered = await resumeToolFeedbackLearning(fx.root, "test");
  assert.ok(recovered.ok);
  assert.equal(recovered.jobIds.length, 1, "restart repairs a lost record-to-queue handoff");
  const recorded = await recordAndScheduleToolTaskFeedback(fx.root, feedback, new Date(2).toISOString());
  assert.ok(recorded.ok);
  assert.equal(recorded.duplicate, true);
  assert.equal(recorded.learning.kind, "queued");
  const duplicate = await recordAndScheduleToolTaskFeedback(fx.root, feedback, new Date(2).toISOString());
  assert.ok(duplicate.ok);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.learning, recorded.learning, "replaying the feedback cannot create another improvement job");
  assert.equal((await recordToolTaskFeedback(fx.root, { ...feedback, outcome: "unsolved" }, new Date(2).toISOString())).ok, false);
  assert.equal((await recordToolTaskFeedback(fx.root, { ...feedback, feedbackId: "wrong", sessionId: "another" }, new Date(2).toISOString())).ok, false);
  const history = await readToolTaskFeedback(fx.root, fx.saved.versionId);
  assert.ok(history.ok);
  assert.equal(history.records.length, 1);
  assert.equal((await readToolTaskFeedback(fx.root, fx.saved.versionId, "foreign-workspace")).ok, false);
  const prepared = await prepareToolImprovement(fx.root, fx.saved.versionId, fx.artifact.request);
  assert.ok(prepared.ok);
  assert.match(prepared.feedback ?? "", /task-fb/);
  assert.match(prepared.feedback ?? "", /change_usage/);
  const relevant = await openToolCandidateUse({ ...fx.options, taskSituation: "large-batch" });
  assert.ok(relevant.ok);
  t.after(relevant.mount.close);
  assert.match(relevant.mount.binding.description, /repeated single calls caused rework/);
  const other = await openToolCandidateUse({ ...fx.options, taskSituation: "single-value" });
  assert.ok(other.ok);
  t.after(other.mount.close);
  assert.match(other.mount.binding.description, /situation=large-batch/, "an untagged/nearby situation can inspect the conditional counterexample without a literal-label match");
  const decision = await readToolDecisionHistory(fx.root, fx.root, opened.mount.binding.name);
  assert.equal(decision.successfulTrajectories, 1);
  const environment = await recordAndScheduleToolTaskFeedback(fx.root, { ...feedback, feedbackId: "env", attribution: "environment", recommendation: "improve" }, new Date(3).toISOString());

  assert.ok(environment.ok);
  assert.deepEqual(environment.learning, { kind: "not_requested", reason: "no_attributed_change" });
  const resumed = await resumeToolFeedbackLearning(fx.root, "test");
  assert.ok(resumed.ok);
  assert.deepEqual(resumed.jobIds, recorded.learning.kind === "queued" ? [recorded.learning.jobId] : []);
  const foreign = await resumeToolFeedbackLearning(fx.root, "another-scope");
  assert.ok(foreign.ok);
  assert.deepEqual(foreign.jobIds, []);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.jobs.length, 1);
  assert.equal(loaded.state.toolUses?.[0]?.quality, "unverified");
  assert.equal(loaded.state.activations.length, 0);
  assert.equal(loaded.state.evidence.length, 0);
});

test("public report tool binds host identity, schedules real feedback and protects other workspaces", async t => {
  const fx = await seed(t), own = await openToolCandidateUse(fx.options);
  assert.ok(own.ok);
  t.after(own.mount.close);
  await own.mount.tools.execute({ toolCallId: "own-call", name: own.mount.binding.name, arguments: { input: 3 } }, new AbortController().signal);
  const foreignArtifact = { ...fx.artifact, generatedAt: new Date(1).toISOString(), request: { ...fx.artifact.request, requestId: "foreign" } };
  const foreignSaved = await createToolEvolutionArchive(fx.root).save(foreignArtifact);
  assert.ok(foreignSaved.ok);
  const foreign = await openToolCandidateUse({ ...fx.options, versionId: foreignSaved.versionId, workspaceId: "other-workspace", newId: () => "use-other" });

  assert.ok(foreign.ok);
  t.after(foreign.mount.close);
  await foreign.mount.tools.execute({ toolCallId: "foreign-call", name: foreign.mount.binding.name, arguments: { input: 3 } }, new AbortController().signal);
  const queued: string[] = [], { runtime } = awareness();
  const tools = createToolLearningReportTools({ boardRoot: fx.root, workspaceId: fx.options.workspaceId, sessionId: "session", taskId: "host-task",
    runtime, now: () => 2, afterQueued: ids => { queued.push(...ids); } });
  const call = (toolCallId: string, operation: string, report?: Record<string, string | number | string[]>) => tools.execute({ toolCallId,
    name: "tool_learning_report", arguments: { operation, ...(report === undefined ? {} : { report }) } }, new AbortController().signal);
  const uses = await call("uses", "uses");
  assert.equal(uses.outcome, "result");

  if (uses.outcome !== "result") assert.fail("uses must be visible");

  assert.match(uses.output, /own-call/);
  assert.doesNotMatch(uses.output, /foreign-call/);
  const report = { versionId: fx.saved.versionId, useIds: ["use-1"], situation: "batch", evidenceRefs: ["task-output:host-task"],
    outcome: "unsolved", attribution: "implementation", summary: "The fixed version needs a batched interface", recommendation: "improve",
    source: "verifier", schemaVersion: 99, sessionId: "forged", taskId: "forged", feedbackId: "forged" };
  const accepted = await call("feedback-host", "feedback", report);
  assert.equal(accepted.outcome, "result", JSON.stringify(accepted));
  const duplicate = await call("feedback-host", "feedback", report);
  assert.equal(duplicate.outcome, "result");
  const facts = await readToolTaskFeedback(fx.root, fx.saved.versionId);
  assert.ok(facts.ok);
  assert.equal(facts.records.length, 1);
  assert.equal(facts.records[0]?.source, "model");
  assert.equal(facts.records[0]?.sessionId, "session");
  assert.equal(facts.records[0]?.taskId, "host-task");
  assert.equal(facts.records[0]?.feedbackId, "feedback-host");
  assert.equal(new Set(queued).size, 1);
  const context = await call("foreign-context", "context", { versionId: foreignSaved.versionId });
  assert.equal(context.outcome, "error");
  const forbidden = await call("foreign-feedback", "feedback", { ...report, versionId: foreignSaved.versionId, useIds: ["use-other"] });

  assert.equal(forbidden.outcome, "error", "same-session executions in another workspace cannot be used to write learning feedback");
  const cancelled = await tools.execute({ toolCallId: "cancelled", name: "tool_learning_report", arguments: { operation: "uses" } }, AbortSignal.abort());

  assert.equal(cancelled.outcome, "cancelled");
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.jobs.length, 1);
  const decision = await readToolDecisionHistory(fx.root, fx.root, own.mount.binding.name);
  assert.equal(decision.successfulTrajectories, 0);
});
