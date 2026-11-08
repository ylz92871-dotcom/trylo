import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createToolEvolutionVerifier } from "../../../../../../adapters/tool-evolution/process-verifier.js";
import { createBoardReader } from "../../../../../../adapters/learning-store/file-event-store.js";
import { resolveProfile } from "../../../../../profile/resolver.js";
import type { CheckCorrection, CheckObservation } from "../../domain/legacy/contracts.js";
import type { ToolEvolutionCandidate } from "../../../../../domains/tool/evolution/contracts.js";
import type { ToolLearningRecipe } from "../../../../../domains/tool/evolution/pipeline.js";
import type { IsolationOutcome, IsolationPort, IsolationRequest } from "../../../../../../ports/isolation.js";
import { createCheckLearningSubsystem } from "./runtime.js";
import { decodeCheckCatalog } from "../../adapters/board/legacy-records.js";

const SIGNAL = new AbortController().signal;
const NOW = () => 1793664000000;
const BASE = testScratchPath("check-learning-tests");
const GOOD_SOURCE = 'module.exports = input => { if(typeof input.n !== "number") throw Object.assign(new Error("number required"), {code:"invalid_input"}); return input.n * 2; };';
const BAD_SOURCE = 'module.exports = input => { if(typeof input.n !== "number") throw Object.assign(new Error("number required"), {code:"invalid_input"}); return input.n === 0 ? 1 : input.n * 2; };';
const TRANSFER_BAD_SOURCE = 'module.exports = payload => { const value = payload.n; if(typeof value !== "number") throw Object.assign(new Error("numeric payload required"), {code:"invalid_input"}); return value ? value + value : 1; };';
const TRANSFER_GOOD_SOURCE = 'module.exports = payload => { const value = payload.n; if(typeof value !== "number") throw Object.assign(new Error("numeric payload required"), {code:"invalid_input"}); return value + value; };';
const candidate = (source: string, identity = "double"): ToolEvolutionCandidate => ({ identity,
  description: "Double a numeric value.", inputSchema: { type: "object" }, source,
  mastery: { whenToUse: ["Numeric doubling."], preconditions: ["n is numeric."], pitfalls: ["Strings are invalid."] } });
const RECIPE: ToolLearningRecipe = { type: "tool_learning_recipe", schemaVersion: 1, automation: "manual",
  request: { schemaVersion: 1, requestId: "double-recipe", scope: "project:invoice", capability: "double", operation: "create", evidence: [
    { sampleId: "source-one", role: "source", input: { n: 2 }, expected: { kind: "value", value: 4 } },
    { sampleId: "source-two", role: "source", input: { n: 3 }, expected: { kind: "value", value: 6 } },
    { sampleId: "variation", role: "variation", input: { n: 7 }, expected: { kind: "value", value: 14 } },
    { sampleId: "counterexample", role: "counterexample", input: { n: "invalid" }, expected: { kind: "error", code: "invalid_input" } },
  ] } };
const observation = (observationId = "zero-miss"): CheckObservation => ({ schemaVersion: 1, type: "check_observation",
  observationId, scope: RECIPE.request.scope, capability: "double", requirementRef: "requirement:double-v1",
  source: { kind: "false_negative", ref: "execution:invoice-zero-mismatch", runId: "source-task" }, baselineRecipe: RECIPE,
  sample: { sampleId: "zero", role: "variation", input: { n: 0 }, expected: { kind: "value", value: 0 } },
  controls: { faulty: candidate(BAD_SOURCE), valid: candidate(GOOD_SOURCE) } });

/** Test seam: real Node child processes and permission flags; no Windows SRT/WFP claim. */
function processPort(onRun: () => void): IsolationPort {
  return { probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY: host process seam" }),
    run: request => {
      onRun();
      return runProcess(request);
    } };
}

function runProcess(request: IsolationRequest): Promise<IsolationOutcome> {
  return new Promise(resolve => {
    const child = spawn(request.argv[0]!, request.argv.slice(1), { cwd: request.cwd, env: {}, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { stdout = (stdout + text).slice(0, 65537); });
    child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(0, 65537); });
    const abort = () => { child.kill(); };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    };

    request.signal.addEventListener("abort", abort, { once: true });

    if (request.signal.aborted) abort();

    child.on("error", error => {
      cleanup();
      resolve({ outcome: "isolation_failed", code: "isolation_start_failed", message: error.message });
    });
    child.on("close", code => { cleanup();
    resolve(request.signal.aborted ? { outcome: "cancelled" } : {
      outcome: "completed", backend: "windows-srt", stdout, stderr, exitCode: code ?? -1, timedOut }); });
  });
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(BASE, { recursive: true });
  const root = await mkdtemp(path.join(BASE, "case-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  let processes = 0;
  const verifier = createToolEvolutionVerifier({ isolation: processPort(() => { processes += 1; }),
    scratchRoot: path.join(root, "scratch"), nodeExecutable: process.execPath, timeoutMs: 10000 });
  const boardRoot = path.join(root, "board");
  const open = (collect = true) => createCheckLearningSubsystem({ boardRoot, verifier, collect, now: NOW });

  return { root, boardRoot, verifier, open, runtime: open(), processes: () => processes };
}

function task(taskId: string, source = GOOD_SOURCE) {
  return { taskId, scope: RECIPE.request.scope, capability: "double", requirementRef: "requirement:double-v1",
    candidate: candidate(source, `artifact-${taskId}`) };
}

async function learnFirst(runtime: ReturnType<typeof createCheckLearningSubsystem>) {
  assert.equal((await runtime.observe(observation())).ok, true);
  const learned = await runtime.learn({ subsystem: "verifier", quota: 3 }, SIGNAL);

  assert.ok(learned.ok, JSON.stringify(learned));
  assert.equal(learned.spent, 3);
  assert.equal(learned.lessons[0]?.outcome, "trial_supported", JSON.stringify(learned));
  const inventory = await runtime.inspect();

  assert.ok(inventory.ok, JSON.stringify(inventory));
  assert.equal(inventory.recipes.length, 1, JSON.stringify(inventory));

  return inventory.recipes[0]!;
}

function correction(parent: { versionId: string; recipe: ToolLearningRecipe }, appliesTo: CheckCorrection["appliesTo"]): CheckObservation {
  return { ...observation(`correct-zero-${appliesTo.kind}`), source: { kind: "explicit_correction",
    ref: "user_explicit:zero-is-sentinel-for-this-scope", runId: "correction-task" }, baselineRecipe: parent.recipe,
    sample: { sampleId: "zero", role: "variation", input: { n: 0 }, expected: { kind: "value", value: 1 } },
    controls: { faulty: candidate(GOOD_SOURCE), valid: candidate(BAD_SOURCE) },
    correction: { targetVersionId: parent.versionId, appliesTo } };
}

test("learned sample catches a prior miss in a new artifact while valid output still passes", async t => {
  const fx = await fixture(t);

  assert.equal((await fx.verifier.verify(candidate(BAD_SOURCE), RECIPE.request, SIGNAL)).verdict, "pass", "old recipe really misses zero");
  const first = await learnFirst(fx.runtime);
  const bad = await fx.runtime.checkTask(task("new-invoice-export", TRANSFER_BAD_SOURCE), SIGNAL);

  assert.ok(bad.ok && bad.status === "checked", JSON.stringify(bad));
  assert.equal(bad.run.recipeVersionId, first.versionId);
  assert.equal(bad.run.report.verdict, "fail");
  assert.equal(bad.run.report.checks.find(check => check.sampleId === "zero")?.outcome, "wrong_result");
  const good = await fx.runtime.checkTask(task("new-ledger-export", TRANSFER_GOOD_SOURCE), SIGNAL);

  assert.ok(good.ok && good.status === "checked", JSON.stringify(good));
  assert.equal(good.run.report.verdict, "pass");
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.state.activations, []);
  assert.deepEqual(resolveProfile(loaded.state, { scope: RECIPE.request.scope }).requiredCheckRefs, []);
  assert.equal(loaded.state.evidence.length, 0, "a trial report never impersonates authority receipts");
});

test("matching words cannot apply a recipe across project, capability or acceptance requirement", async t => {
  const fx = await fixture(t);
  await learnFirst(fx.runtime);
  const count = fx.processes();

  for (const input of [{ ...task("different-project"), scope: "project:other" },
    { ...task("different-operation"), capability: "round" }, { ...task("different-contract"), requirementRef: "requirement:double-v2" }]) {
    const result = await fx.runtime.checkTask(input, SIGNAL);
    assert.ok(result.ok && result.status === "skipped", JSON.stringify(result));
    assert.equal(result.reason, "no_applicable_recipe");
  }

  assert.equal(fx.processes(), count, "non-applicable recipes cause no candidate execution");
});

test("actual run feedback changes effect counters and false positives suspend future use", async t => {
  const fx = await fixture(t);
  const first = await learnFirst(fx.runtime);
  const checked = await fx.runtime.checkTask(task("feedback-task"), SIGNAL);

  assert.ok(checked.ok && checked.status === "checked");
  assert.equal((await fx.runtime.feedback({ runId: checked.run.runId, sourceRef: "user_explicit:confirmed", kind: "confirmed" })).ok, true);
  assert.equal((await fx.runtime.feedback({ runId: "never-ran", sourceRef: "user_explicit:invalid", kind: "confirmed" })).ok, false);
  const feedback = { runId: checked.run.runId, sourceRef: "user_explicit:false-positive", kind: "false_positive" as const };

  assert.equal((await fx.runtime.feedback(feedback)).ok, true);
  assert.equal((await fx.runtime.feedback(feedback)).ok, true);
  const inventory = await fx.open().inspect();
  assert.ok(inventory.ok);
  const selected = inventory.recipes.find(recipe => recipe.versionId === first.versionId)!;

  assert.equal(selected.performance.uses, 1);
  assert.equal(selected.performance.passed, 1);
  assert.equal(selected.performance.confirmed, 1);
  assert.equal(selected.performance.falsePositives, 1);
  assert.equal(selected.suspended, true);
  const next = await fx.open().checkTask(task("after-false-positive"), SIGNAL);

  assert.ok(next.ok && next.status === "skipped");
});

for (const kind of ["task", "class", "long_term"] as const) {
  test(`${kind} correction changes the next relevant behavior and preserves its scope and history`, async t => {
    const fx = await fixture(t);
    const first = await learnFirst(fx.runtime);
    const before = await fx.runtime.checkTask(task("before-correction", BAD_SOURCE), SIGNAL);

    assert.ok(before.ok && before.status === "checked");
    assert.equal(before.run.report.verdict, "fail");
    const appliesTo = kind === "task" ? { kind, taskId: "corrected-opportunity" } : { kind };

    assert.equal((await fx.runtime.observe(correction(first, appliesTo))).ok, true);
    const learned = await fx.runtime.learn({ subsystem: "verifier", quota: 3 }, SIGNAL);
    assert.ok(learned.ok);
    assert.equal(learned.lessons[0]?.outcome, "trial_supported", JSON.stringify(learned));
    const inventory = await fx.open().inspect();
    assert.ok(inventory.ok);
    assert.equal(inventory.recipes.length, 2);

    if (kind === "task") {
      const child = inventory.recipes.find(recipe => recipe.versionId !== first.versionId)!;
      for (const widened of [{ kind: "class" as const }, { kind: "task" as const, taskId: "another-task" }]) {
        const result = await fx.runtime.observe({ ...correction(child, widened), observationId: `forbidden-widen-${widened.kind}` });
        assert.equal(result.ok, false, "a task-only parent cannot acquire broader or different-task authority");
      }
    }

    const next = await fx.open().checkTask(task("corrected-opportunity", BAD_SOURCE), SIGNAL);

    assert.ok(next.ok && next.status === "checked", JSON.stringify(next));
    assert.notEqual(next.run.recipeVersionId, first.versionId);
    assert.equal(next.run.report.verdict, "pass");
    const later = await fx.open().checkTask(task("another-opportunity", BAD_SOURCE), SIGNAL);

    assert.ok(later.ok && later.status === "checked", JSON.stringify(later));
    assert.equal(later.run.recipeVersionId === first.versionId, kind === "task");
    assert.equal(later.run.report.verdict, kind === "task" ? "fail" : "pass");
    assert.equal(inventory.runs.find(run => run.runId === before.run.runId)?.report.verdict, "fail", "old run stays immutable");
  });
}

test("quota, cancellation and collection switch stop work without manufacturing a learned asset", async t => {
  const fx = await fixture(t);

  assert.equal((await fx.runtime.observe(observation())).ok, true);
  const limited = await fx.runtime.learn({ subsystem: "verifier", quota: 2 }, SIGNAL);

  assert.ok(limited.ok);
  assert.equal(limited.stop, "quota_exhausted");
  assert.equal(limited.spent, 0);
  assert.equal(fx.processes(), 0);
  const cancelled = new AbortController();
  cancelled.abort();
  const stopped = await fx.runtime.learn({ subsystem: "verifier", quota: 3 }, cancelled.signal);

  assert.ok(stopped.ok);
  assert.equal(stopped.stop, "cancelled");
  assert.equal(fx.processes(), 0);
  const disabled = fx.open(false);

  assert.equal((await disabled.observe(observation("not-collected"))).ok, false);
  const skipped = await disabled.checkTask(task("private-task"), SIGNAL);

  assert.ok(skipped.ok && skipped.status === "skipped");
  assert.equal(skipped.reason, "collection_disabled");
  assert.equal(fx.processes(), 0);
  const inventory = await fx.runtime.inspect();
  assert.ok(inventory.ok);
  assert.equal(inventory.recipes.length, 0);
});

test("malformed authority claims and stale corrections are refused at the boundary", async t => {
  const fx = await fixture(t);

  for (const malformed of [{ ...observation(), schemaVersion: 2 }, { ...observation(), allowNetwork: true },
    { ...observation(), source: { ...observation().source, verdict: "pass" } }]) {
    assert.equal((await fx.runtime.observe(malformed)).ok, false);
  }

  const stale = correction({ versionId: "check:missing-version", recipe: RECIPE }, { kind: "class" });

  assert.equal((await fx.runtime.observe(stale)).ok, false);
  assert.equal(fx.processes(), 0);
});

test("concurrent learning does not repeat a reserved compare or spend another quota", async t => {
  const fx = await fixture(t);
  let verifyCalls = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const verifier = { verify: async (...args: Parameters<typeof fx.verifier.verify>) => {
    verifyCalls += 1;
    if (verifyCalls === 1) {
      entered();
      await hold;
    }
    return fx.verifier.verify(...args);
  } };
  const open = () => createCheckLearningSubsystem({ boardRoot: fx.boardRoot, verifier, collect: true, now: NOW });

  assert.equal((await open().observe(observation())).ok, true);
  const first = open().learn({ subsystem: "verifier", quota: 3 }, SIGNAL);

  await started;
  const second = await open().learn({ subsystem: "verifier", quota: 3 }, SIGNAL);

  release();
  const finished = await first;

  assert.ok(finished.ok);
  assert.equal(finished.spent, 3);
  assert.ok(!second.ok || second.stop === "recovery_required", JSON.stringify(second));
  assert.equal(verifyCalls, 3, "one reserved observation executes exactly one compare");
});

test("corrupt adverse-feedback metadata fails closed instead of reviving a suspended recipe", async t => {
  const fx = await fixture(t);
  await learnFirst(fx.runtime);
  const checked = await fx.runtime.checkTask(task("corrupt-feedback-source"), SIGNAL);

  assert.ok(checked.ok && checked.status === "checked");
  assert.equal((await fx.runtime.feedback({ runId: checked.run.runId, sourceRef: "user_explicit:wrong-check", kind: "false_positive" })).ok, true);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  const feedback = loaded.state.assets.find(asset => asset.versionId.startsWith("check:feedback:"));
  assert.ok(feedback);

  for (const broken of [{ ...feedback, contentHash: "0".repeat(64) }, { ...feedback, scope: "project:wrong" }]) {
    const decoded = decodeCheckCatalog({ ...loaded.state, assets: loaded.state.assets.map(asset => asset.versionId === feedback.versionId ? broken : asset) });
    assert.equal(decoded.ok, false, "damaged adverse evidence is not silently dropped");
  }
});

test("a contradictory fail report with all samples passed is rejected and never persisted", async t => {
  const fx = await fixture(t);
  const first = await learnFirst(fx.runtime);
  const input = task("contradictory-report");
  const actual = await fx.verifier.verify(input.candidate, first.recipe.request, SIGNAL);

  assert.equal(actual.verdict, "pass");
  const runtime = createCheckLearningSubsystem({ boardRoot: fx.boardRoot, collect: true, now: NOW,
    verifier: { verify: async () => ({ ...actual, verdict: "fail" as const }) } });
  const result = await runtime.checkTask(input, SIGNAL);

  assert.equal(result.ok, false, JSON.stringify(result));
  const inventory = await runtime.inspect();
  assert.ok(inventory.ok);
  assert.equal(inventory.runs.length, 0, "malformed adapter reports create no run fact");
});

test("a rejected improvement retains every actual compare report without claiming a supported trial", async t => {
  const fx = await fixture(t);
  const input = observation("unsupported-miss");

  assert.equal((await fx.runtime.observe({ ...input,
    controls: { ...input.controls, faulty: candidate("module.exports = input => 999;") } })).ok, true);
  const learned = await fx.runtime.learn({ subsystem: "verifier", quota: 3 }, SIGNAL);

  assert.ok(learned.ok, JSON.stringify(learned));
  assert.equal(learned.spent, 3);
  assert.equal(learned.lessons[0]?.outcome, "rejected");
  assert.deepEqual(learned.lessons[0]?.attempts?.map(attempt => attempt.role), ["baseline", "faulty", "valid"]);
  assert.deepEqual(learned.lessons[0]?.attempts?.map(attempt => attempt.report.verdict), ["fail", "fail", "pass"]);
  const reopened = await fx.open().inspect();
  assert.ok(reopened.ok);
  assert.equal(reopened.recipes.length, 0);
  assert.equal(reopened.lessons[0]?.attempts?.length, 3, "failed comparisons survive Board replay too");
});
