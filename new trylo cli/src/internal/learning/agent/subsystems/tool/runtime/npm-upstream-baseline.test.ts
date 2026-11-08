import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { createNpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { toolProductionVersion } from "../domain/evolution/production-plan.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { prepareNpmUpstreamBaseline } from "./npm-upstream-baseline.js";
import { saveToolProductionPlan } from "./production-assets.js";
import { proposeToolContractRevision, reviewToolContractRevision, approveToolContractRevision } from "./contract-revisions.js";
import type { ToolContractRevisionProposal } from "../domain/evolution/contract-revision.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { npmMayReuseImplementation } from "./npm-baseline-candidate.js";

async function fixture(t: TestContext, options: { readonly badOracle?: boolean } = {}) {
  const base = testScratchPath("npm-upstream-baseline-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = npmTreeTestData(), scope = data.plan.tree.scope, boardRoot = path.join(root, "board"), jobId = "tool-adaptation_v1_" + "a".repeat(64);
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "test-new-frozen-contract", scope, capability: "TEST ONLY",
    operation: "create", evidence: [
      { sampleId: "s1", role: "source", input: { value: 1 }, expected: { kind: "value", value: options.badOracle ? 999 : 1 } },
      { sampleId: "s2", role: "source", input: { value: 2 }, expected: { kind: "value", value: 2 } },
      { sampleId: "v", role: "variation", input: { PRIVATE_HELDOUT: 3 }, expected: { kind: "value", value: 3 } },
      { sampleId: "c", role: "counterexample", input: { PRIVATE_HELDOUT: null }, expected: { kind: "error", code: "bad" } },
    ] };
  const parent = createNpmToolProductionPlan({ workspaceId: "test-workspace", installation: data.plan, checks,
    descriptor: { identity: "stable-tool", description: "TEST ONLY", inputSchema: { type: "object" }, mastery: { whenToUse: ["TEST ONLY baseline reuse"], preconditions: [], pitfalls: [] } },
    runtime: { profile: "confined_npm_library_v1", source: "module.exports=input=>input.value;" },
    patches: [{ path: `${data.plan.tree.root.location}/cli.cjs`, oldSha256: "b".repeat(64), source: "module.exports=()=>1;" }] });
  assert.ok(parent);
  const installation = { ...data.plan, lock: { ...data.plan.lock, testOnlyNewUpstream: true } };
  const savedParent = await saveToolProductionPlan(boardRoot, parent, new Date(0).toISOString());
  assert.ok(savedParent.ok);
  const owned = await withBoardWriter(boardRoot, async store => {
    const queued = await store.apply({ type: "enqueue_job", commandId: "enqueue", issuedAt: new Date(0).toISOString(),
      job: { jobId, domain: "tool", scope, observationId: "test-upstream", dedupeKey: jobId, maxAttempts: 3 } });
    assert.ok(queued.ok);
    const started = await store.apply({ type: "start_job", commandId: "start", issuedAt: new Date(0).toISOString(), jobId });
    assert.ok(started.ok);
  });
  assert.equal(owned, undefined);
  const input: NpmAdaptationInput = { boardRoot, workspaceId: parent.workspaceId, installation, installationRoot: "unused",
    plan: { type: "tool_learning_plan", schemaVersion: 1, scope, capability: checks.capability, createdAt: new Date(0).toISOString(),
      trigger: { action: "user_requested", runId: "test", proposalKey: "test", evidenceRefs: [] }, targetVersionId: toolProductionVersion(parent) },
    adaptation: "TEST ONLY clean upstream baseline", admission: { jobId, attempt: 1 }, parent: { versionId: toolProductionVersion(parent), plan: parent, feedback: "TEST ONLY" },
    acquisition: { jobId: "tool-learning_v1_" + "c".repeat(64), decisionVersionId: "tool-decision_v1_" + "d".repeat(64) },
    services: { allowance: async () => undefined, complete: async () => { assert.fail("baseline spends no model calls"); } },
    signal: new AbortController().signal, now: () => 0 };

  return { input, checks, root };
}

test("a blocked clean baseline runs once per claim and can retry after an explicit new claim", async t => {
  const { input, checks } = await fixture(t);
  let calls = 0;
  const services = { ...input.services, execute: async () => {
    calls++;
    return { kind: "unavailable" as const, detail: "TEST ONLY" };
  } };
  const first = await prepareNpmUpstreamBaseline({ ...input, services }, checks);

  assert.ok("kind" in first && first.kind === "diagnostic");
  assert.equal(first.feedback.check.kind, "blocked");
  assert.equal(calls, 1);
  await withBoardWriter(input.boardRoot, async store => {
    const base = { issuedAt: new Date(1).toISOString(), jobId: input.admission.jobId };
    assert.ok((await store.apply({ ...base, type: "complete_job", commandId: "wait", next: "waiting_evidence" })).ok);
    assert.ok((await store.apply({ ...base, type: "requeue_job", commandId: "requeue", expectedAttempt: 1 })).ok);
    assert.ok((await store.apply({ ...base, type: "start_job", commandId: "restart" })).ok);
  });
  const again = await prepareNpmUpstreamBaseline({ ...input, admission: { ...input.admission, attempt: 2 }, services }, checks);

  assert.ok("kind" in again && again.kind === "diagnostic");
  assert.equal(calls, 2);
  const sameClaim = await prepareNpmUpstreamBaseline({ ...input, admission: { ...input.admission, attempt: 2 }, services }, checks);

  assert.ok("kind" in sameClaim && sameClaim.kind === "diagnostic");
  assert.equal(calls, 2);
});

test("clean baseline drops old patches, uses new frozen source cases and leaves all held-out answers untouched", async t => {
  const { input, checks } = await fixture(t), calls: unknown[] = [];
  const result = await prepareNpmUpstreamBaseline({ ...input, services: { ...input.services, execute: async (plan, value) => {
    assert.equal(plan.patches, undefined);
    assert.equal(contentHashOf(plan.checks), contentHashOf(checks));
    assert.equal(contentHashOf(plan.installation), contentHashOf(input.installation));
    calls.push(value);
    assert.equal(plan.evolution?.requestId, `${input.admission.jobId}:1`);
    return { kind: "value", value: 999 };
  } } }, checks);

  assert.ok("kind" in result && result.kind === "diagnostic");
  assert.equal(result.feedback.check.kind, "failed");
  assert.deepEqual(calls, [{ value: 1 }]);
  assert.equal(JSON.stringify(result).includes("PRIVATE_HELDOUT"), false);
});

async function correctedFixture(t: TestContext) {
  const fx = await fixture(t, { badOracle: true }), parent = fx.input.parent!;
  const old = parent.plan.checks.evidence[0]!, expected = { kind: "value" as const, value: 1 };
  const proposal: ToolContractRevisionProposal = { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId: parent.versionId,
    parentContractHash: contentHashOf(parent.plan.checks.evidence), scope: fx.input.plan.scope, reason: "incorrect_expectation",
    corrections: [{ sampleId: old.sampleId, oldSampleHash: contentHashOf(old), oldExpectedHash: contentHashOf(old.expected), expected,
      evidenceRefs: ["TEST_ONLY_explicit_user_oracle_correction"] }] };
  const proposed = await proposeToolContractRevision(fx.input.boardRoot, proposal, new Date(0).toISOString());
  assert.ok(proposed.ok);
  const review = await reviewToolContractRevision(fx.input.boardRoot, proposed.proposalId, fx.input.plan.scope);
  assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "TEST_ONLY_permissions.ndjson") });
  const grant = await permission.issue({ action: "modify", candidateId: review.reviewId, packageVersionId: parent.versionId, scope: fx.input.plan.scope,
    issuedAt: new Date(0).toISOString(), expiry: new Date(60_000).toISOString() });
  assert.ok(grant.ok);
  const approved = await approveToolContractRevision({ boardRoot: fx.input.boardRoot, proposalId: proposed.proposalId, scope: fx.input.plan.scope,
    reviewId: review.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt: new Date(0).toISOString() });
  assert.ok(approved.ok);
  const checks: ToolEvolutionRequest = { ...fx.checks, requestId: "TEST_ONLY_corrected_contract", contractRevisionRefs: [approved.revisionId],
    evidence: fx.checks.evidence.map(sample => sample.sampleId === old.sampleId ? { ...sample, expected } : sample) };
  const { acquisition: _acquisition, ...input } = fx.input;

  return { ...fx, input: { ...input, installation: parent.plan.installation }, checks, revisionId: approved.revisionId };
}

test("an approved oracle correction reuses the exact adapter and patches with zero source-generation calls", async t => {
  const { input, checks, revisionId } = await correctedFixture(t), calls: unknown[] = [];

  assert.equal(npmMayReuseImplementation({ ...input, services: { ...input.services, execute: async () => ({ kind: "unavailable", detail: "TEST ONLY" }) } }, [revisionId]), true);
  const result = await prepareNpmUpstreamBaseline({ ...input, services: { ...input.services, execute: async (candidate, value) => {
    assert.deepEqual(candidate.runtime, input.parent!.plan.runtime);
    assert.deepEqual(candidate.patches, input.parent!.plan.patches);
    assert.equal(candidate.evolution?.requestId, `${input.admission.jobId}:1`);
    calls.push(value);
    return { kind: "value", value: (value as { readonly value: number }).value };
  } } }, checks);

  assert.ok("kind" in result && result.kind === "prepared");
  assert.deepEqual(calls, [{ value: 1 }, { value: 2 }]);
  const loaded = await createBoardReader(input.boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.activations.length, 0);
  assert.equal(loaded.state.evidence.length, 0, "source baseline never supplies production verification");
});

test("ordinary same-install feedback and unapproved oracle edits cannot bypass source construction", async t => {
  const { input, checks } = await fixture(t);
  let calls = 0;
  const { acquisition: _acquisition, ...same } = input;
  const current = { ...same, installation: input.parent!.plan.installation, services: { ...input.services,
    execute: async () => {
      calls++;
      return { kind: "value" as const, value: 1 };
    } } };

  assert.deepEqual(await prepareNpmUpstreamBaseline(current, checks), { kind: "not_applicable" });
  const proposed = await prepareNpmUpstreamBaseline(current, { ...checks, contractRevisionRefs: [`tool-contract-revision_v1_${"e".repeat(64)}`] });

  assert.ok("ok" in proposed && !proposed.ok);
  assert.equal(proposed.code, "contract_revision_not_approved");
  assert.equal(calls, 0);
});

test("failed correction baselines survive attempt trace changes while temporary blockers may be retried", async t => {
  const { input, checks } = await correctedFixture(t);
  let calls = 0;
  const services = { ...input.services, execute: async () => {
    calls++;
    return { kind: "value" as const, value: 999 };
  } };
  const first = await prepareNpmUpstreamBaseline({ ...input, services }, checks);
  assert.ok("kind" in first && first.kind === "diagnostic");
  assert.equal(first.feedback.strategy, "contract_correction");
  assert.equal(first.feedback.check.kind, "failed");
  assert.equal(calls, 1);
  await withBoardWriter(input.boardRoot, async store => {
    const base = { issuedAt: new Date(1).toISOString(), jobId: input.admission.jobId };
    assert.ok((await store.apply({ ...base, type: "complete_job", commandId: "correction-wait", next: "waiting_evidence" })).ok);
    assert.ok((await store.apply({ ...base, type: "requeue_job", commandId: "correction-requeue", expectedAttempt: 1 })).ok);
    assert.ok((await store.apply({ ...base, type: "start_job", commandId: "correction-restart" })).ok);
  });
  const second = await prepareNpmUpstreamBaseline({ ...input, admission: { ...input.admission, attempt: 2 }, services }, checks);

  assert.ok("kind" in second && second.kind === "diagnostic");
  assert.equal(second.feedback.check.kind, "failed");
  assert.equal(calls, 1);
});

test("matching source examples cannot bypass missing acquisition lineage or run held-out cases", async t => {
  const { input, checks } = await fixture(t), calls: unknown[] = [];
  const services: NpmAdaptationInput["services"] = { ...input.services, execute: async (_plan, value) => {
    calls.push(value);
    return { kind: "value", value: calls.length };
  } };
  const result = await prepareNpmUpstreamBaseline({ ...input, services }, checks);

  assert.ok("ok" in result && !result.ok);
  assert.equal(result.code, "invalid_production_origin");
  assert.deepEqual(calls, [{ value: 1 }, { value: 2 }]);
  await withBoardWriter(input.boardRoot, async store => {
    const base = { issuedAt: new Date(1).toISOString(), jobId: input.admission.jobId };
    assert.ok((await store.apply({ ...base, type: "complete_job", commandId: "passed-wait", next: "waiting_evidence" })).ok);
    assert.ok((await store.apply({ ...base, type: "requeue_job", commandId: "passed-requeue", expectedAttempt: 1 })).ok);
    assert.ok((await store.apply({ ...base, type: "start_job", commandId: "passed-restart" })).ok);
  });
  const again = await prepareNpmUpstreamBaseline({ ...input, admission: { ...input.admission, attempt: 2 }, services }, checks);

  assert.ok("ok" in again && !again.ok);
  assert.equal(again.code, "invalid_production_origin");
  assert.equal(calls.length, 2, "a passed cache survives trace changes, but never supplies missing acquisition authority");
});
