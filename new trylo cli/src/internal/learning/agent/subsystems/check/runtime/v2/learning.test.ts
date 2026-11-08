import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { recordOf } from "../../../../../domains/tool/evolution/parse.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { checkerTargetFingerprint } from "../../domain/v2/exposure.js";
import { requirementDigest } from "../../domain/v2/parse.js";
import type { CheckExperience, CheckInput, CheckRequirements, LearnedChecker } from "../../domain/v2/contracts.js";
import type { CheckerEngineOptions, CheckerGenerator, CheckerLease, CheckerVersion } from "./contracts.js";
import { checkerExperienceHasSharedOracle } from "./feedback.js";
import { decodeGenerationEvaluation } from "../../adapters/board/generation-record.js";
import { checkerJobId, claimCheckerJob, recoverCheckerJobs } from "./jobs.js";
import { learnCheckers } from "./learning.js";
import { readCheckerBoard, saveCheckerRecord, checkerRecordId } from "../../adapters/board/store.js";
import { withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { writeCheckArtifact } from "../../adapters/board/artifacts.js";
import { createExecutableCheckLearning } from "./runtime.js";
import { runClaimedChecker } from "./run-claims.js";

const AT = "2026-11-03T00:00:00.000Z", SCOPE = "project:bounded-check-learning";
const BASIS = { text: "Total must be a nonnegative number; zero is valid." };
const REQUIREMENTS: CheckRequirements = { ...BASIS, ref: "requirement:total", digest: requirementDigest(BASIS) };
const SIGNAL = new AbortController().signal;
const QUOTA = { modelCalls: 10, executions: 32, tokens: 262144 };

function input(total: number, instruction = "Create an invoice"): CheckInput {
  return { task: { instruction, requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest },
    phase: "before_completion", output: { total } };
}

function checker(constant = false): LearnedChecker {
  return { schemaVersion: 2, type: "learned_checker", question: "Does the total meet the frozen requirement?",
    claim: "Check nonnegative numeric totals and preserve legitimate zero.", applicability: { scope: SCOPE, requirementRef: REQUIREMENTS.ref,
      requirementDigest: REQUIREMENTS.digest, requiredKeys: [], excludedKeys: [], instructionIncludes: [] }, timing: ["before_completion"],
    source: constant ? 'module.exports = input => ({status:"pass",findings:[]});'
      : 'module.exports = input => { const valid = typeof input.output.total === "number" && input.output.total >= 0; return {status:valid ? "pass" : "fail",findings:valid ? [] : [{requirementRef:input.task.requirementRef,message:"nonnegative numeric total required"}]}; };',
    sourceRefs: ["experience:source-pass"] };
}

async function fixture(t: { after(run: () => Promise<void>): void }, generate: CheckerGenerator["generate"]) {
  const parent = testScratchPath("checker-bounded-learning-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options: CheckerEngineOptions = { boardRoot: path.join(root, "board"), generator: { generate }, now: () => Date.parse(AT),
    collection: () => "enabled", owner: { id: "owner:unit", alive: async () => "dead" },
    executor: { execute: async (candidate, facts) => {
      const sandbox = { module: { exports: undefined as unknown }, input: facts };
      runInNewContext(candidate.source + "; answer = module.exports(input)", sandbox, { timeout: 1000 });
      const value: unknown = Reflect.get(sandbox, "answer");
      return { kind: "value", value: JSON.parse(JSON.stringify(value)) };
    } } };

  for (const [id, total, verdict] of [["source-pass", 0, "valid"], ["source-fail", -1, "invalid"],
    ["hidden-pass", 92317, "valid"], ["hidden-fail", -81329, "invalid"]] as const) {
    const experience: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "experience:" + id,
      scope: SCOPE, sessionId: "session:source", turnId: "turn:" + id, requirements: REQUIREMENTS, facts: input(total),
      assessment: { kind: "task_oracle", verdict, sourceRef: "oracle:" + id }, priorRuns: [] };
    const saved = await saveCheckerRecord(options.boardRoot, experience, AT);
    assert.ok(saved.ok, JSON.stringify(saved));
  }

  return { root, options };
}

function publicPromptData(prompt: string): { readonly experiences: readonly CheckExperience[]; readonly feedback?: string } {
  const marker = "以下 JSON 是冻结的公开数据：\n";
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as { experiences: CheckExperience[]; feedback?: string };
}

function generated(text: string) { return { status: "generated" as const, text, model: "fixed-unit-provider", usage: { inputTokens: 100, outputTokens: 100 } }; }

test("one internally chosen topic repairs parse failure and false negatives within three reserved calls", async t => {
  const prompts: string[] = [];
  const responses = ["{broken", JSON.stringify(checker(true)), JSON.stringify(checker())];
  const fx = await fixture(t, async request => {
    prompts.push(request.prompt);
    return generated(responses[prompts.length - 1]!);
  });
  const result = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(prompts.length, 3);
  assert.equal(result.jobs[0]?.outcome, "generated");
  assert.equal(result.usage.modelCalls, 3);
  assert.equal(result.usage.executions, 8);
  assert.ok(prompts[1]!.includes("invalid_checker"));
  assert.ok(prompts[2]!.includes("falseNegatives"));
  assert.ok(prompts.every(prompt => !prompt.includes("92317") && !prompt.includes("-81329") && !prompt.includes("hidden-pass")));
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.versions.length, 1);
  assert.equal(state.catalog.versions[0]?.value.evaluation?.status, "supported");
  assert.equal(state.state.assets.filter(asset => recordOf(asset.content) && asset.content.type === "checker_generation").length, 3);
  assert.equal(state.state.assets.filter(asset => recordOf(asset.content) && asset.content.type === "checker_generation_evaluation").length, 2);
  const report = state.catalog.generationEvaluations.at(-1)!;

  assert.ok(decodeGenerationEvaluation(report, state.catalog));
  const holdout = report.validationSamples.find(sample => sample.role === "holdout")!;

  assert.equal(decodeGenerationEvaluation(report, { ...state.catalog, generationStarts: state.catalog.generationStarts.map(started => ({ ...started,
    exposedInputs: [...started.exposedInputs, contentHashOf(holdout.input)] })) }), undefined);
  const forged = report.validationSamples.map(sample => ({ ...sample, oracle: { ...sample.oracle, sourceRef: "fabricated:oracle" } }));

  assert.equal(decodeGenerationEvaluation({ ...report, validationSamples: forged,
    evaluation: { ...report.evaluation, samplesHash: contentHashOf(forged) } }, state.catalog), undefined);
});

test("malformed output spends at most three calls and failures retain public output and usage", async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return generated("MALFORMED-PUBLIC-" + calls);
  });
  const result = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);

  assert.ok(result.ok);
  assert.equal(calls, 3);
  assert.equal(result.jobs[0]?.outcome, "rejected");
  assert.equal(result.usage.tokens, 600);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  const outputs = state.state.assets.filter(asset => recordOf(asset.content) && asset.content.type === "checker_generation").map(asset => JSON.stringify(asset.content));

  assert.equal(outputs.length, 3);
  assert.ok(outputs[0]?.includes("MALFORMED-PUBLIC-1"));
  assert.equal(state.catalog.versions.length, 0);
  const replay = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);
  assert.ok(replay.ok);
  assert.equal(calls, 3);
});

test("secret-shaped output is withheld and never executed or echoed into another prompt", async t => {
  const secret = "DEVELOPMENT-ONLY-NOT-A-CREDENTIAL";
  const prompts: string[] = [];
  const fx = await fixture(t, async request => { prompts.push(request.prompt);
  return generated(prompts.length === 1
    ? JSON.stringify({ apiKey: secret }) : JSON.stringify({ schemaVersion: 2, decision: "no_change", reason: "need more facts" })); });
  const result = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);

  assert.ok(result.ok);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(prompt => !prompt.includes(secret)));
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  const evidence = JSON.stringify(state.state.assets);
  assert.equal(evidence.includes(secret), false);
  assert.ok(evidence.includes("credential_shape"));
});

test("orphan lease-only submissions close without invoking external work", async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return generated(JSON.stringify(checker()));
  });
  const basis = contentHashOf("partial-submission");
  const lease: CheckerLease = { schemaVersion: 2, type: "checker_lease", jobId: checkerJobId(basis),
    scope: SCOPE, ownerId: "dead-owner", allowance: { modelCalls: 3, executions: 12, tokens: 30000 }, basis };

  assert.ok((await saveCheckerRecord(fx.options.boardRoot, lease, AT)).ok);
  const recovery = await recoverCheckerJobs(fx.options);
  assert.ok(recovery.ok);
  assert.deepEqual(recovery.recovered, [lease.jobId]);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.state.jobs.find(job => job.jobId === lease.jobId)?.state, "failed");
  assert.deepEqual(state.catalog.results.find(item => item.jobId === lease.jobId)?.usage, { modelCalls: 0, executions: 0, tokens: 0 });
  assert.equal(calls, 0);
  assert.deepEqual((await recoverCheckerJobs(fx.options)).ok, true);
});

test("real feedback text and source stay linked to the matching requirement without leaking holdout cases", async t => {
  const prompts: string[] = [];
  const fx = await fixture(t, async request => {
    prompts.push(request.prompt);
    return generated(JSON.stringify(checker()));
  });
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  const version: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker: checker(), requirements: REQUIREMENTS,
    experienceRefs: [state.catalog.experiences[0]!.versionId], generation: { requestId: "legacy-test", model: "test-only", usage: { inputTokens: 0, outputTokens: 0 } } };
  const saved = await saveCheckerRecord(fx.options.boardRoot, version, AT);
  assert.ok(saved.ok);
  const facts = input(7);
  const run = await runClaimedChecker(fx.options, { runId: "run:feedback", versionId: saved.versionId,
    scope: SCOPE, sessionId: "session:feedback", turnId: "turn:feedback", requirements: REQUIREMENTS, input: facts, inputDigest: contentHashOf(facts) },
    async () => ({ kind: "checked", verdict: { status: "pass", findings: [] } }));

  assert.ok(run.ok && run.run !== undefined);
  assert.ok((await saveCheckerRecord(fx.options.boardRoot, { schemaVersion: 2, type: "checker_feedback", scope: SCOPE,
    sessionId: "session:feedback", turnId: "turn:feedback", sourceRef: "feedback:actual-owner", text: "Preserve zero when refining this check.", appliesTo: { kind: "class", requirementRef: REQUIREMENTS.ref, requirementDigest: REQUIREMENTS.digest }, runIds: ["run:feedback"] }, AT)).ok);
  const result = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);
  assert.ok(result.ok);
  assert.ok(prompts[0]?.includes("feedback:actual-owner"));
  assert.ok(prompts[0]?.includes("Preserve zero"));
  assert.equal(prompts[0]?.includes("92317"), false);
});

test("total model, execution and token spend stays inside the caller allocation", async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return generated(JSON.stringify(checker(true)));
  });
  const allowance = { modelCalls: 2, executions: 3, tokens: 50000 };
  const result = await learnCheckers(fx.options, { subsystem: "verifier", allowance }, SIGNAL);

  assert.ok(result.ok);
  assert.equal(calls, 2);
  assert.equal(result.usage.executions, 3);
  assert.ok(result.usage.modelCalls <= allowance.modelCalls && result.usage.tokens <= allowance.tokens);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.versions.length, 0);
  assert.ok(state.catalog.generationEvaluations.every(item => item.evaluation.status === "incomplete"));
});

test("late cancellation and unknown transport spend stay typed and do not retry blindly", async t => {
  const controller = new AbortController();
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    controller.abort();
    return generated(JSON.stringify(checker()));
  });
  const cancelled = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, controller.signal);

  assert.ok(cancelled.ok);
  assert.equal(cancelled.stop, "cancelled");
  assert.equal(calls, 1);
  const first = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(first.ok);
  assert.equal(first.catalog.versions.length, 0);
  assert.equal(first.catalog.generations[0]?.outcome, "cancelled");
  let transportCalls = 0;
  const other = await fixture(t, async () => {
    transportCalls += 1;
    throw new Error("transport has unknown delivery");
  });
  const failed = await learnCheckers(other.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);

  assert.ok(failed.ok);
  assert.equal(transportCalls, 1);
  assert.equal(failed.jobs[0]?.outcome, "failed");
  const state = await readCheckerBoard(other.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.generations[0]?.usageStatus, "unknown");
  assert.equal(state.catalog.generations[0]?.chargedTokens, state.catalog.generationStarts[0]?.tokenReserve);
});

test("queued submission windows recover idempotently with no provider call", async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return generated(JSON.stringify(checker()));
  });
  const basis = contentHashOf("queued-submission"), jobId = checkerJobId(basis);
  const lease: CheckerLease = { schemaVersion: 2, type: "checker_lease", jobId, scope: SCOPE, ownerId: "owner:old",
    allowance: { modelCalls: 3, executions: 12, tokens: 30000 }, basis };

  assert.ok((await saveCheckerRecord(fx.options.boardRoot, lease, AT)).ok);
  const queued = await withBoardWriter(fx.options.boardRoot, store => store.apply({ type: "enqueue_job", commandId: jobId + ":enqueue", issuedAt: AT,
    job: { jobId, observationId: basis, domain: "verifier", scope: SCOPE, maxAttempts: 1, dedupeKey: basis } }));

  assert.ok(queued.ok);
  const recovery = await recoverCheckerJobs(fx.options);
  assert.ok(recovery.ok);
  assert.deepEqual(recovery.recovered, [jobId]);
  assert.equal(calls, 0);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.results[0]?.reason, "owner_lost_before_external_work");
  const repeated = await recoverCheckerJobs(fx.options);
  assert.ok(repeated.ok);
  assert.deepEqual(repeated.recovered, []);
});

test("a committed failure repairs its missing terminal command even when its owner remains alive", async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return generated(JSON.stringify(checker()));
  });
  const basis = contentHashOf("result-before-terminal"), jobId = checkerJobId(basis);
  const lease: CheckerLease = { schemaVersion: 2, type: "checker_lease", jobId, scope: SCOPE, ownerId: fx.options.owner.id,
    allowance: { modelCalls: 3, executions: 12, tokens: 30000 }, basis };
  const claimed = await claimCheckerJob(fx.options, lease);
  assert.ok(claimed.ok && claimed.claimed);
  assert.ok((await saveCheckerRecord(fx.options.boardRoot, { schemaVersion: 2, type: "checker_job_result", jobId, scope: SCOPE,
    outcome: "failed", reason: "fault_before_external_work", usage: { modelCalls: 0, executions: 0, tokens: 0 } }, AT)).ok);
  const recovery = await recoverCheckerJobs({ ...fx.options, owner: { ...fx.options.owner, alive: async () => "alive" } });

  assert.ok(recovery.ok);
  assert.deepEqual(recovery.recovered, [jobId]);
  assert.equal(calls, 0);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.state.jobs.find(job => job.jobId === jobId)?.state, "failed");
  assert.equal(state.catalog.results.length, 1);
});

test("unknown owner waits and a dead generation reservation closes unknown without replaying the topic", async t => {
  let calls = 0;
  const fx = await fixture(t, async () => {
    calls += 1;
    return generated(JSON.stringify(checker()));
  });
  const initial = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(initial.ok);
  const basis = contentHashOf({ experiences: initial.catalog.experiences.map(item => item.versionId), feedback: [] });
  const jobId = checkerJobId(basis), allowance = { modelCalls: 3, executions: 12, tokens: 30000 };
  const claimed = await claimCheckerJob(fx.options, { schemaVersion: 2, type: "checker_lease", jobId, scope: SCOPE,
    ownerId: fx.options.owner.id, allowance, basis });
  assert.ok(claimed.ok && claimed.claimed);
  assert.ok((await saveCheckerRecord(fx.options.boardRoot, { schemaVersion: 2, type: "checker_generation_started", jobId, scope: SCOPE,
    requestId: jobId + ":generation:1", ownerId: fx.options.owner.id, attempt: 1, requirementRef: REQUIREMENTS.ref,
    requirementDigest: REQUIREMENTS.digest, promptDigest: contentHashOf("public prompt"), tokenReserve: 10000, maxOutputTokens: 512,
    exposedInputs: [contentHashOf(initial.catalog.experiences[0]!.value.facts)],
    experienceRefs: [initial.catalog.experiences[0]!.versionId] }, AT)).ok);
  const unknown = { ...fx.options, owner: { id: "owner:restart", alive: async () => "unknown" as const } };
  const waiting = await learnCheckers(unknown, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);

  assert.ok(waiting.ok);
  assert.equal(waiting.stop, "worker_running");
  assert.equal(calls, 0);
  const dead = { ...unknown, owner: { ...unknown.owner, alive: async () => "dead" as const } };
  const resumed = await learnCheckers(dead, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);

  assert.ok(resumed.ok);
  assert.equal(calls, 0);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.results[0]?.reason, "owner_lost_outcome_unknown");
  assert.deepEqual(state.catalog.results[0]?.usage, allowance);
  assert.equal(state.catalog.generations.length, 0);
  assert.equal(state.catalog.generationStarts.length, 1);
});

test("legacy public unassessed artifacts cannot become holdouts by changing instruction and phase", async t => {
  const prompts: string[] = [];
  const fx = await fixture(t, async request => {
    prompts.push(request.prompt);
    return generated(JSON.stringify(checker()));
  });
  const rawFacts: CheckInput = { ...input(92317, "Previously public tool observation"), phase: "after_tool",
    tool: { name: "legacy_tool", args: {}, result: { total: 92317 } } };
  const raw: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "experience:public-unassessed", scope: SCOPE,
    sessionId: "session:old", turnId: "turn:old", requirements: REQUIREMENTS, facts: rawFacts, priorRuns: [] };
  const experience = await saveCheckerRecord(fx.options.boardRoot, raw, AT);
  assert.ok(experience.ok);
  const legacy: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker: checker(), requirements: REQUIREMENTS,
    experienceRefs: [experience.versionId], generation: { requestId: "legacy-public-generation", model: "test-only",
      usage: { inputTokens: 1, outputTokens: 1 }, exposedInputs: [contentHashOf(rawFacts)] } };

  assert.ok((await saveCheckerRecord(fx.options.boardRoot, legacy, AT)).ok);
  const learned = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);
  assert.ok(learned.ok);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.versions.at(-1)?.value.evaluation, undefined, "no independent positive holdout remains");
  assert.ok(prompts[0]?.includes("92317"), "the already public target is source material");
  assert.equal(prompts[0]?.includes("-81329"), false, "the genuinely unseen negative remains hidden");
  assert.ok(state.catalog.generationStarts[0]?.exposedInputs.includes(checkerTargetFingerprint(rawFacts)));
});

test("raw task feedback without a checker run still proposes improvements and never creates gold", async t => {
  const prompts: string[] = [];
  const sourceRef = "feedback:owner-before-any-checker";
  const candidate = { ...checker(), sourceRefs: [sourceRef] };
  const fx = await fixture(t, async request => {
    prompts.push(request.prompt);
    return generated(JSON.stringify(candidate));
  });
  const runtime = createExecutableCheckLearning(fx.options);

  assert.ok((await runtime.feedback({ scope: SCOPE, sessionId: "session:source", turnId: "turn:source-fail",
    sourceRef, text: "Check numeric type and preserve zero; the earlier task was missed.", runIds: [] }, SIGNAL)).ok);
  const unrelated = await runtime.feedback({ scope: SCOPE, sessionId: "other-session", turnId: "other-turn",
    sourceRef: "feedback:unrelated-task", text: "Unrelated feedback for a different task.", runIds: [] }, SIGNAL);

  assert.ok(unrelated.ok, JSON.stringify(unrelated));
  const learned = await runtime.learn({ subsystem: "verifier", allowance: QUOTA }, SIGNAL);
  assert.ok(learned.ok);
  assert.ok(prompts[0]?.includes(sourceRef));
  assert.ok(prompts[0]?.includes("Check numeric type and preserve zero"));
  const feedbackText = publicPromptData(prompts[0]!).feedback!;
  const signals = JSON.parse(feedbackText.slice(feedbackText.indexOf("["))) as { appliesTo: unknown; evidenceRole: string }[];

  assert.deepEqual(signals[0]?.appliesTo, { kind: "task", sessionId: "session:source", turnId: "turn:source-fail" });
  assert.equal(signals[0]?.evidenceRole, "raw_signal_not_oracle");
  assert.equal(prompts[0]?.includes("Unrelated feedback for a different task."), false);
  const state = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(state.ok);
  assert.equal(state.catalog.runs.length, 0);
  assert.equal(state.catalog.experiences.length, 4);
  assert.deepEqual(state.catalog.versions.at(-1)?.value.checker.sourceRefs, [sourceRef]);
});

test("a checker parent cannot cross requirement references that happen to have the same text", async t => {
  const fx = await fixture(t, async () => generated(JSON.stringify(checker())));
  const initial = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(initial.ok);
  const first: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker: checker(), requirements: REQUIREMENTS,
    experienceRefs: [initial.catalog.experiences[0]!.versionId], generation: { requestId: "legacy-parent", model: "test-only", usage: { inputTokens: 0, outputTokens: 0 } } };
  const parent = await saveCheckerRecord(fx.options.boardRoot, first, AT);
  assert.ok(parent.ok);
  const otherRequirements = { ...REQUIREMENTS, ref: "requirement:other-reference" };
  const wrong: CheckerVersion = { ...first, requirements: otherRequirements, checker: { ...first.checker, parentVersionId: parent.versionId,
    applicability: { ...first.checker.applicability, requirementRef: otherRequirements.ref } } };
  const versionId = checkerRecordId(wrong);
  const stored = await writeCheckArtifact(fx.options.boardRoot, { versionId, scope: SCOPE, kind: "verification_recipe", source: "inferred",
    sourceRefs: first.experienceRefs, content: wrong, parentVersionId: parent.versionId, issuedAt: AT, hypothesis: wrong.checker.question });

  assert.ok(stored.ok);
  const corrupt = await readCheckerBoard(fx.options.boardRoot);
  assert.equal(corrupt.ok, false);

  if (!corrupt.ok) assert.equal(corrupt.code, "checker_store_corrupt");
});

test("legacy automatic task judgments retain history but cannot become shared gold or public oracle labels", async t => {
  const prompts: string[] = [];
  const fx = await fixture(t, async request => {
    prompts.push(request.prompt);
    return generated(JSON.stringify(checker()));
  });
  const initial = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(initial.ok);
  const version: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker: checker(), requirements: REQUIREMENTS,
    experienceRefs: [initial.catalog.experiences[0]!.versionId], generation: { requestId: "legacy-task-parent", model: "test-only", usage: { inputTokens: 0, outputTokens: 0 } } };
  const saved = await saveCheckerRecord(fx.options.boardRoot, version, AT);
  assert.ok(saved.ok);
  const facts = input(73), runId = "run:old", sourceRef = "feedback:old";
  const ran = await runClaimedChecker(fx.options, { runId, versionId: saved.versionId, scope: SCOPE, sessionId: "session:legacy", turnId: "turn:legacy",
    requirements: REQUIREMENTS, input: facts, inputDigest: contentHashOf(facts) },
    async () => ({ kind: "checked", verdict: { status: "pass", findings: [] } }));

  assert.ok(ran.ok && ran.run !== undefined, JSON.stringify(ran));
  assert.ok((await saveCheckerRecord(fx.options.boardRoot, { schemaVersion: 2, type: "checker_feedback", scope: SCOPE,
    sessionId: "session:legacy", turnId: "turn:legacy", sourceRef, text: "Keep this judgment local to this task.",
    runIds: [runId], judgment: { runId, expected: "pass" } }, AT)).ok);
  const old: CheckExperience = { schemaVersion: 2, type: "check_experience", id: "checker-judgment:" + contentHashOf([sourceRef, runId]),
    scope: SCOPE, sessionId: "session:legacy", turnId: "turn:legacy", requirements: REQUIREMENTS, facts,
    assessment: { kind: "user_correction", sourceRef, verdict: "valid" }, priorRuns: [runId] };

  assert.ok((await saveCheckerRecord(fx.options.boardRoot, old, AT)).ok);
  const before = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(before.ok);
  assert.equal(checkerExperienceHasSharedOracle(before.catalog, old), false);
  assert.equal(checkerExperienceHasSharedOracle(before.catalog, { ...old, id: "experience:manual-independent-owner" }), true);
  const learned = await learnCheckers(fx.options, { subsystem: "verifier", allowance: QUOTA }, SIGNAL);
  assert.ok(learned.ok);
  const after = await readCheckerBoard(fx.options.boardRoot);
  assert.ok(after.ok);
  assert.ok(after.catalog.experiences.some(item => item.value.id === old.id && item.value.assessment !== undefined), "immutable history is retained");
  assert.equal(after.catalog.versions.at(-1)?.value.validationSamples?.some(sample => sample.id === old.id), false);
  const publicData = publicPromptData(prompts[0]!);
  const raw = publicData.experiences.find(experience => experience.id === old.id);

  assert.ok(raw);
  assert.equal(raw.assessment, undefined, "local task judgment is public raw experience, never a teaching oracle");
});
