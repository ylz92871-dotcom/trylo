import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactPath } from "../../../scripts/workspace-paths.mjs";

// Fixed first-party fixtures only. This demo proves real process execution and Board replay;
// this host-process seam does not establish Windows SRT/WFP or native Desktop acceptance.
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const red = args.includes("--red-old-recipe");
const native = args.includes("--native");
const outputFlag = args.indexOf("--output");
const compiledFlag = args.indexOf("--compiled-root");
const evidence = path.join(root, "docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-check-learning");
const output = outputFlag < 0 ? path.join(evidence, "demo-summary.json") : path.resolve(args[outputFlag + 1]);
const compiled = compiledFlag < 0 ? (red ? artifactPath("new-cli-historical-builds", "check-learning-red-build") : path.join(root, "dist")) : path.resolve(args[compiledFlag + 1]);
const { createToolEvolutionVerifier } = await import(pathToFileURL(path.join(compiled, "internal/adapters/tool-evolution/process-verifier.js")).href);

await mkdir(evidence, { recursive: true });

const runRoot = await mkdtemp(path.join(evidence, red ? "red-run-" : native ? "native-run-" : "demo-run-"));
const evidenceLevel = native ? "WindowsIsolation backend requested; actual reports determine acceptance; no Desktop/provider claim"
  : "real Node child processes through a fixed-source host test seam; no OS sandbox/native/provider acceptance";
const signal = new AbortController().signal;
let childProcesses = 0;
const hostProcessSeam = {
  probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "DEMO ONLY: fixed known source, host-process seam" }),
  run: async request => {
    childProcesses += 1;
    const result = spawnSync(request.argv[0], request.argv.slice(1), { cwd: request.cwd, env: {},
      windowsHide: true, timeout: request.timeoutMs, maxBuffer: 65536, encoding: "utf8" });
    if (result.error) return { outcome: "isolation_failed", code: "isolation_start_failed", message: result.error.message };
    return { outcome: "completed", backend: "windows-srt", stdout: result.stdout, stderr: result.stderr,
      exitCode: result.status ?? -1, timedOut: false };
  },
};
let isolation = hostProcessSeam;

if (native) {
  const { createWindowsIsolation } = await import(pathToFileURL(path.join(compiled, "internal/adapters/sandbox/windows/windows-isolation.js")).href);
  const { windowsHelperEnvironment } = await import(pathToFileURL(path.join(compiled, "internal/adapters/sandbox/windows/windows-helper-environment.js")).href);
  isolation = createWindowsIsolation({ hostEnv: windowsHelperEnvironment(process.env) });
}

const verifier = createToolEvolutionVerifier({ isolation, scratchRoot: path.join(runRoot, "scratch"),
  nodeExecutable: process.execPath, timeoutMs: native ? 5000 : 10000,
  ...(native ? { profile: "confined_json_function_v1" } : {}) });
const isolationAvailability = await isolation.probe();
const goodSource = 'module.exports = input => { if(typeof input.n !== "number") throw Object.assign(new Error("number required"), {code:"invalid_input"}); return input.n * 2; };';
const badSource = 'module.exports = input => { if(typeof input.n !== "number") throw Object.assign(new Error("number required"), {code:"invalid_input"}); return input.n === 0 ? 1 : input.n * 2; };';
const transferBad = 'module.exports = payload => { const value = payload.n; if(typeof value !== "number") throw Object.assign(new Error("numeric payload required"), {code:"invalid_input"}); return value ? value + value : 1; };';
const transferGood = 'module.exports = payload => { const value = payload.n; if(typeof value !== "number") throw Object.assign(new Error("numeric payload required"), {code:"invalid_input"}); return value + value; };';
const candidate = (source, identity = "double") => ({ identity, description: "Double numeric input.", source,
  inputSchema: { type: "object" }, mastery: { whenToUse: ["Numeric doubling."], preconditions: ["n is numeric."], pitfalls: ["Reject strings."] } });
const recipe = { type: "tool_learning_recipe", schemaVersion: 1, automation: "manual", request: {
  schemaVersion: 1, requestId: "demo-double", scope: "project:check-learning-demo", capability: "double", operation: "create", evidence: [
    { sampleId: "source-one", role: "source", input: { n: 2 }, expected: { kind: "value", value: 4 } },
    { sampleId: "source-two", role: "source", input: { n: 3 }, expected: { kind: "value", value: 6 } },
    { sampleId: "variation", role: "variation", input: { n: 7 }, expected: { kind: "value", value: 14 } },
    { sampleId: "invalid-input", role: "counterexample", input: { n: "invalid" }, expected: { kind: "error", code: "invalid_input" } },
  ],
} };
const oldReport = await verifier.verify(candidate(badSource), recipe.request, signal);

if (red) {
  console.log("Regression red control: the old recipe accepts the zero-value bug; expecting fail intentionally.");
  console.log(JSON.stringify(oldReport, null, 2));
  assert.equal(oldReport.verdict, "fail", "old recipe missed the zero-value defect");
}

if (oldReport.verdict !== "pass") {
  const failure = { schemaVersion: 1, evidenceLevel, runRoot, status: "baseline_unavailable_or_failed", isolationAvailability, oldReport };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(failure, null, 2) + "\n", "utf8");
  console.error(JSON.stringify(failure, null, 2));
  throw new Error("baseline did not execute successfully; no host fallback or learned asset was produced");
}

assert.equal(oldReport.verdict, "pass", "baseline must reproduce the missed defect");

const { createCheckLearningSubsystem } = await import(pathToFileURL(path.join(compiled, "internal/integration/check-learning/runtime.js")).href);
const { createBoardReader } = await import(pathToFileURL(path.join(compiled, "internal/adapters/learning-store/file-event-store.js")).href);
const boardRoot = path.join(runRoot, "board");
const open = () => createCheckLearningSubsystem({ boardRoot, verifier, collect: true });
let runtime = open();
const observation = { type: "check_observation", schemaVersion: 1, observationId: "demo-zero-miss",
  scope: recipe.request.scope, capability: "double", requirementRef: "requirement:double-v1",
  source: { kind: "false_negative", ref: "execution:demo-zero-expected-0-actual-1", runId: "source-invoice-task" },
  baselineRecipe: recipe, sample: { sampleId: "zero", role: "variation", input: { n: 0 }, expected: { kind: "value", value: 0 } },
  controls: { faulty: candidate(badSource), valid: candidate(goodSource) } };
const saveInput = (name, value) => writeFile(path.join(runRoot, name), JSON.stringify(value, null, 2) + "\n", "utf8");

await saveInput("observation.json", observation);

assert.equal((await runtime.observe(observation)).ok, true);

// External dispatch names the subsystem and gives quota. Topic, compare steps and stopping are internal.
const learned = await runtime.learn({ subsystem: "verifier", quota: 3 }, signal);

assert.ok(learned.ok, JSON.stringify(learned)); assert.equal(learned.spent, 3);

const before = await runtime.inspect(); assert.ok(before.ok); assert.equal(before.recipes.length, 1);

const first = before.recipes[0];
const task = (taskId, source = goodSource) => ({ taskId, scope: recipe.request.scope, capability: "double",
  requirementRef: "requirement:double-v1", candidate: candidate(source, `artifact-${taskId}`) });

await saveInput("task-good.json", task("new-invoice-export", transferGood));

await saveInput("task-bad.json", task("new-ledger-export", transferBad));

const missed = await runtime.checkTask(task("new-ledger-export", transferBad), signal);
const accepted = await runtime.checkTask(task("new-invoice-export", transferGood), signal);

assert.ok(missed.ok && missed.status === "checked"); assert.equal(missed.run.report.verdict, "fail");

assert.ok(accepted.ok && accepted.status === "checked"); assert.equal(accepted.run.report.verdict, "pass");

const processCount = childProcesses;
const avoided = await runtime.checkTask({ ...task("similar-different-contract"), requirementRef: "requirement:sentinel-zero" }, signal);

assert.ok(avoided.ok && avoided.status === "skipped"); assert.equal(childProcesses, processCount);

const feedback = { runId: accepted.run.runId, sourceRef: "execution:accepted-output-confirmed", kind: "confirmed" };

await saveInput("feedback.json", feedback);

assert.equal((await runtime.feedback(feedback)).ok, true);

assert.equal((await runtime.feedback({ runId: missed.run.runId, sourceRef: "user_explicit:zero-is-sentinel-for-this-class", kind: "false_positive" })).ok, true);

const correction = { ...observation, observationId: "demo-correct-zero", baselineRecipe: first.recipe,
  source: { kind: "explicit_correction", ref: "user_explicit:zero-is-sentinel-for-this-class", runId: "correction-task" },
  sample: { ...observation.sample, expected: { kind: "value", value: 1 } },
  controls: { faulty: candidate(goodSource), valid: candidate(badSource) },
  correction: { targetVersionId: first.versionId, appliesTo: { kind: "class" } } };

await saveInput("correction.json", correction);

assert.equal((await runtime.observe(correction)).ok, true);

const correctedLesson = await runtime.learn({ subsystem: "verifier", quota: 3 }, signal);

assert.ok(correctedLesson.ok, JSON.stringify(correctedLesson));

runtime = open();

const corrected = await runtime.checkTask(task("after-restart-corrected-opportunity", badSource), signal);

assert.ok(corrected.ok && corrected.status === "checked", JSON.stringify(corrected));

assert.equal(corrected.run.report.verdict, "pass"); assert.notEqual(corrected.run.recipeVersionId, first.versionId);

const inventory = await runtime.inspect(); assert.ok(inventory.ok);

const board = await createBoardReader(boardRoot).load(); assert.ok(board.ok); assert.equal(board.state.activations.length, 0);

const summary = { schemaVersion: 1, evidenceLevel, isolationAvailability,
  boardRoot, childProcesses, oldReport, learned, transfer: missed, validOutput: accepted, avoided,
  correctedLesson, corrected, inventory, board: { sequence: board.state.sequence, activations: board.state.activations,
    authorityEvidence: board.state.evidence, assets: board.state.assets.map(asset => ({ versionId: asset.versionId,
      kind: asset.kind, scope: asset.scope, source: asset.source, parentVersionId: asset.parentVersionId,
      createdFromProposalId: asset.createdFromProposalId, contentHash: asset.contentHash })) } };

await mkdir(path.dirname(output), { recursive: true });

await writeFile(output, JSON.stringify(summary, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ output, boardRoot, childProcesses, oldBug: oldReport.verdict,
  learnedBug: missed.run.report.verdict, validOutput: accepted.run.report.verdict, avoided: avoided.reason,
  correctedOutput: corrected.run.report.verdict, activations: board.state.activations.length }, null, 2));
