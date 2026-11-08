import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createToolCandidateExecutor } from "../../../../../../adapters/tool-evolution/process-executor.js";
import type { IsolationPort } from "../../../../../../ports/isolation.js";
import type { CandidateExecutor } from "../../../../../domains/tool/evolution/execution.js";
import type { CheckExperience, CheckInput, CheckRequirements, CheckSample, LearnedChecker } from "./contracts.js";
import { checkerMatches, parseCheckExperience, parseCheckSample, parseLearnedChecker, requirementDigest, validateCheckerGrounding } from "./parse.js";
import { buildCheckerPrompt } from "./prompt.js";
import { evaluateChecker, validateCheckEvaluation } from "./evaluate.js";

const BASIS = { text: "Invoice total must be a nonnegative number, including zero.", schema: {
  type: "object", properties: { total: { type: "number", minimum: 0 } }, required: ["total"], additionalProperties: false,
} };
const REQUIREMENTS: CheckRequirements = { ...BASIS, ref: "requirement:invoice-total-v1", digest: requirementDigest(BASIS) };
const SCOPE = "project:invoice-checks";
const SIGNAL = new AbortController().signal;
const CHECKER: LearnedChecker = { schemaVersion: 2, type: "learned_checker", question: "Does zero or a negative total escape the old truthiness check?",
  claim: "Check the frozen nonnegative numeric total requirement without rejecting zero.",
  applicability: { scope: SCOPE, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest,
    requiredKeys: [], excludedKeys: [], instructionIncludes: [] }, timing: ["before_completion"],
  source: 'module.exports = input => { const total = input.output.total; const valid = typeof total === "number" && total >= 0; return {status: valid ? "pass" : "fail", findings: valid ? [] : [{requirementRef:input.task.requirementRef,message:"total must be a nonnegative number"}]}; };',
  sourceRefs: ["experience:missed-negative"] };

function facts(total: number, instruction = "Create an invoice summary."): CheckInput {
  return { task: { instruction, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest }, phase: "before_completion", output: { total } };
}

function sample(id: string, role: CheckSample["role"], total: number, expected: CheckSample["expected"]): CheckSample {
  return { id, role, input: facts(total, `${role} ${id}`), expected,
    oracle: { kind: "task_oracle", sourceRef: `task-oracle:${id}`, requirementDigest: REQUIREMENTS.digest } };
}

const SAMPLES: readonly CheckSample[] = [sample("known-zero", "source", 0, "pass"), sample("known-negative", "source", -3, "fail"),
  sample("unseen-customer", "holdout", 71, "pass"), sample("unseen-refund", "holdout", -101, "fail")];
const EXPERIENCE: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "experience:missed-negative", scope: SCOPE,
  sessionId: "session:source", turnId: "turn:source", requirements: REQUIREMENTS, facts: facts(-3),
  assessment: { kind: "task_oracle", verdict: "invalid", sourceRef: "task-oracle:negative-value" }, priorRuns: ["check:old-miss"] };

/** Fixed first-party programs in real Node processes. This seam makes no Windows SRT or WFP acceptance claim. */
async function realExecutor(t: { after(run: () => Promise<void>): void }): Promise<CandidateExecutor> {
  const base = testScratchPath("check-learning-v2-domain");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const isolation: IsolationPort = {
    probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY: fixed first-party host process seam" }),
    run: async request => {
      const result = spawnSync(request.argv[0]!, request.argv.slice(1), { cwd: request.cwd, env: {}, windowsHide: true,
        timeout: request.timeoutMs, maxBuffer: 65_536, encoding: "utf8" });
      return result.error === undefined ? { outcome: "completed", backend: "windows-srt", exitCode: result.status ?? -1,
        stdout: result.stdout, stderr: result.stderr, timedOut: false }
        : { outcome: "isolation_failed", code: "isolation_start_failed", message: "fixed-source child did not complete" };
    },
  };

  return createToolCandidateExecutor({ isolation, scratchRoot: root, nodeExecutable: process.execPath,
    timeoutMs: 10_000, profile: "confined_json_function_v1" });
}

test("v2 experience preserves exact task requirements and refuses permission fields or stale digests", () => {
  assert.ok(parseCheckExperience(EXPERIENCE).ok);
  assert.equal(parseCheckExperience({ ...EXPERIENCE, allowNetwork: true }).ok, false);
  assert.equal(parseCheckExperience({ ...EXPERIENCE, requirements: { ...REQUIREMENTS, text: "Negative totals are fine now." } }).ok, false);
  assert.equal(parseCheckExperience({ ...EXPERIENCE, facts: { ...EXPERIENCE.facts, task: { ...EXPERIENCE.facts.task, requirementRef: "another-requirement" } } }).ok, false);
});

test("checker applicability pins requirement version, task facts and useful phase without matching surface identity", () => {
  assert.ok(parseLearnedChecker(CHECKER).ok);
  assert.ok(checkerMatches(CHECKER, facts(12, "Prepare a different customer's exported ledger."), SCOPE));
  assert.equal(checkerMatches(CHECKER, facts(12), "project:unrelated"), false);
  assert.equal(checkerMatches(CHECKER, { ...facts(12), task: { ...facts(12).task, requirementDigest: "0".repeat(64) } }, SCOPE), false);
  assert.equal(checkerMatches(CHECKER, { ...facts(12), phase: "after_tool", tool: { name: "read_file", args: {}, result: "ok" } }, SCOPE), false);
  const conditional = { ...CHECKER, applicability: { ...CHECKER.applicability, requiredKeys: ["invoice"], excludedKeys: ["draft"], instructionIncludes: ["final"] } };

  assert.equal(checkerMatches(conditional, facts(12), SCOPE), false);
  assert.equal(checkerMatches(conditional, { ...facts(12, "final"), output: { invoice: true, total: 12 } }, SCOPE), true);
});

test("checker source refs must resolve to host evidence and cannot use a known ref from another scope", () => {
  assert.ok(validateCheckerGrounding(CHECKER, [EXPERIENCE]).ok);
  assert.equal(validateCheckerGrounding({ ...CHECKER, sourceRefs: ["invented:proof"] }, [EXPERIENCE]).ok, false);
  assert.equal(validateCheckerGrounding(CHECKER, [{ ...EXPERIENCE, scope: "project:other" }]).ok, false);
  assert.ok(validateCheckerGrounding({ ...CHECKER, sourceRefs: ["feedback:actual-run"] }, [EXPERIENCE], ["feedback:actual-run"]).ok);
});

test("generation receives public cases and requirements but rejects holdout leakage", () => {
  const prompt = buildCheckerPrompt({ experiences: [EXPERIENCE], sourceSamples: SAMPLES.filter(row => row.role === "source") });
  assert.ok(prompt.ok);
  assert.ok(prompt.value.includes("known-zero"));
  assert.equal(prompt.value.includes("unseen-customer"), false);
  assert.equal(prompt.value.includes("unseen-refund"), false);
  assert.equal(buildCheckerPrompt({ experiences: [EXPERIENCE], sourceSamples: SAMPLES }).ok, false);
});

test("a learned executable method checks unseen correct and incorrect artifacts and accepts legitimate zero", async t => {
  const result = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES, executor: await realExecutor(t), signal: SIGNAL });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.status, "supported", JSON.stringify(result));
  assert.equal(result.value.cases.length, 4);
  assert.equal(result.value.cases.filter(row => row.execution === "executed").length, 4);
  assert.equal(result.value.falseNegatives, 0);
  assert.equal(result.value.falsePositives, 0);
  assert.equal(result.value.checkerErrors, 0);
});

test("a constant pass checker cannot gain support by claiming every artifact is fine", async t => {
  const candidate = { ...CHECKER, source: 'module.exports = input => ({status:"pass",findings:[]});' };
  const result = await evaluateChecker({ candidate, samples: SAMPLES, executor: await realExecutor(t), signal: SIGNAL });
  assert.ok(result.ok);
  assert.equal(result.value.status, "rejected");
  assert.equal(result.value.falseNegatives, 2);
});

test("checker runtime errors remain incomplete evidence, never an artifact-quality failure", async () => {
  const result = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES,
    executor: { execute: async () => ({ kind: "timeout", detail: "deadline" }) }, signal: SIGNAL });
  assert.ok(result.ok);
  assert.equal(result.value.status, "incomplete");
  assert.equal(result.value.checkerErrors, 4);
  assert.equal(result.value.falseNegatives, 0);
  assert.equal(result.value.falsePositives, 0);
  assert.ok(result.value.cases.every(row => row.outcome.kind === "checker_error"));
});

test("wrong requirement findings and thrown checks are checker errors", async t => {
  const badRef = { ...CHECKER, source: 'module.exports = input => ({status:"fail",findings:[{requirementRef:"unrelated",message:"wrong subject"}]});' };
  const first = await evaluateChecker({ candidate: badRef, samples: SAMPLES, executor: await realExecutor(t), signal: SIGNAL });
  assert.ok(first.ok);
  assert.equal(first.value.status, "incomplete");
  assert.equal(first.value.checkerErrors, 4);
  const threw = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES,
    executor: { execute: async () => { throw new Error("adapter failed"); } }, signal: SIGNAL });
  assert.ok(threw.ok);
  assert.equal(threw.value.status, "incomplete");
  assert.equal(threw.value.checkerErrors, 4);
});

test("gold drift, duplicate identities and leaked holdouts stop evaluation before execution", async () => {
  let calls = 0;
  const executor: CandidateExecutor = { execute: async () => {
    calls += 1;
    return { kind: "value", value: { status: "pass", findings: [] } };
  } };

  assert.equal(parseCheckSample({ ...SAMPLES[0], oracle: { ...SAMPLES[0]!.oracle, requirementDigest: "0".repeat(64) } }).ok, false);
  const leaked = SAMPLES.map((row, index) => index === 2 ? { ...row, input: SAMPLES[0]!.input } : row);

  assert.equal((await evaluateChecker({ candidate: CHECKER, samples: leaked, executor, signal: SIGNAL })).ok, false);
  const duplicated = SAMPLES.map((row, index) => index === 2 ? { ...row, id: SAMPLES[0]!.id } : row);

  assert.equal((await evaluateChecker({ candidate: CHECKER, samples: duplicated, executor, signal: SIGNAL })).ok, false);
  assert.equal(calls, 0);
});

test("cancellation before dispatch spends no execution and cannot fabricate supported evidence", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES,
    executor: { execute: async () => {
      calls += 1;
      return { kind: "cancelled" };
    } }, signal: controller.signal });
  assert.ok(result.ok);
  assert.equal(result.value.status, "cancelled");
  assert.equal(result.value.cases.length, 0);
  assert.equal(calls, 0);
});

test("persisted supported evidence requires exact unique coverage and recomputed counters", async () => {
  const result = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES, signal: SIGNAL,
    executor: { execute: async (_candidate, input) => {
      const row = input as { output: { total: number }; task: { requirementRef: string } };
      const valid = row.output.total >= 0;
      return { kind: "value", value: { status: valid ? "pass" : "fail", findings: valid ? []
        : [{ requirementRef: row.task.requirementRef, message: "nonnegative total required" }] } };
    } } });

  assert.ok(result.ok);
  assert.equal(result.value.status, "supported");
  assert.equal(validateCheckEvaluation(result.value, SAMPLES, CHECKER), true);

  for (const corrupt of [{ ...result.value, cases: [] }, { ...result.value, cases: Array(4).fill(result.value.cases[0]) },
    { ...result.value, falseNegatives: 1 }, { ...result.value, checkerErrors: 1 }, { ...result.value, status: "rejected" }]) {
    assert.equal(validateCheckEvaluation(corrupt, SAMPLES, CHECKER), false, JSON.stringify(corrupt));
  }
});

test("persisted reports cannot change a mismatch or runtime error into supported evidence", async () => {
  const error = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES, signal: SIGNAL,
    executor: { execute: async () => ({ kind: "unavailable", detail: "no checker process" }) } });

  assert.ok(error.ok);
  assert.equal(validateCheckEvaluation(error.value, SAMPLES, CHECKER), true);
  assert.equal(validateCheckEvaluation({ ...error.value, status: "supported", checkerErrors: 0 }, SAMPLES, CHECKER), false);
  const mismatch = await evaluateChecker({ candidate: CHECKER, samples: SAMPLES, signal: SIGNAL,
    executor: { execute: async () => ({ kind: "value", value: { status: "pass", findings: [] } }) } });

  assert.ok(mismatch.ok);
  assert.equal(validateCheckEvaluation(mismatch.value, SAMPLES, CHECKER), true);
  const forged = { ...mismatch.value, status: "supported", falseNegatives: 0,
    cases: mismatch.value.cases.map(row => ({ ...row, outcome: { ...row.outcome, kind: "matched" } })) };

  assert.equal(validateCheckEvaluation(forged, SAMPLES, CHECKER), false);
});

test("changing instruction or phase cannot make a public output an independent holdout", async () => {
  let calls = 0;

  for (const phase of ["before_completion", "after_tool"] as const) {
    const copied = SAMPLES.map((row, index) => index === 2 ? { ...row, input: { ...row.input, phase,
      task: { ...row.input.task, instruction: "A differently worded follow-up task" }, output: SAMPLES[0]!.input.output,
      ...(phase === "after_tool" ? { tool: { name: "export", args: {}, result: SAMPLES[0]!.input.output } } : {}) } } : row);
    const evaluated = await evaluateChecker({ candidate: CHECKER, samples: copied, signal: SIGNAL,
      executor: { execute: async () => {
        calls += 1;
        return { kind: "value", value: { status: "pass", findings: [] } };
      } } });
    assert.equal(evaluated.ok, false, "reworded or rephased copies are not independent evaluation evidence");
  }

  assert.equal(calls, 0);
});
