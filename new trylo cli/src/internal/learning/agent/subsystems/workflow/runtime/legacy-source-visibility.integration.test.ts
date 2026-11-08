import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { WorkflowLearningResult, WorkflowTask, WorkflowTrace } from "../domain/trace-contracts.js";
import { runWorkflowLearning } from "./runtime.js";
import { listWorkflowVersions, readLegacyWorkflowCatalog, readWorkflowVersion, saveWorkflowVersion } from "./archive.js";
import { explicitWorkflowCorrections } from "./recommendation.js";
import { legacyWorkflowGuidance } from "./legacy-guidance.js";
import { workflowAssetVisibilityIndex } from "./asset-visibility.js";
import { createFileWorkflowImprovementRuntime } from "../adapters/improvement-composition.js";
import { readWorkflowImprovements } from "../adapters/improvement-board.js";
import { record } from "../domain/trace-parse.js";

const at = "2026-11-04T00:00:00.000Z";
const task: WorkflowTask = { scope: "repo:legacy-source", taskFamily: { id: "report", intentClass: "compile", checkKind: "acceptance" }, conditions: { format: "csv" } };
const oldCheck = "node old-explicit-check.cjs", privateCheck = "node withdrawn-private-check.cjs";

function value<T>(result: WorkflowLearningResult<T>): T {
  if (!result.ok) assert.fail(result.code);
  return result.value;
}

async function fixture() {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-source-visibility-"));
  const trace: WorkflowTrace = { ...task, schemaVersion: 1, traceId: "seed", source: "imported", outcome: "success",
    conditionEvidenceRefs: ["seed:format"], steps: [
      { nodeId: "build", input: "source", output: "artifact", dependsOn: [], check: "node build.cjs", status: "passed", evidenceRefs: ["seed:build"] },
      { nodeId: "verify", input: "artifact", output: "report", dependsOn: ["build"], check: "node verify.cjs", status: "passed", evidenceRefs: ["seed:verify"] },
    ] };
  const round = async (requestId: string, parentVersionId?: string, check?: string) => value(await runWorkflowLearning({ boardRoot, issuedAt: at,
    request: { ...task, requestId, subsystem: "workflow", collect: true, budget: { maxEpisodes: 16, maxSteps: 128, maxTokens: 32000 },
      traces: parentVersionId === undefined ? [trace] : [], ...(parentVersionId === undefined ? {} : { parentVersionId }),
      ...(check === undefined ? {} : { correction: { nodeId: "verify", check, recoveryTo: "build", reason: "Explicit owner requirement", when: task.conditions } }) } })).versionId;
  const base = await round("base"), old = await round("old-explicit", base, oldCheck), latest = await round("new-explicit", base, privateCheck);
  const inheritedOld = await round("late-old-inheritance", old), inheritedLatest = await round("latest-inheritance", latest);
  const apply = async (command: BoardCommand) => {
    const result = await withBoardWriter(boardRoot, store => store.apply(command));
    assert.ok(result.ok, JSON.stringify(result));
  };

  return { boardRoot, base, old, latest, inheritedOld, inheritedLatest, round, apply, cleanup: () => rm(boardRoot, { recursive: true, force: true }) };
}

test("latest withdrawn explicit origin shadows older corrections without promoting an inferred child", async () => {
  const fx = await fixture();
  try {
    await fx.apply({ type: "reject", commandId: "reject-latest", issuedAt: at, proposalId: `proposal_${fx.latest}`, reason: "Withdraw this experimental correction" });
    const catalog = value(await readLegacyWorkflowCatalog(fx.boardRoot));

    assert.equal(catalog.versions.find(item => item.versionId === fx.latest)?.visibility, "blocked");
    assert.equal(catalog.versions.find(item => item.versionId === fx.inheritedLatest)?.visibility, "blocked");
    assert.equal(catalog.providerVersions.some(item => item.versionId === fx.latest || item.versionId === fx.inheritedLatest), false);
    assert.ok(value(await listWorkflowVersions(fx.boardRoot)).some(item => item.versionId === fx.latest), "blocked history remains locally readable");
    const corrections = explicitWorkflowCorrections(catalog.versions, task.scope);

    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]?.sourceVersionId, fx.latest);
    assert.equal(corrections[0]?.visibility, "blocked");
    assert.equal(corrections[0]?.correction.check, privateCheck);
    assert.ok(corrections.every(item => item.sourceVersionId !== fx.inheritedOld && item.sourceVersionId !== fx.inheritedLatest));
    const guidance = legacyWorkflowGuidance({ kind: "reference", hostTask: task, corrections });

    assert.equal(guidance.evidence.length, 0);
    assert.equal(guidance.prompt.includes(privateCheck), false);
    assert.equal(guidance.prompt.includes(oldCheck), false);
    assert.equal(guidance.dispatchPolicy().value.kind, "allowed", "withdrawn intent neither revives old authority nor prevents a fresh repair");
  } finally { await fx.cleanup(); }
});

test("forgotten parents and inherited children stay only in local origin history and never provider context", async () => {
  const fx = await fixture();
  try {
    const saved = value(await readWorkflowVersion(fx.boardRoot, fx.latest));
    const before = await createBoardReader(fx.boardRoot).load();
    assert.ok(before.ok);
    const savedHash = before.state.assets.find(item => item.versionId === fx.latest)?.contentHash;
    assert.ok(savedHash);
    await fx.apply({ type: "tombstone", commandId: "forget-origin", issuedAt: at, entityType: "asset", entityId: fx.latest, reason: "Forget this source" });
    const catalog = value(await readLegacyWorkflowCatalog(fx.boardRoot));

    for (const id of [fx.latest, fx.inheritedLatest]) {
      assert.equal(catalog.versions.find(item => item.versionId === id)?.visibility, "forgotten");
      assert.equal(catalog.providerVersions.some(item => item.versionId === id), false);
      assert.equal(value(await listWorkflowVersions(fx.boardRoot)).some(item => item.versionId === id), false);
      const found = await readWorkflowVersion(fx.boardRoot, id);
      assert.equal(found.ok, false);
      if (!found.ok) {
        assert.equal(found.code, "workflow_forgotten");
        assert.equal(found.message.includes(privateCheck), false);
      }
    }

    const corrections = explicitWorkflowCorrections(catalog.versions, task.scope);

    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]?.sourceVersionId, fx.latest);
    assert.equal(corrections[0]?.visibility, "forgotten");
    const guidance = legacyWorkflowGuidance({ kind: "reference", hostTask: task, corrections });

    assert.equal(guidance.prompt.includes(privateCheck), false);
    assert.equal(guidance.prompt.includes(oldCheck), false);
    assert.equal(JSON.stringify(guidance.evidence).includes(privateCheck), false);
    assert.equal(guidance.dispatchPolicy().value.kind, "allowed", "a forgotten source is omitted rather than made a permanent task barrier");
    const duplicate = await saveWorkflowVersion(fx.boardRoot, saved, at, "user_explicit");
    assert.equal(duplicate.ok, false);
    const loaded = await createBoardReader(fx.boardRoot).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.assets.find(item => item.versionId === fx.latest)?.contentHash, savedHash,
      "forgetting preserves immutable retained audit bytes");
  } finally { await fx.cleanup(); }
});

test("unknown explicit owning metadata defers adoption using a static notice without disclosing its correction", async () => {
  const fx = await fixture();
  try {
    const catalog = value(await readLegacyWorkflowCatalog(fx.boardRoot));
    const unknownHistory = catalog.versions.map(item => item.versionId === fx.latest ? { ...item, visibility: "unknown" as const } : item);
    const corrections = explicitWorkflowCorrections(unknownHistory, task.scope);

    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]?.visibility, "unknown");
    const guidance = legacyWorkflowGuidance({ kind: "reference", hostTask: task, corrections,
      reference: { ...catalog.versions.find(item => item.versionId === fx.latest)!, visibility: "unknown" } });

    assert.equal(guidance.evidence.length, 0);

    for (const text of [privateCheck, oldCheck, '"format":"csv"', '"id":"report"']) assert.equal(guidance.prompt.includes(text), false);

    const policy = guidance.dispatchPolicy().value;
    assert.equal(policy.kind, "deferred");

    if (policy.kind === "deferred") assert.equal(policy.reason, "legacy_workflow_source_unknown");
  } finally { await fx.cleanup(); }
});

test("a new real explicit correction can repair a blocked parent but cannot wash out a privacy tombstone", async () => {
  const fx = await fixture();
  try {
    await fx.apply({ type: "reject", commandId: "reject-for-repair", issuedAt: at, proposalId: `proposal_${fx.latest}`, reason: "Trial was unsuitable" });
    const repaired = await fx.round("new-explicit-repair", fx.latest, "node repaired-explicit-check.cjs");
    let catalog = value(await readLegacyWorkflowCatalog(fx.boardRoot));

    assert.equal(catalog.versions.find(item => item.versionId === fx.latest)?.visibility, "blocked");
    const own = catalog.versions.find(item => item.versionId === repaired);
    assert.ok(own);
    assert.equal(own.source, "user_explicit");
    assert.equal(own.visibility, "available");
    assert.ok(catalog.providerVersions.some(item => item.versionId === repaired));
    assert.equal(explicitWorkflowCorrections(catalog.versions, task.scope)[0]?.sourceVersionId, repaired);
    await fx.apply({ type: "tombstone", commandId: "forget-repair-parent", issuedAt: at, entityType: "asset", entityId: fx.latest, reason: "Forget original facts" });
    catalog = value(await readLegacyWorkflowCatalog(fx.boardRoot));
    assert.equal(catalog.versions.find(item => item.versionId === repaired)?.visibility, "forgotten");
    assert.equal(catalog.providerVersions.some(item => item.versionId === repaired), false);
    const found = await readWorkflowVersion(fx.boardRoot, repaired);
    assert.equal(found.ok, false);

    if (!found.ok) assert.equal(found.code, "workflow_forgotten");
  } finally { await fx.cleanup(); }
});

test("cached effective legacy sources are revoked at the next real handoff and omitted from runtime inventory", async () => {
  for (const action of ["reject", "tombstone"] as const) {
    const fx = await fixture();
    let runtime: ReturnType<typeof createFileWorkflowImprovementRuntime> | undefined;

    try {
      const catalog = value(await readLegacyWorkflowCatalog(fx.boardRoot));
      const reference = catalog.providerVersions.find(item => item.versionId === fx.latest);
      assert.ok(reference);
      const guidance = legacyWorkflowGuidance({ kind: "reference", hostTask: task,
        corrections: explicitWorkflowCorrections(catalog.versions, task.scope), reference });
      const initial = await createBoardReader(fx.boardRoot).load();
      assert.ok(initial.ok);
      assert.equal(guidance.dispatchPolicy(task, Object.fromEntries(workflowAssetVisibilityIndex(initial.state))).value.kind, "allowed");
      runtime = createFileWorkflowImprovementRuntime({ boardRoot: fx.boardRoot, scope: task.scope,
        sessionId: `session:revocation:${action}`, budgetId: `budget:revocation:${action}`, allowance: 0, now: () => Date.parse(at),
        publicData: () => true, warn: () => assert.fail("context-only revocation must not start a worker"),
        hostEvidence: guidance.evidence, dispatchPolicy: guidance.dispatchPolicy,
        readEvidence: async () => ({ ok: true, value: { evidence: [], receipts: [], watermark: 0, executionId: `session:revocation:${action}/turn:1` } }),
        newModel: () => assert.fail("no provider is involved in a source revocation") });
      const before = value(await runtime.context("before-revocation", {}));

      assert.ok(JSON.stringify(before).includes(privateCheck), "the effective source was present before withdrawal");
      await fx.apply(action === "reject" ? { type: "reject", commandId: `revoke:${action}`, issuedAt: at,
        proposalId: `proposal_${fx.latest}`, reason: "Withdraw frozen source" }
        : { type: "tombstone", commandId: `revoke:${action}`, issuedAt: at, entityType: "asset", entityId: fx.latest, reason: "Forget frozen source" });
      const current = await createBoardReader(fx.boardRoot).load();
      assert.ok(current.ok);
      const policy = guidance.dispatchPolicy(task, Object.fromEntries(workflowAssetVisibilityIndex(current.state))).value;

      assert.equal(policy.kind, "deferred");

      if (policy.kind === "deferred") {
        assert.equal(policy.reason, "legacy_workflow_source_revoked");
        assert.equal("guidance" in policy, false);
      }

      const inventory = value(await runtime.context("after-revocation", {}));

      assert.equal(JSON.stringify(inventory).includes(privateCheck), false);
      assert.equal(JSON.stringify(inventory).includes(`legacy-correction:${fx.latest}`), false);
      const adopted = value(await runtime.context("handoff-after-revocation", { task, boundary: "next-phase" }));

      assert.ok(record(adopted));
      assert.equal(adopted.status, "handoff_deferred");
      assert.equal(adopted.reason, "legacy_workflow_source_revoked");
      assert.equal("guidance" in adopted, false);
      assert.equal(value(await readWorkflowImprovements(fx.boardRoot, task.scope)).uses.length, 0);
    } finally {
      await runtime?.close();
      await fx.cleanup();
    }
  }
});
