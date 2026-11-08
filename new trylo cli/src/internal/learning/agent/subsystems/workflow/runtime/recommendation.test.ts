import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowCorrection, WorkflowTask, WorkflowTrace } from "../domain/trace-contracts.js";
import { runWorkflowLearning } from "./runtime.js";
import { listWorkflowVersions, readWorkflowVersion, saveWorkflowTrace, saveWorkflowVersion } from "./archive.js";
import { recommendAutomaticWorkflow } from "./recommendation.js";
import { learnWorkflow, selectWorkflowPath } from "../domain/trace-learn.js";

const at = "2026-11-03T00:00:00.000Z";
const task: WorkflowTask = { scope: "project:correction", taskFamily: { id: "report", intentClass: "compile", checkKind: "acceptance" } };

function trace(id: string, conditions = { format: "json" }, checks = ["node build-v1.cjs", "node verify-v1.cjs"]): WorkflowTrace {
  return { ...task, conditions, schemaVersion: 1, traceId: id, source: "imported", outcome: "success", conditionEvidenceRefs: [`${id}:input`],
    steps: [{ nodeId: "build", input: "source", output: "artifact", dependsOn: [], check: checks[0]!, status: "passed", evidenceRefs: [`${id}:build`] },
      { nodeId: "verify", input: "artifact", output: "report", dependsOn: ["build"], check: checks[1]!, status: "passed", evidenceRefs: [`${id}:verify`] }] };
}

async function fixture() {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-recommendation-"));
  const round = async (requestId: string, parentVersionId?: string, correction?: WorkflowCorrection, traces: readonly WorkflowTrace[] = [], selectedTask: WorkflowTask = task) => {
    const result = await runWorkflowLearning({ boardRoot, issuedAt: at, request: { ...selectedTask, requestId, subsystem: "workflow", collect: true,
      budget: { maxEpisodes: 16, maxSteps: 128, maxTokens: 32000 }, traces,
      ...(parentVersionId === undefined ? {} : { parentVersionId }), ...(correction === undefined ? {} : { correction }) } });
    assert.ok(result.ok, JSON.stringify(result));
    return result.value.versionId;
  };
  const versions = async () => {
    const result = await listWorkflowVersions(boardRoot);
    assert.ok(result.ok);
    return result.value;
  };

  return { boardRoot, round, versions, cleanup: () => rm(boardRoot, { recursive: true, force: true }) };
}

test("late old feedback stays historical while the saved correction remains the automatic default", async () => {
  const fx = await fixture();
  try {
    const base = await fx.round("base", undefined, undefined, [trace("seed")]);
    const corrected = await fx.round("corrected", base, { nodeId: "verify", check: "node verify-v2.cjs", reason: "Require v2", when: { format: "json" } });

    assert.ok((await saveWorkflowTrace(fx.boardRoot, { ...trace("late"), source: "runtime", workflowVersionId: base }, at)).ok);
    const late = await fx.round("late-child", base), versions = await fx.versions();
    const recommended = recommendAutomaticWorkflow(versions, { ...task, conditions: { format: "json" } });

    assert.equal(recommended.nomination?.versionId, corrected);
    assert.equal(recommended.learningParent?.versionId, corrected);
    assert.equal(versions.find(item => item.versionId === corrected)?.source, "user_explicit");
    assert.equal(versions.find(item => item.versionId === late)?.source, "inferred");
    const old = await readWorkflowVersion(fx.boardRoot, late);
    assert.ok(old.ok);
    assert.equal(old.value.nodes[1]?.check, "node verify-v1.cjs");
    const downgrade = await saveWorkflowVersion(fx.boardRoot, versions.find(item => item.versionId === corrected)!.artifact, at);

    assert.equal(downgrade.ok, false);
    if (!downgrade.ok) assert.equal(downgrade.code, "workflow_source_conflict");

    const conflict = await saveWorkflowVersion(fx.boardRoot, old.value, at, "user_explicit");

    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "workflow_source_conflict");

    const legacy = versions.map(version => ({ ...version, source: "inferred" as const }));

    assert.equal(recommendAutomaticWorkflow(legacy, { ...task, conditions: { format: "json" } }).nomination?.versionId, corrected);
  } finally { await fx.cleanup(); }
});

test("inheritance cannot refresh an obsolete floor; an explicit same-value reaffirmation can", async () => {
  const fx = await fixture();
  try {
    const base = await fx.round("base", undefined, undefined, [trace("seed")]);
    const correction = { nodeId: "verify", check: "node verify-v2.cjs", reason: "Require v2", when: { format: "json" } };
    const first = await fx.round("first", base, correction), child = await fx.round("child", first);

    assert.equal(recommendAutomaticWorkflow(await fx.versions(), { ...task, conditions: { format: "json" } }).nomination?.versionId, child);
    const newer = await fx.round("new-intent", base, { ...correction, check: "node verify-v3.cjs" });
    const late = await fx.round("inherited-old", child);
    let versions = await fx.versions();

    assert.equal(recommendAutomaticWorkflow(versions, { ...task, conditions: { format: "json" } }).nomination?.versionId, newer);
    assert.equal(versions.find(version => version.versionId === late)?.source, "inferred");
    const reaffirmed = await fx.round("explicit-reaffirm", child, correction);
    versions = await fx.versions();
    assert.equal(versions.find(version => version.versionId === reaffirmed)?.source, "user_explicit");
    assert.equal(recommendAutomaticWorkflow(versions, { ...task, conditions: { format: "json" } }).nomination?.versionId, reaffirmed);
  } finally { await fx.cleanup(); }
});

test("condition and family corrections remain independent, using the original omitted-when scope", async () => {
  const fx = await fixture();
  try {
    const csv = { ...task, conditions: { format: "csv" } }, json = { ...task, conditions: { format: "json" } };
    const base = await fx.round("base", undefined, undefined, [trace("csv", csv.conditions), trace("json", json.conditions)]);
    const csvCorrection = await fx.round("csv-correction", base, { nodeId: "verify", check: "node csv-v2.cjs", reason: "CSV contract" }, [], csv);
    const jsonCorrection = await fx.round("json-correction", base, { nodeId: "verify", check: "node json-v2.cjs", reason: "JSON contract", when: json.conditions });
    const inherited = await fx.round("different-child-conditions", csvCorrection, undefined, [], json);
    const other = { ...task, taskFamily: { ...task.taskFamily, id: "unrelated" } };

    await fx.round("other-family", undefined, undefined, [{ ...trace("other"), ...other }], other);
    const versions = await fx.versions();

    assert.equal(recommendAutomaticWorkflow(versions, csv).correctionVersionId, csvCorrection);
    assert.equal(recommendAutomaticWorkflow(versions, csv).nomination?.versionId, inherited, "the normalized descendant retains its original CSV correction");
    assert.equal(recommendAutomaticWorkflow(versions, json).nomination?.versionId, jsonCorrection);
    assert.notEqual(recommendAutomaticWorkflow(versions, json).correctionVersionId, inherited);
  } finally { await fx.cleanup(); }
});

test("a later different-node correction cannot discard an earlier contract; new compatible facts can restore adoption", async () => {
  const fx = await fixture();
  try {
    const base = await fx.round("base", undefined, undefined, [trace("seed")]);
    const build = await fx.round("build-fix", base, { nodeId: "build", check: "node build-v2.cjs", reason: "Correct build", when: { format: "json" } });
    const verify = await fx.round("verify-fix", build, { nodeId: "verify", check: "node verify-v2.cjs", recoveryTo: "build", reason: "Correct validation and recovery", when: { format: "json" } });
    const selectedTask = { ...task, conditions: { format: "json" } };
    const waiting = recommendAutomaticWorkflow(await fx.versions(), selectedTask);

    assert.equal(waiting.nomination, undefined);
    assert.equal(waiting.learningParent?.versionId, verify);
    const compatible = await fx.round("compatible-experience", verify, undefined, [trace("fixed", { format: "json" }, ["node build-v2.cjs", "node verify-v2.cjs"])]);

    assert.equal(recommendAutomaticWorkflow(await fx.versions(), selectedTask).nomination?.versionId, compatible);
  } finally { await fx.cleanup(); }
});

test("omitted correction conditions stay bound to their origin across a differently conditioned child, including legacy inheritance", async () => {
  const fx = await fixture();
  try {
    const csv = { ...task, conditions: { format: "csv" } }, json = { ...task, conditions: { format: "json" } };
    const base = await fx.round("base", undefined, undefined, [trace("csv", csv.conditions), trace("json", json.conditions)]);
    const correction = { nodeId: "verify", check: "node csv-v2.cjs", reason: "CSV contract only" };
    const corrected = await fx.round("csv-explicit", base, correction, [], csv);
    const child = await fx.round("json-child", corrected, undefined, [], json);
    const loaded = await readWorkflowVersion(fx.boardRoot, child);
    assert.ok(loaded.ok);
    const selected = selectWorkflowPath(loaded.value, json);
    assert.ok(selected.ok);
    assert.equal(selected.value.artifact.nodes[1]?.check, "node verify-v1.cjs", "a CSV correction must not become a JSON check");
    const explicit = await readWorkflowVersion(fx.boardRoot, corrected);
    assert.ok(explicit.ok);
    assert.deepEqual(explicit.value.correction?.when, csv.conditions);
    const original = await readWorkflowVersion(fx.boardRoot, base);
    assert.ok(original.ok);
    const legacy = learnWorkflow({ ...csv, requestId: "legacy-csv", subsystem: "workflow", collect: true, correction, parentVersionId: base,
      budget: { maxEpisodes: 16, maxSteps: 128, maxTokens: 32000 }, traces: original.value.traces });
    assert.ok(legacy.ok);
    const saved = await saveWorkflowVersion(fx.boardRoot, legacy.value, at);
    assert.ok(saved.ok);
    const bad = learnWorkflow({ ...json, requestId: "legacy-bad-json", subsystem: "workflow", collect: true, correction, parentVersionId: saved.value.versionId,
      budget: { maxEpisodes: 16, maxSteps: 128, maxTokens: 32000 }, traces: legacy.value.traces });
    assert.ok(bad.ok);
    const badSaved = await saveWorkflowVersion(fx.boardRoot, bad.value, at);
    assert.ok(badSaved.ok);
    const oldBytes = await readWorkflowVersion(fx.boardRoot, badSaved.value.versionId);
    assert.ok(oldBytes.ok);
    const safe = recommendAutomaticWorkflow(await fx.versions(), json);

    assert.notEqual(safe.nomination?.versionId, badSaved.value.versionId, "a preserved legacy child applied CSV correction outside its origin scope");
    assert.ok(safe.nomination);
    const safeJson = selectWorkflowPath(safe.nomination.artifact, json);
    assert.ok(safeJson.ok);
    assert.equal(safeJson.value.artifact.nodes[1]?.check, "node verify-v1.cjs");
    const inherited = await fx.round("legacy-json-child", badSaved.value.versionId, undefined, [], json);
    const latest = await readWorkflowVersion(fx.boardRoot, inherited);
    assert.ok(latest.ok);
    assert.deepEqual(latest.value.correction?.when, csv.conditions);
    const jsonPath = selectWorkflowPath(latest.value, json);
    assert.ok(jsonPath.ok);
    assert.equal(jsonPath.value.artifact.nodes[1]?.check, "node verify-v1.cjs");
    const recommended = recommendAutomaticWorkflow(await fx.versions(), csv);

    assert.equal(recommended.correctionVersionId, saved.value.versionId, "materialized inheritance does not become a new explicit intent");
    assert.deepEqual(await readWorkflowVersion(fx.boardRoot, badSaved.value.versionId), oldBytes, "legacy asset bytes are preserved");
  } finally { await fx.cleanup(); }
});
