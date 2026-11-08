/** Real local files and checkers, with an intentionally deterministic example consumer.
 * This demonstrates the runtime contract; it is not a real-provider or Desktop test.
 * Run after build, or use --source with source-loader on Node 24.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { taskPath } from "../../../scripts/workspace-paths.mjs";

const buildArg = process.argv.find(value => value.startsWith("--build="));
const base = buildArg ? pathToFileURL(path.resolve(buildArg.slice("--build=".length)) + path.sep)
  : new URL(process.argv.includes("--source") ? "../../src/" : "../../dist/", import.meta.url);
const load = relative => import(new URL(relative, base));
const [{ createFileBoardStore }, { createFileVerificationRegistry }, { createSkillExperienceFile },
  { createSkillLearningSubsystem }, { skillsPortFor }, { createSkillTools }, { renderSkillVariantMarkdown }, { evaluateCandidate }] = await Promise.all([
  load("internal/adapters/learning-store/file-event-store.js"), load("internal/adapters/verification-authority-store/index.js"),
  load("internal/integration/skill-learning/experience-file.js"), load("internal/integration/skill-learning/runtime.js"),
  load("internal/surface/cli/skills-wiring.js"), load("internal/adapters/tools/skill/index.js"),
  load("internal/learning/domains/skill/index.js"), load("internal/evaluation/evaluator.js"),
]);

const arg = process.argv.find(value => value.startsWith("--output="));
const root = path.resolve(arg?.slice("--output=".length) ?? taskPath("skill-learning-demo"));

await mkdir(root, { recursive: true });

const workspaceId = "skill-demo-json-report";
const family = { id: "json-report", intentClass: "normalize_json_report", checkKind: "acceptance",
  language: "json", repoKind: "report", checkSchema: "rows-v1" };
const sortedSteps = ["read input JSON", "sort rows by id", "write report JSON", "check report invariants"];
const fixedSteps = ["read input JSON", "preserve input row order", "write report JSON", "check report invariants"];
const wrongSteps = ["read input JSON", "drop zero amounts", "write report JSON", "check report invariants"];
const at = "2026-11-03T00:00:00.000Z";
const history = createSkillExperienceFile({ root: path.join(root, "facts"), workspaceId, collection: () => "enabled" });
const board = createFileBoardStore(path.join(root, "board"));

assert.ok("apply" in board, JSON.stringify(board));

let receipt = 0;
const registry = createFileVerificationRegistry({ path: path.join(root, "authority", "receipts.ndjson"),
  clock: () => at, idFactory: domain => `demo:${domain}:${++receipt}` });
const receiptsFile = path.join(root, "authority", "receipts.ndjson");

// Keep receipt identities unique on reruns, while preserving earlier failure evidence.
try { receipt = (await readFile(receiptsFile, "utf8")).trim().split("\n").length; }
catch (error) { if (error.code !== "ENOENT") throw error; }

const trace = [];
// Acceptance is set by the task owner, separately from candidate instructions.
let acceptedOrder = "sorted";
const grant = { subsystem: "skill", allowance: { maxEpisodes: 32, maxInputBytes: 131072, maxEvaluations: 1 } };

function stepsFrom(content) {
  // A small, explicit consumer for this representative family. Production model
  // generalization is deliberately outside this local acceptance claim.
  const numbered = content.split("\n").filter(line => /^\d+\. /.test(line))
    .map(line => line.replace(/^\d+\. /, "").replace(/ \[[^\]]*\]$/, ""));
  assert.ok(numbered.length >= 2, "skill must supply the actual procedure");
  return numbered;
}

async function task(id, rows, steps, order = "sorted") {
  const dir = path.join(root, "tasks", id);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "input.json"), JSON.stringify({ rows }, null, 2));
  const input = JSON.parse(await readFile(path.join(dir, "input.json"), "utf8"));
  let output = [...input.rows];

  for (const step of steps) {
    if (step === "sort rows by id") output.sort((a, b) => a.id.localeCompare(b.id));
    if (step === "drop zero amounts") output = output.filter(row => row.amount);
  }

  await writeFile(path.join(dir, "report.json"), JSON.stringify({ rows: output }, null, 2));
  const actual = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
  const expected = { rows: order === "sorted" ? [...rows].sort((a, b) => a.id.localeCompare(b.id)) : rows };
  let passed = true;

  try { assert.deepEqual(actual, expected); } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    passed = false;
  }

  const check = { id, passed, expected, actual, checkRef: `execution:check:${id}` };

  await writeFile(path.join(dir, "check.json"), JSON.stringify(check, null, 2));
  trace.push({ kind: "task", id, passed, steps, report: path.join(dir, "report.json") });

  return check;
}

function record(check, steps, usedSkill, correction) {
  const usage = usedSkill === undefined ? undefined : { versionId: usedSkill.versionId, variantId: usedSkill.variantId, contentHash: usedSkill.contentHash };
  const fact = { workspaceId, runId: `run:${check.id}`, sourceRef: `execution:${check.id}`,
    episode: { id: check.id, taskFamily: family, outcome: check.passed && !correction ? "success" : "failure",
      trajectory: { nodeIds: steps, stepCount: steps.length, hadChecks: true, hadFailureRecovery: !check.passed },
      steps, checks: ["report exactly matches independent expected rows"],
      ...(!check.passed || correction ? { failureMode: correction?.reason ?? "zero-valued rows were lost" } : {}),
      ...(correction ? { correction } : {}) },
    qualification: correction ? { kind: "explicit_correction", ref: `user_explicit:${check.id}` }
      : { kind: "external_check", ref: check.checkRef }, ...(usage ? { usedSkill: usage } : {}) };
  const appended = history.append(fact);

  assert.ok(appended.ok, JSON.stringify(appended));
}

const learning = createSkillLearningSubsystem({ board, authority: { verify: registry.verify }, collection: () => "enabled", now: () => at,
  opportunity: async () => {
    const read = history.read("json-report-learning");
    assert.ok(read.ok, JSON.stringify(read));
    return read.opportunity;
  },
  evaluate: async request => {
    const variant = request.content.draft.variants[0];
    const content = renderSkillVariantMarkdown(request.content.draft, variant);
    const order = acceptedOrder;
    const checks = await Promise.all([
      task(`trial-v${request.content.draft.version}-a`, [{ id: "Z", amount: 0 }, { id: "A", amount: 7 }], stepsFrom(content), order),
      task(`trial-v${request.content.draft.version}-b`, [{ id: "Q", amount: 11 }, { id: "B", amount: 0 }], stepsFrom(content), order),
    ]);

    assert.ok(checks.every(check => check.passed));
    const baselineRef = request.baselineVersionId ?? "baseline:drop-zero";
    const state = await board.load();
    assert.ok(state.ok);
    const prior = state.state.assets.find(asset => asset.versionId === request.baselineVersionId);
    const baseline = await task(`trial-v${request.content.draft.version}-baseline`,
      [{ id: "Z", amount: 0 }, { id: "A", amount: 7 }], prior?.content?.draft?.variants?.[0]?.steps ?? wrongSteps, order);
    const evidence = evaluateCandidate({ proposalId: request.content.draft.id, baselineRef, candidateRef: request.versionId,
      generatorRoleId: "skill_inducer", evaluatorRoleId: "independent-local-report-checker",
      baselineAnchors: [{ kind: "test", result: baseline.passed ? "pass" : "fail", ref: baseline.checkRef, selfGenerated: false }],
      candidateAnchors: checks.map(check => ({ kind: "test", result: check.passed ? "pass" : "fail", ref: check.checkRef, selfGenerated: false })),
      weakSignals: [], costDelta: 0, latencyDelta: 0, outputLengthDelta: 0, criticalRegressionFailed: false,
      failureDiversity: 1, sampleSize: checks.length });
    const issued = await registry.issue({ domain: "user_explicit", subject: { subjectKind: "content_candidate",
      subjectId: request.content.draft.id, subjectVersion: request.versionId, scope: request.scope },
      generatorId: "skill_inducer", verifierId: "independent-local-report-checker", issuedAt: at,
      sourceFactRef: checks[0].checkRef });

    assert.ok(issued.ok, JSON.stringify(issued));

    return { kind: "evidence", receiptRef: issued.receipt.receiptId, evidence };
  } });

async function ordinarySkillCall(id, taskFamily = family) {
  const loaded = await board.load();
  assert.ok(loaded.ok);
  const exposures = [];
  const wiring = skillsPortFor(root, { TRYLO_HOME: path.join(root, "profile") }, root,
    { state: loaded.state, context: { workspaceId, taskFamily }, onLoaded: exposure => exposures.push(exposure) });

  assert.deepEqual(wiring.problems, []);

  if (!wiring.catalog) return undefined;

  const descriptor = wiring.catalog.list().find(item => item.name.startsWith("learned-"));
  if (!descriptor) return undefined;

  const tools = createSkillTools(wiring.catalog);

  assert.equal(tools.snapshot()[0].needsApproval, true, "existing permission requirement remains");
  const outcome = await tools.execute({ toolCallId: id, name: "skill", arguments: { skill: descriptor.name } }, new AbortController().signal);

  assert.equal(outcome.outcome, "result");
  assert.equal(exposures.length, 1);
  trace.push({ kind: "skill_call", id, ...exposures[0] });

  return { steps: stepsFrom(outcome.output), usedSkill: exposures[0] };
}

try {
  for (const [id, rows, steps] of [
    ["history-success-a", [{ id: "D", amount: 0 }, { id: "A", amount: 3 }], sortedSteps],
    ["history-success-b", [{ id: "C", amount: 5 }, { id: "B", amount: 0 }], sortedSteps],
    ["history-fail", [{ id: "A", amount: 0 }, { id: "B", amount: 5 }], wrongSteps],
  ]) record(await task(id, rows, steps), steps);

  const first = await learning.learn(grant);
  assert.equal(first.status, "shadow", JSON.stringify(first));
  const called = await ordinarySkillCall("transfer");
  assert.ok(called);
  const migrated = await task("transfer", [{ id: "K", amount: 0 }, { id: "H", amount: 9 }], called.steps);

  assert.ok(migrated.passed);
  record(migrated, called.steps, called.usedSkill);
  assert.equal(await ordinarySkillCall("counterexample", { ...family, checkSchema: "rows-v2-input-order" }), undefined);
  trace.push({ kind: "counterexample", refused: true, changedCondition: "checkSchema" });
  // Explicit correction changes what the next related opportunity should do.
  acceptedOrder = "input";
  const correctionCheck = await task("correction", [{ id: "Z", amount: 0 }, { id: "A", amount: 2 }], called.steps, "input");

  assert.equal(correctionCheck.passed, false);
  record(correctionCheck, called.steps, called.usedSkill, { targetEpisodeIds: ["history-success-a", "history-success-b", "transfer"],
    scope: "condition", reason: "preserve input row order in this report condition" });
  const waiting = await learning.learn(grant);
  assert.equal(waiting.status, "waiting");
  assert.equal(await ordinarySkillCall("stale-after-correction"), undefined, "old trial must stop before replacement exists");

  for (const id of ["corrected-success-a", "corrected-success-b"]) {
    const checked = await task(id, [{ id: "Z", amount: 0 }, { id: "A", amount: 2 }], fixedSteps, "input");
    assert.ok(checked.passed);
    record(checked, fixedSteps);
  }

  const updated = await learning.learn(grant);
  assert.equal(updated.status, "shadow", JSON.stringify(updated));
  assert.notEqual(updated.versionId, first.versionId);
  const next = await ordinarySkillCall("correction-transfer");
  assert.ok(next);
  assert.deepEqual(next.steps, fixedSteps);
  const final = await task("correction-transfer", [{ id: "M", amount: 0 }, { id: "B", amount: 8 }], next.steps, "input");

  assert.ok(final.passed);
  record(final, next.steps, next.usedSkill);
  const state = await board.load();
  assert.ok(state.ok);
  const summary = { passed: true, scope: "local deterministic consumer; real files, Board, skill tool and authority registry",
    first, waiting, updated, checks: { transfer: migrated.passed, misuseRefused: true, correction: final.passed },
    versions: state.state.assets.filter(item => item.kind === "skill").map(item => ({ versionId: item.versionId, parentVersionId: item.parentVersionId, contentHash: item.contentHash })),
    unverified: ["real model/provider use and generalization", "native Desktop/WebView2", "installer/package", "automatic central scheduling"] };

  await writeFile(path.join(root, "trace.json"), JSON.stringify(trace, null, 2));
  await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ passed: true, summary: path.join(root, "summary.json"), trace: path.join(root, "trace.json"), checks: summary.checks }));
} catch (error) {
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ passed: false, message: String(error), trace }, null, 2));
  throw error;
} finally { await board.close(); }
