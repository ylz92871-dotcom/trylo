import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createLearningAllocationApplication } from "../learning-allocation/application.js";
import type { CentralFundedStage } from "./contracts.js";
import { readFrozenStage, retainFrozenStage } from "./stage-evidence.js";

const at = "2026-11-04T15:00:00.000Z", scope = "workspace:stage-evidence-contract";

/** TEST ONLY canonical funding/source fixture. No worker qualification or
 * provider result is simulated by these archive/decoder contracts. */
async function fixture(t: TestContext) {
  const parent = testScratchPath("central-stage-evidence-tests");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  let serial = 0;
  const load = async () => {
    const result = await createBoardReader(boardRoot).load();
    assert.ok(result.ok);
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `stage-test:${++serial}`,
      issuedAt: at, action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };

  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "root:stage-evidence",
    scope, unit: "total_model_tokens", limits: { tokens: 4000, calls: 4, steps: 4 }, authorizationRef: "test:root-authorization" } });
  await act({ kind: "report", issueId: "issue:stage-evidence", scope, problemKey: "method:source-bound-contract", report: {
    reportId: "report:stage-evidence", source: { subsystem: "method", taskId: "task:stage-evidence", versionId: "method:stage-evidence" },
    facts: ["scope:json"], evidenceRefs: ["evidence:original-source"] } });
  let state = await load(), issue = state.learningIssues![0]!;

  await act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "TEST explicit PA selection", sourceRefs: ["report:stage-evidence"] });
  state = await load();
  issue = state.learningIssues![0]!;
  await act({ kind: "fund", domain: "prompt", issueId: issue.issueId, expectedRevision: issue.revision,
    expectedSequence: state.sequence, grantId: "grant:stage-evidence", budgetId: "root:stage-evidence",
    authorizationRef: "test:stage-authorization", planRef: "test:committed-original-plan",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 2000, maxCalls: 2, maxSteps: 2, maxPromptChars: 4000 } });
  state = await load();
  issue = state.learningIssues![0]!;
  const input: CentralFundedStage = { issueId: issue.issueId, grantId: "grant:stage-evidence", expectedIssueRevision: issue.revision,
    stageRef: "stage:original-proposal", policyRef: "policy:original-proposal", sourceBindingRef: "source:original-proposal",
    offer: { offerId: "offer:original-proposal", owner: { plane: "agent", domain: "prompt" }, policyRef: "policy:original-proposal",
      reserve: { tokens: 2000, calls: 2, steps: 2 }, maxPromptChars: 4000 } };
  const candidate: CentralPursuitCandidate = { opportunity: { opportunityId: input.offer.offerId, scope, targetRef: "definition:proposal-delivery",
    instanceRef: input.stageRef, sourceRef: input.sourceBindingRef, stage: "initial", conditionRef: "condition:source-test",
    baselineRef: "baseline:test-idle", windowRef: "window:proposal-test", offer: input.offer },
    source: { issueId: input.issueId, grantId: input.grantId, sourceBindingRef: input.sourceBindingRef, domainStage: {
      stageRef: input.stageRef, policyRef: input.policyRef, kind: "initial", sourceReportId: "report:stage-evidence",
      readiness: { kind: "ready", evidenceRefs: ["evidence:original-source"] } } },
    readiness: { kind: "ready", sourceRef: input.sourceBindingRef, now: Date.parse(at), nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "definition:proposal-delivery" },
    fee: { kind: "hard-budget-only", sourceRef: "root:stage-evidence" }, purpose: "focused_learning",
    objective: { instanceId: "objective:original-stage", criterion: "proposal_delivered", definitionRef: "definition:proposal-delivery",
      familyRef: "family:original-source", familySourceRef: input.policyRef } };
  const address = { boardRoot, scope, grantId: input.grantId, stageRef: input.stageRef };

  return { boardRoot, load, act, input, candidate, address };
}

test("one immutable exact-stage frame survives real original settlement, yield and reconcile", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained") assert.fail("frame not retained");

  assert.equal(retained.value.schemaVersion, 2);

  if (retained.value.schemaVersion !== 2) assert.fail("new stages require the original source snapshot");

  assert.equal(retained.value.sourceSnapshot.scope, scope);
  assert.equal(retained.value.sourceSnapshot.issueId, f.input.issueId);
  assert.equal(retained.value.sourceSnapshot.knownAtBoardSequence, retained.value.committedAtSequence);
  assert.equal(retained.value.sourceSnapshot.qualification, "source_snapshot_not_counterfactual_or_learning_gain");
  assert.ok(retained.value.sourceSnapshot.missingSources.length > 0, "unknown external references do not fabricate a baseline or reject cold start");
  const sequence = (await f.load()).sequence;

  assert.equal((await retainFrozenStage(f)).status, "retained");
  assert.equal((await f.load()).sequence, sequence,
    "an evidence archive creates no Board ledger or execution transition");
  const grant = (await f.load()).centralLearningGrants![0]!;

  await f.act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: "claim:original-stage",
    ownerId: "test:original-owner", expectedIssueRevision: f.input.expectedIssueRevision, expiresAt: "2026-11-04T15:01:00.000Z" });
  await f.act({ kind: "reserve", grantId: grant.grantId, claimId: "claim:original-stage", reservationId: "reservation:original-stage", maxTokens: 1000 });
  await f.act({ kind: "settle", grantId: grant.grantId, reservationId: "reservation:original-stage", usage: { kind: "reported", totalTokens: 123 } });
  await f.act({ kind: "finish", jobId: grant.jobId, claimId: "claim:original-stage", result: { kind: "yielded", reason: "test:real-source-boundary" } });
  const app = createLearningAllocationApplication({ boardRoot: f.boardRoot, now: () => at, enabled: () => true });
  const reconciled = await app.reconcile({ grantId: grant.grantId, expectedSequence: (await f.load()).sequence, authorizationRef: "test:stage-authorization" });

  assert.ok("ok" in reconciled && reconciled.ok);
  const read = await readFrozenStage(f.address);
  assert.equal(read.status, "ready");

  if (read.status === "ready") assert.deepEqual(read.value, retained.value, "later revisions and a smaller allowance do not replace the original question");

  assert.equal((await f.load()).centralLearningGrants![0]!.allowance.maxTokens, 123);
});

test("an exact retry reuses the original pre-learning prefix after later source reports", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained" || retained.value.schemaVersion !== 2) assert.fail("v2 frame not retained");

  const issue = (await f.load()).learningIssues![0]!;

  await f.act({ kind: "report", scope, issueId: issue.issueId, problemKey: issue.problemKey, report: {
    reportId: "report:later-source-prefix", source: { subsystem: "method", taskId: "task:later-source", versionId: "method:stage-evidence" },
    facts: ["scope:json", "A later source report must not alter the frozen prefix"], evidenceRefs: ["evidence:later-source"] } });
  assert.ok((await f.load()).sequence > retained.value.sourceSnapshot.knownAtBoardSequence);
  const retried = await retainFrozenStage(f);
  assert.equal(retried.status, "retained");

  if (retried.status === "retained") assert.deepEqual(retried.value, retained.value);
});

test("a resumed clock reuses the immutable assignment while changed target or execution CAS still conflicts", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained") assert.fail("frame not retained");

  const before = await f.load();
  const candidate: CentralPursuitCandidate = { ...f.candidate, readiness: { kind: "ready", sourceRef: f.candidate.readiness.sourceRef,
    now: Date.parse(at) + 1000, nextHandoff: null } };
  const resumed = await retainFrozenStage({ ...f, candidate });
  assert.equal(resumed.status, "retained");

  if (resumed.status === "retained") assert.deepEqual(resumed.value, retained.value, "the frozen time and source prefix remain original");

  assert.deepEqual(await f.load(), before, "clock-only resume creates no Board facts or execution rights");
  const target = await retainFrozenStage({ ...f, candidate: { ...candidate,
    target: { kind: "boundary-independent", sourceRef: "definition:a-different-original-target" } } });

  assert.deepEqual(target, { status: "unknown", reason: "central_stage_archive_conflict" });
  const financialCas = await retainFrozenStage({ ...f, candidate, input: { ...f.input, expectedIssueRevision: f.input.expectedIssueRevision + 1 } });

  assert.deepEqual(financialCas, { status: "unknown", reason: "central_stage_archive_conflict" });
  assert.deepEqual(await readFrozenStage(f.address), { status: "ready", value: retained.value });
});

test("legacy v1 frames remain observable with unknown source metadata and are never backfilled from today's Board", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained" || retained.value.schemaVersion !== 2) assert.fail("v2 frame not retained");

  const { digest: _digest, sourceSnapshot: _snapshot, ...original } = retained.value;
  const legacy = { ...original, schemaVersion: 1 };

  await writeFile(retained.file, canonicalJson({ ...legacy, digest: contentHashOf(legacy) }), "utf8");
  const read = await readFrozenStage(f.address);
  assert.equal(read.status, "ready");

  if (read.status !== "ready") assert.fail("legacy observation frame unavailable");

  assert.equal(read.value.schemaVersion, 1);
  assert.equal("sourceSnapshot" in read.value, false);
  const retried = await retainFrozenStage(f);
  assert.equal(retried.status, "retained");

  if (retried.status === "retained") assert.deepEqual(retried.value, read.value);
});

test("a self-consistent source snapshot cannot claim knowledge after the original stage freeze", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained" || retained.value.schemaVersion !== 2) assert.fail("v2 frame not retained");

  const { digest: _digest, ...frame } = retained.value;
  const { sourceHash: _hash, snapshotId: _id, ...source } = frame.sourceSnapshot;
  const changed = { ...source, knownAtBoardSequence: frame.committedAtSequence + 1 }, sourceHash = contentHashOf(changed);
  const forged = { ...frame, sourceSnapshot: { ...changed, sourceHash, snapshotId: `pre-learning-source:${sourceHash}` } };

  await writeFile(retained.file, canonicalJson({ ...forged, digest: contentHashOf(forged) }), "utf8");
  assert.deepEqual(await readFrozenStage(f.address), { status: "unknown", reason: "central_stage_archive_binding" });
});

test("missing old frames and changed source binding remain unknown instead of reconstructing a current stage", async t => {
  const f = await fixture(t);

  assert.deepEqual(await readFrozenStage(f.address), { status: "unknown", reason: "central_stage_archive_missing" });
  const mismatch = await retainFrozenStage({ ...f, candidate: { ...f.candidate,
    source: { ...f.candidate.source, sourceBindingRef: "source:another-stage" } } });

  assert.equal(mismatch.status, "unknown");
  assert.equal((await readFrozenStage(f.address)).status, "unknown");
  const retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained" || retained.value.schemaVersion !== 2) assert.fail("v2 frame not retained");

  const { digest: _digest, ...payload } = retained.value;
  const reportHash = contentHashOf({ invented: "source report" });
  const { sourceHash: _sourceHash, snapshotId: _snapshotId, ...source } = payload.sourceSnapshot;
  const alteredSource = { ...source, originalReports: { ...source.originalReports,
    selected: source.originalReports.selected.map(row => ({ ...row, reportHash })) } };
  const sourceHash = contentHashOf(alteredSource);
  const replaced = { ...payload, sourceReportHash: reportHash,
    sourceSnapshot: { ...alteredSource, sourceHash, snapshotId: `pre-learning-source:${sourceHash}` } };

  await writeFile(retained.file, canonicalJson({ ...replaced, digest: contentHashOf(replaced) }), "utf8");
  assert.deepEqual(await readFrozenStage(f.address), { status: "unknown", reason: "central_stage_archive_original_source_changed" },
    "a recomputed archive hash cannot substitute another original Board source");
});

test("a later focus and grant do not erase the frozen original grant or let its new job replace the old one", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained") assert.fail("frame not retained");

  const originalJobId = (await f.load()).centralLearningGrants![0]!.jobId;
  const app = createLearningAllocationApplication({ boardRoot: f.boardRoot, now: () => at, enabled: () => true });
  const closed = await app.closeInvestment({ grantId: f.input.grantId, expectedSequence: (await f.load()).sequence,
    authorizationRef: "test:stage-authorization", planRef: "test:closed-old-investment", reason: "test:confirmed-original-boundary" });

  assert.ok("ok" in closed && closed.ok);
  let state = await f.load(), issue = state.learningIssues![0]!;

  await f.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "TEST explicit later PA focus", sourceRefs: ["evidence:later-requirement"] });
  state = await f.load();
  issue = state.learningIssues![0]!;
  await f.act({ kind: "fund", domain: "prompt", issueId: issue.issueId, expectedRevision: issue.revision, expectedSequence: state.sequence,
    grantId: "grant:later-stage-evidence", budgetId: "root:stage-evidence", authorizationRef: "test:later-authorization",
    planRef: "test:later-plan", allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000,
      maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } });
  await f.act({ kind: "report", issueId: issue.issueId, scope, problemKey: issue.problemKey, report: { reportId: "report:later-other-owner",
    source: { subsystem: "tool", taskId: "task:later", versionId: "tool:later" }, facts: ["new independent requirement"], evidenceRefs: ["evidence:later-requirement"] } });
  const read = await readFrozenStage(f.address);
  assert.equal(read.status, "ready");

  if (read.status !== "ready") assert.fail("old frame was lost after a later focus");

  assert.equal(read.value.input.grantId, f.input.grantId);
  assert.equal(read.value.unitId, retained.value.unitId);
  const after = await f.load(), original = after.centralLearningGrants!.find(row => row.grantId === read.value.input.grantId)!;

  assert.equal(original.status, "closed");
  assert.equal(original.jobId, originalJobId);
  assert.notEqual(after.learningIssues![0]!.jobId, originalJobId);
  assert.deepEqual(read.value.candidate.source, f.candidate.source, "no current context, mixed report or new final job is substituted into the historical frame");
});

test("runtime decoding rejects malformed timing, extra fields and corrupt JSON even with a newly computed digest", async t => {
  const f = await fixture(t), retained = await retainFrozenStage(f);
  assert.equal(retained.status, "retained");

  if (retained.status !== "retained") assert.fail("frame not retained");

  const { digest: _digest, ...payload } = retained.value;
  const badTiming = { ...payload, candidate: { ...payload.candidate, target: { kind: "deadline", sourceRef: "test:deadline", useBy: -1,
    durationUpperBound: 1, durationSourceRef: "test:duration" } } };

  await writeFile(retained.file, canonicalJson({ ...badTiming, digest: contentHashOf(badTiming) }), "utf8");
  assert.equal((await readFrozenStage(f.address)).status, "unknown");
  await writeFile(retained.file, canonicalJson({ ...retained.value, dispatchAuthority: true }), "utf8");
  assert.equal((await readFrozenStage(f.address)).status, "unknown");
  await writeFile(retained.file, "{", "utf8");
  assert.deepEqual(await readFrozenStage(f.address), { status: "unknown", reason: "central_stage_archive_json" });
});
