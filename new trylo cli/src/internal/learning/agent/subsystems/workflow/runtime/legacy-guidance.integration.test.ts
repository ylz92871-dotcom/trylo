import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFileWorkflowImprovementRuntime } from "../adapters/improvement-composition.js";
import { readWorkflowImprovements } from "../adapters/improvement-board.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import type { WorkflowImprovementModelPort, WorkflowProcessTask } from "../improvement/contracts.js";
import type { WorkflowLearningResult, WorkflowTask, WorkflowTrace } from "../domain/trace-contracts.js";
import { learnWorkflow } from "../domain/trace-learn.js";
import { record } from "../domain/trace-parse.js";
import { runWorkflowLearning } from "./runtime.js";
import { listWorkflowVersions, saveWorkflowVersion } from "./archive.js";
import { explicitWorkflowCorrections } from "./recommendation.js";
import { legacyWorkflowGuidance, type LegacyWorkflowContext } from "./legacy-guidance.js";

const at = "2026-11-04T00:00:00.000Z";
const exactCheck = "node verify-owner-and-source-digest.cjs";

function value<T>(result: WorkflowLearningResult<T>): T {
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.value;
}

async function mixedBoard() {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-legacy-guidance-"));
  const source = searchImprovementFixture();
  const conditions = { ...source.opportunity.task.conditions, format: "csv" };
  const task: WorkflowProcessTask = { ...source.opportunity.task, conditions };
  const legacyTask: WorkflowTask = { scope: task.scope, taskFamily: task.taskFamily, conditions };
  const trace = (id: string, format: string): WorkflowTrace => ({ ...legacyTask, conditions: { ...task.conditions, format },
    schemaVersion: 1, traceId: id, source: "imported", outcome: "success", conditionEvidenceRefs: [`${id}:input`], steps: [
      { nodeId: "prepare", input: "source", output: "rows", dependsOn: [], check: "node check-rows.cjs", status: "passed", evidenceRefs: [`${id}:prepare`] },
      { nodeId: "verify", input: "rows", output: "report", dependsOn: ["prepare"], check: "node verify-old.cjs", status: "passed", evidenceRefs: [`${id}:verify`] },
    ] });
  const budget = { maxEpisodes: 16, maxSteps: 128, maxTokens: 32000 };
  const base = value(await runWorkflowLearning({ boardRoot, issuedAt: at, request: { ...legacyTask, requestId: "legacy-base",
    subsystem: "workflow", collect: true, budget, traces: [trace("csv-original", "csv"), trace("json-original", "json")] } })).versionId;
  const correction = { nodeId: "verify", check: exactCheck, recoveryTo: "prepare", reason: "CSV requires owner and source digest.", when: { format: "csv" } };
  const corrected = value(await runWorkflowLearning({ boardRoot, issuedAt: at, request: { ...legacyTask,
    requestId: "legacy-user-correction", subsystem: "workflow", collect: true, budget, traces: [], parentVersionId: base, correction } })).versionId;
  const child = value(await runWorkflowLearning({ boardRoot, issuedAt: at, request: { ...legacyTask,
    requestId: "legacy-inferred-child", subsystem: "workflow", collect: true, budget, traces: [], parentVersionId: corrected } })).versionId;
  const versions = value(await listWorkflowVersions(boardRoot));
  const corrections = explicitWorkflowCorrections(versions, task.scope);
  const reference = versions.find(item => item.versionId === child);

  assert.ok(reference);
  const proposal = { ...source.proposal, procedure: { ...source.proposal.procedure, requiredConditions: { ...task.conditions } } };

  return { boardRoot, task, legacyTask, trace, budget, base, corrected, child, correction, versions, corrections, reference,
    evidence: source.evidence, opportunity: { ...source.opportunity, task }, proposal,
    cleanup: () => rm(boardRoot, { recursive: true, force: true }) };
}

function runtimeFor(fx: Awaited<ReturnType<typeof mixedBoard>>, context: LegacyWorkflowContext, budgetId: string) {
  const guidance = legacyWorkflowGuidance(context);
  const warnings: string[] = [];
  let calls = 0;
  const runtime = createFileWorkflowImprovementRuntime({ boardRoot: fx.boardRoot, scope: fx.task.scope,
    sessionId: "session:mixed", budgetId, allowance: 16000, now: () => Date.parse(at),
    publicData: () => true, warn: code => warnings.push(code), hostEvidence: guidance.evidence, dispatchPolicy: guidance.dispatchPolicy,
    readEvidence: async () => ({ ok: true, value: { evidence: fx.evidence, receipts: [], watermark: 10,
      executionId: "session:mixed/turn:new" } }),
    newModel: (): WorkflowImprovementModelPort => {
      let modelCalls = 0;
      return { async propose(input) {
        modelCalls += 1;
        calls += 1;
        assert.ok(input.evidence.some(item => item.ref === `legacy-correction:${fx.corrected}`));
        return { ok: true, value: fx.proposal };
      }, usage: () => ({ calls: modelCalls, tokens: modelCalls * 100, observedTokens: modelCalls * 100, uncertain: false }) };
    } });

  return { runtime, guidance, warnings, calls: () => calls };
}

async function seedImprovement(fx: Awaited<ReturnType<typeof mixedBoard>>) {
  const host = runtimeFor(fx, { kind: "reference", hostTask: fx.legacyTask, corrections: fx.corrections, reference: fx.reference }, "mixed:research");
  const nominated = await host.runtime.opportunity("nominate", { ...fx.opportunity,
    evidenceRefs: [...fx.opportunity.evidenceRefs, ...host.guidance.evidence.map(item => item.ref)] });

  assert.ok(nominated.ok);
  await host.runtime.settlePending();
  assert.equal(host.calls(), 1);
  assert.deepEqual(host.warnings, []);
  const view = value(await readWorkflowImprovements(fx.boardRoot, fx.task.scope));

  assert.equal(view.versions.length, 1);
  assert.equal(view.versions[0]?.status, "eligible");

  return { ...host, version: view.versions[0]! };
}

test("a mixed Board preserves explicit legacy constraints while the new proposal changes steps and branches", async () => {
  const fx = await mixedBoard();
  let runtime: ReturnType<typeof runtimeFor>["runtime"] | undefined;

  try {
    const before = await createBoardReader(fx.boardRoot).load();
    assert.ok(before.ok);
    const oldHashes = new Map(before.state.assets.map(item => [item.versionId, item.contentHash]));
    const seeded = await seedImprovement(fx);
    runtime = seeded.runtime;
    const steps = seeded.version.artifact.proposal.procedure.steps;

    assert.deepEqual(steps.map(item => item.id), ["confirm-owner", "scoped-search"]);
    assert.equal(steps[1]?.when?.fact, "owner_confirmed");
    assert.ok(steps.every(item => item.id !== "prepare" && item.id !== "verify"));
    const adopted = value(await runtime.context("handoff", { task: fx.task, boundary: "owner-discovery-complete" }));

    assert.ok(record(adopted));
    assert.equal(adopted.status, "frozen");
    assert.equal(typeof adopted.guidance, "string");
    const text = String(adopted.guidance);

    assert.ok(text.includes(exactCheck));
    assert.ok(text.includes(fx.corrected));
    assert.match(text, /"recoveryTo":"prepare"/);
    assert.match(text, /"when":\{"format":"csv"\}/);
    assert.match(text, /confirm-owner/);
    assert.match(text, /owner_confirmed/);
    const after = await createBoardReader(fx.boardRoot).load();
    assert.ok(after.ok);

    for (const [id, hash] of oldHashes) assert.equal(after.state.assets.find(item => item.versionId === id)?.contentHash, hash);

    const view = value(await readWorkflowImprovements(fx.boardRoot, fx.task.scope));

    assert.equal(view.uses.length, 1);
    assert.equal(value(await listWorkflowVersions(fx.boardRoot)).length, fx.versions.length);
  } finally {
    await runtime?.close();
    await fx.cleanup();
  }
});

test("a pinned legacy instance defers new guidance without writing a new use", async () => {
  const fx = await mixedBoard();
  let research: ReturnType<typeof runtimeFor>["runtime"] | undefined, pinned: ReturnType<typeof runtimeFor>["runtime"] | undefined;

  try {
    const seeded = await seedImprovement(fx);
    research = seeded.runtime;
    const host = runtimeFor(fx, { kind: "pinned", versionId: fx.child, hostTask: fx.legacyTask,
      corrections: fx.corrections, reference: fx.reference }, "mixed:pinned");

    pinned = host.runtime;
    const adopted = value(await pinned.context("pinned-handoff", { task: fx.task, boundary: "still-running-instance" }));

    assert.ok(record(adopted));
    assert.equal(adopted.status, "handoff_deferred");
    assert.equal(adopted.reason, "legacy_workflow_pinned");
    assert.equal(adopted.pinnedVersionId, fx.child);
    assert.equal(value(await readWorkflowImprovements(fx.boardRoot, fx.task.scope)).uses.length, 0);
    assert.equal(host.calls(), 0);
  } finally {
    await pinned?.close();
    await research?.close();
    await fx.cleanup();
  }
});

test("model-supplied families or omitted conditions cannot bypass unknown frozen host applicability", async () => {
  const fx = await mixedBoard();
  let research: ReturnType<typeof runtimeFor>["runtime"] | undefined;
  const hosts: ReturnType<typeof runtimeFor>[] = [];

  try {
    const seeded = await seedImprovement(fx);
    research = seeded.runtime;
    const missingWhen = { ...fx.legacyTask, conditions: { repoLayout: "monorepo-v1", evidenceMode: "read_only" } };
    const contexts: LegacyWorkflowContext[] = [
      { kind: "reference", hostTask: missingWhen, corrections: fx.corrections, reference: fx.reference },
      { kind: "reference", corrections: fx.corrections, reference: fx.reference },
    ];

    for (const [index, context] of contexts.entries()) {
      const host = runtimeFor(fx, context, `mixed:unknown:${index}`);
      hosts.push(host);
      const rawTask = index === 0 ? { ...fx.task, taskFamily: { ...fx.task.taskFamily, id: "model-renamed-family" } }
        : { ...fx.task, conditions: missingWhen.conditions };
      const adopted = value(await host.runtime.context(`attempt:${index}`, { task: rawTask, boundary: "model-relabelled" }));

      assert.ok(record(adopted));
      assert.equal(adopted.status, "handoff_deferred");
      assert.equal(adopted.reason, "legacy_workflow_premises_unknown");
      assert.equal(host.calls(), 0);
    }

    const known = runtimeFor(fx, { kind: "reference", hostTask: fx.legacyTask, corrections: fx.corrections,
      reference: fx.reference }, "mixed:known-host");
    hosts.push(known);
    const omitted = value(await known.runtime.context("omit-when", { task: { ...fx.task, conditions: missingWhen.conditions }, boundary: "missing-premise" }));

    assert.ok(record(omitted));
    assert.equal(omitted.status, "not_applicable");
    assert.equal(value(await readWorkflowImprovements(fx.boardRoot, fx.task.scope)).uses.length, 0);
  } finally {
    for (const host of hosts) await host.runtime.close();
    await research?.close();
    await fx.cleanup();
  }
});

test("inferred descendants and inferred-only corrections never acquire explicit-origin authority", async () => {
  const fx = await mixedBoard();
  try {
    const inferredArtifact = value(learnWorkflow({ ...fx.legacyTask, requestId: "inferred-only-apparent-correction", subsystem: "workflow", collect: true,
      budget: fx.budget, traces: [fx.trace("inferred-seed", "csv")], parentVersionId: fx.base,
      correction: { ...fx.correction, check: "node model-inferred-check.cjs", reason: "An inferred proposal, not a user statement." } }));
    const inferredId = value(await saveWorkflowVersion(fx.boardRoot, inferredArtifact, at, "inferred")).versionId;
    const versions = value(await listWorkflowVersions(fx.boardRoot));

    assert.equal(versions.find(item => item.versionId === fx.child)?.source, "inferred");
    assert.equal(versions.find(item => item.versionId === inferredId)?.source, "inferred");
    const explicit = explicitWorkflowCorrections(versions, fx.task.scope);

    assert.deepEqual(explicit.map(item => item.sourceVersionId), [fx.corrected]);
    assert.equal(explicit[0]?.correction.check, exactCheck);
    const guidance = legacyWorkflowGuidance({ kind: "reference", hostTask: fx.legacyTask, corrections: explicit });

    assert.ok(guidance.prompt.includes(fx.corrected));
    assert.equal(guidance.prompt.includes(inferredId), false);
    assert.equal(guidance.prompt.includes("node model-inferred-check.cjs"), false);
    assert.equal(guidance.evidence[0]?.sourceVersionId, fx.corrected);
    assert.equal(explicitWorkflowCorrections(versions, "repo:other-workspace").length, 0);
  } finally { await fx.cleanup(); }
});
