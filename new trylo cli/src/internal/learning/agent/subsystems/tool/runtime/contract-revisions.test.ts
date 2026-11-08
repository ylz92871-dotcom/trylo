import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { prepareToolImprovement } from "./evolution-trials.js";
import { proposeToolContractRevision, reviewToolContractRevision, approveToolContractRevision,
  approvedToolContractRevisionsFromBoard } from "./contract-revisions.js";
import { withdrawToolContractRevision } from "./contract-revision-withdrawal.js";

test("a reviewable proposal cannot change manual checks until the exact user permission is consumed", async t => {
  const fx = await seedToolProduction(t), parent = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(parent.ok);
  const samples = parent.artifact.request.evidence, old = samples[0]!;
  const proposal = { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId: parent.versionId,
    scope: parent.artifact.request.scope, parentContractHash: contentHashOf(samples), reason: "incorrect_expectation", corrections: [{
      sampleId: old.sampleId, oldSampleHash: contentHashOf(old), oldExpectedHash: contentHashOf(old.expected),
      expected: { kind: "value", value: 5 }, evidenceRefs: ["user:explicit-oracle-correction"] }] };

  assert.equal((await proposeToolContractRevision(fx.root, proposal, productionTestTime, { jobId: "late-worker", attempt: 1 })).ok, false,
    "a late/unclaimed worker cannot write even a shape-valid correction proposal");
  const saved = await proposeToolContractRevision(fx.root, proposal, productionTestTime);
  assert.ok(saved.ok);
  assert.equal((await proposeToolContractRevision(fx.root, { ...proposal, approved: true }, productionTestTime)).ok, false);
  const review = await reviewToolContractRevision(fx.root, saved.proposalId, proposal.scope);
  assert.ok(review.ok);
  assert.deepEqual(review.changes[0]?.oldExpected, old.expected);
  assert.deepEqual(review.changes[0]?.newExpected, { kind: "value", value: 5 });
  const permission = createFilePermissionStore({ path: path.join(fx.root, "contract-permission.ndjson") });
  const denied = await approveToolContractRevision({ boardRoot: fx.root, proposalId: saved.proposalId, scope: proposal.scope,
    reviewId: review.reviewId, permission, token: { grantId: "self-asserted" }, issuedAt: productionTestTime });

  assert.equal(denied.ok, false);
  const before = await createBoardReader(fx.root).load();
  assert.ok(before.ok);
  const unapproved = approvedToolContractRevisionsFromBoard(before.state, parent.versionId, proposal.scope, [review.revisionId]);
  assert.equal(unapproved.ok, false);
  const changed = { ...parent.artifact.request, evidence: samples.map(sample => sample.sampleId === old.sampleId
    ? { ...sample, expected: { kind: "value" as const, value: 5 } } : sample) };

  assert.equal((await prepareToolImprovement(fx.root, parent.versionId, changed)).ok, false, "manual improvement obeys the same preserved contract");
  const granted = await permission.issue({ action: "modify", candidateId: review.reviewId, packageVersionId: parent.versionId,
    scope: proposal.scope, issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(granted.ok);
  const accepted = await approveToolContractRevision({ boardRoot: fx.root, proposalId: saved.proposalId, scope: proposal.scope,
    reviewId: review.reviewId, permission, token: { grantId: granted.grant.grantId }, issuedAt: productionTestTime });
  assert.ok(accepted.ok);
  const fact = await permission.getGrant(granted.grant.grantId);
  assert.ok(fact.ok);
  assert.equal(fact.grant?.status, "consumed");
  const approved = await prepareToolImprovement(fx.root, parent.versionId, { ...changed, contractRevisionRefs: [accepted.revisionId] });
  assert.ok(approved.ok);
  assert.deepEqual(approved.request.evidence[0]?.expected, { kind: "value", value: 5 });
  assert.equal((await prepareToolImprovement(fx.root, parent.versionId, { ...changed, evidence: changed.evidence.slice(0, 3), contractRevisionRefs: [accepted.revisionId] })).ok, false);
  const after = await createBoardReader(fx.root).load();
  assert.ok(after.ok);
  assert.deepEqual(after.state.activations, before.state.activations);
  assert.deepEqual(after.state.approvals, before.state.approvals);
  const original = await readToolEvolutionCandidate(fx.root, parent.versionId);
  assert.ok(original.ok);
  assert.deepEqual(original.artifact.request.evidence, samples);
  const withdrawal = await reviewToolContractRevision(fx.root, saved.proposalId, proposal.scope);
  assert.ok(withdrawal.ok);
  assert.notEqual(withdrawal.withdrawReviewId, withdrawal.reviewId);
  assert.match(withdrawal.withdrawalEffect, /active derived tool may refuse/);
  const wrong = await withdrawToolContractRevision({ boardRoot: fx.root, proposalId: saved.proposalId, scope: proposal.scope,
    withdrawReviewId: withdrawal.reviewId, permission, token: { grantId: "not-consumed" }, issuedAt: productionTestTime });
  assert.equal(wrong.ok, false);
  const withdrawalGrant = await permission.issue({ action: "modify", candidateId: withdrawal.withdrawReviewId, packageVersionId: parent.versionId,
    scope: proposal.scope, issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(withdrawalGrant.ok);
  const withdrawn = await withdrawToolContractRevision({ boardRoot: fx.root, proposalId: saved.proposalId, scope: proposal.scope,
    withdrawReviewId: withdrawal.withdrawReviewId, permission, token: { grantId: withdrawalGrant.grant.grantId }, issuedAt: productionTestTime });
  assert.ok(withdrawn.ok);
  const final = await createBoardReader(fx.root).load();
  assert.ok(final.ok);
  assert.equal(approvedToolContractRevisionsFromBoard(final.state, parent.versionId, proposal.scope, [accepted.revisionId]).ok, false);
  const discovered = approvedToolContractRevisionsFromBoard(final.state, parent.versionId, proposal.scope);
  assert.ok(discovered.ok);
  assert.deepEqual(discovered.revisions, []);
  assert.equal((await prepareToolImprovement(fx.root, parent.versionId, { ...changed, contractRevisionRefs: [accepted.revisionId] })).ok, false);
  assert.deepEqual(final.state.activations, before.state.activations);
});
