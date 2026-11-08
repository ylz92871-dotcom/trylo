import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { contentHashOf } from "../../../../../control/hash.js";
import { evaluateChecker } from "../../domain/v2/evaluate.js";
import { requirementDigest } from "../../domain/v2/parse.js";
import type { CheckExperience, CheckInput, CheckRequirements, CheckSample, LearnedChecker } from "../../domain/v2/contracts.js";
import type { CheckerEngineOptions, CheckerFeedback, CheckerVersion } from "./contracts.js";
import { createExecutableCheckLearning } from "./runtime.js";
import { readCheckerBoard, saveCheckerRecord } from "../../adapters/board/store.js";

const AT = "2026-11-03T00:00:00.000Z", SIGNAL = new AbortController().signal;
const BASIS = { text: "Quantity must be nonnegative; zero is legal." };
const REQUIREMENTS: CheckRequirements = { ref: "legacy-qualification:quantity", digest: requirementDigest(BASIS), ...BASIS };
const SCOPE = "project:legacy-qualification";

function facts(qty: number): CheckInput {
  return { task: { instruction: "Check quantity.", requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest },
    phase: "before_completion", output: { qty } };
}

function experience(id: string, qty: number): CheckExperience {
  return { schemaVersion: 2, type: "check_experience", id, scope: SCOPE, sessionId: "session:source", turnId: id,
    requirements: REQUIREMENTS, facts: facts(qty), priorRuns: [],
    assessment: { kind: "task_oracle", sourceRef: "oracle:" + id, verdict: qty >= 0 ? "valid" : "invalid" } };
}

test("a withdrawn legacy supported successor stays historical and never resurrects its working ancestor after restart", async t => {
  const base = testScratchPath("check-qualification-runtime");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "board-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const source = experience("source:positive", 1);
  const savedSource = await saveCheckerRecord(boardRoot, source, AT);
  assert.ok(savedSource.ok);
  const ancestor: LearnedChecker = { schemaVersion: 2, type: "learned_checker", question: "Quantity boundary checker",
    claim: "Fixed fixture A intentionally rejects legal zero.", sourceRefs: [source.id], timing: ["before_completion"],
    applicability: { scope: SCOPE, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest,
      requiredKeys: ["qty"], excludedKeys: [], instructionIncludes: [] },
    source: 'module.exports = input => { const ok=input.output.qty>0; return {status:ok?"pass":"fail",findings:ok?[]:[{requirementRef:input.task.requirementRef,message:"strictly positive fixture"}]}; };' };
  const versionA: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker: ancestor, requirements: REQUIREMENTS,
    experienceRefs: [savedSource.versionId], generation: { requestId: "fixture:A", model: "unit-fixture", usage: { inputTokens: 0, outputTokens: 0 } } };
  const savedA = await saveCheckerRecord(boardRoot, versionA, AT);
  assert.ok(savedA.ok);
  let executions = 0;
  const options: CheckerEngineOptions = { boardRoot, collection: () => "enabled", now: () => Date.parse(AT),
    owner: { id: "owner:initial", alive: async () => "alive" },
    generator: { generate: async () => { throw new Error("migration regression must not invoke a provider"); } },
    // This deterministic port runs fixed source in a VM; it makes no native-isolation acceptance claim.
    executor: { execute: async (candidate, input) => {
      executions += 1;
      const context = { module: { exports: undefined as unknown }, input };
      runInNewContext(candidate.source + "; answer=module.exports(input)", context, { timeout: 1000 });
      return { kind: "value", value: JSON.parse(JSON.stringify(Reflect.get(context, "answer"))) };
    } } };
  const first = await createExecutableCheckLearning(options).check({ scope: SCOPE, requirements: REQUIREMENTS, input: facts(0),
    runId: "origin:legacy", sessionId: "session:legacy", turnId: "turn:legacy" }, SIGNAL);

  assert.ok(first.ok && first.runs.length === 1);
  const run = first.runs[0]!;

  assert.equal(run.versionId, savedA.versionId);
  assert.equal(run.outcome.kind === "checked" && run.outcome.verdict.status, "fail");
  const feedback: CheckerFeedback = { schemaVersion: 2, type: "checker_feedback", scope: SCOPE, sessionId: run.sessionId,
    turnId: "turn:correction", sourceRef: "owner:legacy-task-zero", text: "Zero is valid for this task.", runIds: [run.runId],
    judgment: { runId: run.runId, expected: "pass" } };

  // Replay actual early-v2 shapes: missing appliesTo plus its automatically derived experience.
  assert.ok((await saveCheckerRecord(boardRoot, feedback, AT)).ok);
  const derived: CheckExperience = { ...experience("checker-judgment:" + contentHashOf([feedback.sourceRef, run.runId]), 0),
    sessionId: run.sessionId, turnId: feedback.turnId, priorRuns: [run.runId],
    assessment: { kind: "user_correction", sourceRef: feedback.sourceRef, verdict: "valid" } };
  const validationExperiences = [source, experience("source:negative", -1), derived, experience("holdout:negative", -2)];

  for (const item of validationExperiences.slice(1)) assert.ok((await saveCheckerRecord(boardRoot, item, AT)).ok);

  const samples: CheckSample[] = validationExperiences.map((item, index) => ({ id: item.id, role: index < 2 ? "source" : "holdout",
    input: item.facts, expected: item.assessment!.verdict === "valid" ? "pass" : "fail", oracle: { kind: item.assessment!.kind,
      sourceRef: item.assessment!.sourceRef, requirementDigest: REQUIREMENTS.digest } }));
  const successor: LearnedChecker = { ...ancestor, parentVersionId: savedA.versionId, claim: "Fixture B passes the old evaluation corpus.",
    source: ancestor.source.replace("qty>0", "qty>=0") };
  const evaluated = await evaluateChecker({ candidate: successor, samples, executor: options.executor, signal: SIGNAL });

  assert.ok(evaluated.ok && evaluated.value.status === "supported");
  const versionB: CheckerVersion = { ...versionA, checker: successor, evaluation: evaluated.value, validationSamples: samples,
    generation: { requestId: "fixture:B", model: "unit-fixture", usage: { inputTokens: 0, outputTokens: 0 } } };
  const savedB = await saveCheckerRecord(boardRoot, versionB, AT);
  assert.ok(savedB.ok);
  const before = await readCheckerBoard(boardRoot);
  assert.ok(before.ok);
  const originalReport = JSON.stringify(before.catalog.versions.find(row => row.versionId === savedB.versionId)!.value);
  const originalLabel = JSON.stringify(before.catalog.experiences.find(row => row.value.id === derived.id)!.value);

  executions = 0;
  const restarted = createExecutableCheckLearning({ ...options, owner: { ...options.owner, id: "owner:restarted" } });
  const next = await restarted.check({ scope: SCOPE, requirements: REQUIREMENTS, input: facts(0), runId: "origin:new-task",
    sessionId: "session:restarted", turnId: "turn:new-task" }, SIGNAL);

  assert.ok(next.ok);
  assert.deepEqual(next.runs, [], "withdrawn B is unavailable and its historically replaced A stays replaced");
  assert.equal(executions, 0, "neither B nor A may execute in the new task");
  const after = await readCheckerBoard(boardRoot);
  assert.ok(after.ok);
  assert.equal(JSON.stringify(after.catalog.versions.find(row => row.versionId === savedB.versionId)!.value), originalReport);
  assert.equal(JSON.stringify(after.catalog.experiences.find(row => row.value.id === derived.id)!.value), originalLabel);
  assert.equal(after.catalog.versions.find(row => row.versionId === savedB.versionId)!.value.evaluation!.status, "supported");
  assert.equal(after.catalog.feedbacks[0]!.appliesTo, undefined, "legacy feedback bytes are preserved, not migrated in place");
});
