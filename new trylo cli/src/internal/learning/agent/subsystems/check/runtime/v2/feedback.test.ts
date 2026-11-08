import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { CheckExperience, CheckInput, CheckRequirements, CheckSample, LearnedChecker } from "../../domain/v2/contracts.js";
import { evaluateChecker } from "../../domain/v2/evaluate.js";
import { recordOf } from "../../../../../domains/tool/evolution/parse.js";
import { requirementDigest } from "../../domain/v2/parse.js";
import type { CheckerCorrectionScope, CheckerEngineOptions, CheckerFeedback, CheckerVersion } from "./contracts.js";
import { createExecutableCheckLearning } from "./runtime.js";
import { readCheckerBoard, saveCheckerRecord } from "../../adapters/board/store.js";

const AT = "2026-11-03T00:00:00.000Z", SIGNAL = new AbortController().signal;
const BASIS = { text: "Quantity is a finite nonnegative number; zero is valid." };
const REQUIREMENTS: CheckRequirements = { ...BASIS, ref: "requirement:feedback-quantity", digest: requirementDigest(BASIS) };
const SCOPE = "project:feedback-regression";

function facts(qty: number): CheckInput { return { task: { instruction: "Check this quantity.", requirementRef: REQUIREMENTS.ref,
  requirementDigest: REQUIREMENTS.digest }, phase: "before_completion", output: { qty } }; }

async function fixture(t: { after(run: () => Promise<void>): void }) {
  const base = testScratchPath("check-feedback-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board");
  const experience: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "experience:positive", scope: SCOPE,
    sessionId: "source-session", turnId: "source-turn", requirements: REQUIREMENTS, facts: facts(1), priorRuns: [],
    assessment: { kind: "task_oracle", sourceRef: "oracle:positive", verdict: "valid" } };
  const source = await saveCheckerRecord(boardRoot, experience, AT);
  assert.ok(source.ok, JSON.stringify(source));
  const checker: LearnedChecker = { schemaVersion: 2, type: "learned_checker", question: "Is quantity acceptable?",
    claim: "Test fixture deliberately rejects legal zero.", applicability: { scope: SCOPE, requirementRef: REQUIREMENTS.ref,
      requirementDigest: REQUIREMENTS.digest, requiredKeys: ["qty"], excludedKeys: [], instructionIncludes: [] },
    timing: ["before_completion"], source: 'module.exports = input => ({status:"fail",findings:[{requirementRef:input.task.requirementRef,message:"fixture false positive"}]});',
    sourceRefs: [experience.id] };
  const version: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker, requirements: REQUIREMENTS,
    experienceRefs: [source.versionId], generation: { requestId: "test:feedback", model: "unit-fixture", usage: { inputTokens: 0, outputTokens: 0 } } };
  const saved = await saveCheckerRecord(boardRoot, version, AT);
  assert.ok(saved.ok, JSON.stringify(saved));
  let calls = 0;
  const options: CheckerEngineOptions = { boardRoot, now: () => Date.parse(AT), collection: () => "enabled",
    owner: { id: "owner:feedback-tests", alive: async () => "alive" },
    generator: { generate: async () => { throw new Error("feedback tests must not invoke a model"); } },
    executor: { execute: async () => { calls += 1;
    return { kind: "value", value: { status: "fail",
      findings: [{ requirementRef: REQUIREMENTS.ref, message: "fixture false positive" }] } }; } } };
  const task = (turnId = "turn:original") => ({ scope: SCOPE, sessionId: "session:daily", turnId,
    requirements: REQUIREMENTS, input: facts(0), runId: `origin:${turnId}` });
  const runtime = createExecutableCheckLearning(options);
  const first = await runtime.check(task(), SIGNAL);
  assert.ok(first.ok && first.runs.length === 1, JSON.stringify(first));
  const run = first.runs[0]!;
  const feedback = (appliesTo?: CheckerCorrectionScope): Omit<CheckerFeedback, "schemaVersion" | "type"> => ({ scope: SCOPE,
    sessionId: "session:daily", turnId: "turn:correction", sourceRef: "owner:zero-is-legal", text: "Zero is valid under the existing requirement.",
    runIds: [run.runId], judgment: { runId: run.runId, expected: "pass" }, ...(appliesTo === undefined ? {} : { appliesTo }) });

  return { boardRoot, runtime, options, task, run, feedback, calls: () => calls };
}

test("task correction affects only its cited task and cannot manufacture cross-task gold", async t => {
  const fx = await fixture(t);

  assert.ok((await fx.runtime.feedback(fx.feedback({ kind: "task", sessionId: fx.run.sessionId, turnId: fx.run.turnId }), SIGNAL)).ok);
  const repeated = await fx.runtime.check(fx.task(), SIGNAL);
  assert.ok(repeated.ok);
  assert.deepEqual(repeated.runs, []);
  const later = await createExecutableCheckLearning(fx.options).check(fx.task("turn:new"), SIGNAL);

  assert.ok(later.ok && later.runs.length === 1);
  assert.equal(fx.calls(), 2);
  const loaded = await readCheckerBoard(fx.boardRoot);
  assert.ok(loaded.ok);
  assert.equal(loaded.catalog.experiences.length, 1, "a local exception is not a new cross-task oracle");
  assert.deepEqual(loaded.catalog.runs[0], fx.run, "original requirement and false-positive evidence remain immutable");
});

for (const kind of ["class", "long_term"] as const) test(`${kind} correction is persisted and suspends the erroneous method under the same frozen standard`, async t => {
  const fx = await fixture(t);

  assert.ok((await fx.runtime.feedback(fx.feedback({ kind, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest }), SIGNAL)).ok);
  const next = await createExecutableCheckLearning(fx.options).check(fx.task("turn:new"), SIGNAL);

  assert.ok(next.ok);
  assert.deepEqual(next.runs, []);
  assert.equal(fx.calls(), 1);
  const loaded = await readCheckerBoard(fx.boardRoot);
  assert.ok(loaded.ok);
  assert.equal(loaded.catalog.experiences.length, 2);
  assert.equal(loaded.catalog.experiences[1]!.value.assessment?.verdict, "valid");
  assert.deepEqual(loaded.catalog.experiences[1]!.value.requirements, REQUIREMENTS);
  assert.deepEqual(loaded.catalog.feedbacks[0]!.appliesTo, { kind, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest });
});

test("early feedback without a correction scope defaults to its original task", async t => {
  const fx = await fixture(t);
  assert.ok((await fx.runtime.feedback(fx.feedback(), SIGNAL)).ok);
  const later = await createExecutableCheckLearning(fx.options).check(fx.task("turn:later"), SIGNAL);
  assert.ok(later.ok && later.runs.length === 1);
  const loaded = await readCheckerBoard(fx.boardRoot);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.catalog.feedbacks[0]!.appliesTo, { kind: "task", sessionId: fx.run.sessionId, turnId: fx.run.turnId });
});

test("correction cannot move to another task or frozen criterion, or contradict known independent evidence", async t => {
  const fx = await fixture(t);

  for (const appliesTo of [{ kind: "task", sessionId: fx.run.sessionId, turnId: "some-other-turn" },
    { kind: "class", requirementRef: REQUIREMENTS.ref, requirementDigest: "0".repeat(64) }] as const) {
    assert.equal((await fx.runtime.feedback(fx.feedback(appliesTo), SIGNAL)).ok, false);
  }

  const source: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "oracle:zero", scope: SCOPE,
    sessionId: fx.run.sessionId, turnId: fx.run.turnId, requirements: REQUIREMENTS, facts: fx.run.input, priorRuns: [fx.run.runId],
    assessment: { kind: "task_oracle", sourceRef: "oracle:zero-fixed", verdict: "valid" } };

  assert.ok((await fx.runtime.capture(source)).ok);
  const contradicted = { ...fx.feedback({ kind: "long_term", requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest }),
    judgment: { runId: fx.run.runId, expected: "fail" as const } };
  const result = await fx.runtime.feedback(contradicted, SIGNAL);
  assert.equal(result.ok, false);

  if (!result.ok) assert.equal(result.code, "check_oracle_conflict");

  const loaded = await readCheckerBoard(fx.boardRoot);
  assert.ok(loaded.ok);
  assert.equal(loaded.catalog.feedbacks.length, 0);
});

test("changing phase or task wording cannot create contradictory gold for the same target", async t => {
  const fx = await fixture(t);
  const alias: CheckInput = { ...facts(1), task: { ...facts(1).task, instruction: "Export the same result in another task." },
    phase: "after_tool", tool: { name: "read_file", args: {}, result: { qty: 1 } } };
  const result = await fx.runtime.capture({ schemaVersion: 2, type: "check_experience", id: "contradictory:alias", scope: SCOPE,
    sessionId: "another-session", turnId: "another-turn", requirements: REQUIREMENTS, facts: alias, priorRuns: [],
    assessment: { kind: "task_oracle", sourceRef: "oracle:contradictory-alias", verdict: "invalid" } });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "check_oracle_conflict");
});

test("pausing a supported successor never resurrects an already superseded ancestor", async t => {
  const fx = await fixture(t);
  const before = await readCheckerBoard(fx.boardRoot);
  assert.ok(before.ok);
  const parent = before.catalog.versions[0]!;
  const checker: LearnedChecker = { ...parent.value.checker, question: "Quantity boundary method, zero defect not yet observed.",
    parentVersionId: parent.versionId,
    source: 'module.exports = input => { const ok=input.output.qty>0; return {status:ok?"pass":"fail",findings:ok?[]:[{requirementRef:input.task.requirementRef,message:"quantity must be positive"}]}; };' };
  const samples: CheckSample[] = [];

  for (const [index, qty] of [1, -1, 2, -2].entries()) {
    const experience: CheckExperience = { schemaVersion: 2, type: "check_experience", id: `independent:${index}`, scope: SCOPE,
      sessionId: "validation-session", turnId: `validation:${index}`, requirements: REQUIREMENTS, facts: facts(qty), priorRuns: [],
      assessment: { kind: "task_oracle", sourceRef: `oracle:nonnegative:${index}`, verdict: qty >= 0 ? "valid" : "invalid" } };
    assert.ok((await fx.runtime.capture(experience)).ok);
    samples.push({ id: experience.id, role: index < 2 ? "source" : "holdout", input: experience.facts,
      expected: qty >= 0 ? "pass" : "fail", oracle: { kind: "task_oracle", sourceRef: experience.assessment!.sourceRef, requirementDigest: REQUIREMENTS.digest } });
  }

  // A deterministic port exercises selection/lifecycle; this test makes no model or native execution claim.
  const evaluated = await evaluateChecker({ candidate: checker, samples, signal: SIGNAL, executor: { execute: async (_candidate, input) => {
    assert.ok(recordOf(input) && recordOf(input.output) && typeof input.output.qty === "number");
    const ok = input.output.qty > 0;
    return { kind: "value", value: { status: ok ? "pass" : "fail", findings: ok ? [] : [{ requirementRef: REQUIREMENTS.ref, message: "quantity must be positive" }] } };
  } } });

  assert.ok(evaluated.ok && evaluated.value.status === "supported");
  const child = await saveCheckerRecord(fx.boardRoot, { ...parent.value, checker, evaluation: evaluated.value, validationSamples: samples,
    generation: { requestId: "test:supported-successor", model: "unit-fixture", usage: { inputTokens: 0, outputTokens: 0 } } }, AT);

  assert.ok(child.ok, JSON.stringify(child));
  const result = await fx.runtime.check(fx.task("turn:child"), SIGNAL);
  assert.ok(result.ok && result.runs.length === 1);
  const run = result.runs[0]!;
  assert.equal(run.versionId, child.versionId);
  assert.ok((await fx.runtime.feedback({ ...fx.feedback({ kind: "class", requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest }),
    sourceRef: "owner:child-zero-is-legal", runIds: [run.runId], judgment: { runId: run.runId, expected: "pass" } }, SIGNAL)).ok);
  const after = await createExecutableCheckLearning(fx.options).check(fx.task("turn:after-child-correction"), SIGNAL);

  assert.ok(after.ok);
  assert.deepEqual(after.runs, [], "a correction pauses the child without reviving its replaced ancestor");
});
