import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { buildWorkflowCandidate } from "../runtime/improvement-candidate.js";
import type { WorkflowImprovementFunding } from "../runtime/improvement-contracts.js";
import type { WorkflowResearchCheckpoint } from "../runtime/research-state.js";
import { createWorkflowImprovementFunding } from "./improvement-funding.js";
import { fileWorkflowImprovementPorts } from "./improvement-composition.js";

async function fixture(t: TestContext, initialStatus: "candidate" | "continue" = "candidate") {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-research-source-cas-"));

  t.after(async () => { assert.equal(path.dirname(path.resolve(boardRoot)), path.resolve(tmpdir()));
    assert.ok(path.basename(boardRoot).startsWith("workflow-research-source-cas-"));
  await rm(boardRoot, { recursive: true, force: true }); });
  const source = searchImprovementFixture(), now = () => 1_793_761_200_000;
  const options = { boardRoot, scope: source.opportunity.task.scope, centralScope: "D:/workspace/workflow-source-cas",
    budgetId: "original-workflow-source-run", allowance: 16_000, now, research: true as const };
  const read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => { const saved = await withBoardWriter(boardRoot, store => store.apply({
    type: "coordinate_learning", commandId: `source-cas:${contentHashOf(action)}`, issuedAt: new Date(now()).toISOString(), action }));
    assert.ok(saved.ok, JSON.stringify(saved));
  return saved.state; };
  const record = { type: "workflow_improvement_opportunity" as const, schemaVersion: 1 as const,
    opportunity: source.opportunity, evidence: source.evidence };
  const original = createWorkflowImprovementFunding(options), prepared = await original.prepare(record);
  assert.ok(prepared.ok);
  await act({ kind: "open_budget", expectedSequence: (await read()).sequence, budget: { schemaVersion: 1,
    budgetId: "root:workflow-source-cas", scope: options.centralScope, unit: "total_model_tokens",
    limits: { tokens: 32_000, calls: 8, steps: 8 }, authorizationRef: "host:original-root" } });
  const committed = await act({ kind: "fund", domain: "workflow", issueId: prepared.value.issueId,
    expectedRevision: prepared.value.expectedIssueRevision, expectedSequence: (await read()).sequence,
    grantId: prepared.value.grantId, allowance: prepared.value.allowance, budgetId: "root:workflow-source-cas",
    authorizationRef: "host:original-stage", planRef: "plan:original-stage" });
  const grant = committed.centralLearningGrants![0]!, revision = committed.learningIssues![0]!.revision;
  const funded: WorkflowImprovementFunding = { grantId: grant.grantId, jobId: grant.jobId,
    inputVersionId: prepared.value.inputVersionId, state: "queued", resultRefs: [] };
  const binding = { grantId: funded.grantId, inputVersionId: funded.inputVersionId, expectedIssueRevision: revision };
  const funding = createWorkflowImprovementFunding({ ...options, researchOwnerId: "original-research-owner", binding });
  assert.ok(funding.research);
  const reserved = await funding.research.reserve(funded, { stepId: "wf-research:0", maxTokens: 4000 });
  assert.ok(reserved.ok);
  assert.ok((await funding.settle(reserved.value, { kind: "reported", totalTokens: 500 })).ok);
  const built = buildWorkflowCandidate({ opportunity: source.opportunity, evidence: source.evidence, proposal: source.proposal }, []);
  assert.ok(built.ok);
  const ports = fileWorkflowImprovementPorts(options);
  assert.ok(ports.store.saveResearch);
  const checkpointBase = { type: "workflow_improvement_research" as const, schemaVersion: 1 as const, scope: options.scope,
    inputVersionId: funded.inputVersionId, grantId: funded.grantId, step: 0, reservationId: reserved.value.reservationId,
    contextRef: "context:original-grounded-source" };
  const checkpoint: WorkflowResearchCheckpoint = initialStatus === "candidate"
    ? { ...checkpointBase, status: "candidate", artifact: built.value }
    : { ...checkpointBase, status: "continue", observation: { kind: "material_read", evidenceRefs: [source.evidence[0]!.ref] } };
  const owner = { reservation: reserved.value, signal: new AbortController().signal, now };
  const checkpointed = await ports.store.saveResearch(checkpoint, owner);
  assert.ok(checkpointed.ok, JSON.stringify(checkpointed));
  const legacyReservation = { ...reserved.value };
  Reflect.deleteProperty(legacyReservation, "expectedIssueRevision");
  const legacyOwner = { ...owner, reservation: legacyReservation };
  const beforeLegacy = await read();
  const repeated = await ports.store.saveResearch(checkpoint, legacyOwner);
  assert.ok(repeated.ok, JSON.stringify(repeated));
  assert.equal((await read()).sequence, beforeLegacy.sequence, "a legacy owner without optional revision keeps same-focus idempotent compatibility");
  const refocus = async () => {
    const current = (await read()).learningIssues![0]!;
    await act({ kind: "decide", issueId: current.issueId, expectedRevision: current.revision, decision: "focused_learning",
      reason: "A new source focus supersedes the original research owner before its final write", sourceRefs: [funded.inputVersionId] });
    const focused = await read();
    assert.ok(focused.learningIssues![0]!.decision.kind === "focused_learning");
    assert.ok(focused.learningIssues![0]!.decision.revision > grant.focusRevision);
    return focused;
  };

  return { options, funding, funded, grant, revision, reservation: reserved.value, legacyReservation, owner, legacyOwner,
    ports, checkpoint, checkpointRef: checkpointed.value.versionId, artifact: built.value, read, refocus };
}

test("a late settled research response survives lease expiry while a replacement claim fences the old writer", async t => {
  for (const replacement of [false, true]) await t.test(replacement ? "replacement_owner" : "original_owner", async subtest => {
    const fx = await fixture(subtest, "continue");
    assert.ok(fx.funding.research);
    const reserved = await fx.funding.research.reserve(fx.funded, { stepId: "wf-research:1", maxTokens: 4000 });
    assert.ok(reserved.ok);
    assert.ok((await fx.funding.settle(reserved.value, { kind: "reported", totalTokens: 500 })).ok);
    const lateNow = () => fx.options.now() + 600001;

    if (replacement) {
      const before = await fx.read(), job = before.jobs.find(row => row.jobId === fx.funded.jobId)!;
      const claimed = await withBoardWriter(fx.options.boardRoot, store => store.apply({ type: "coordinate_learning",
        commandId: "replace-expired-workflow-owner", issuedAt: new Date(lateNow()).toISOString(), action: { kind: "claim",
          jobId: job.jobId, expectedAttempt: job.attempt, claimId: "claim:replacement", ownerId: "replacement-worker",
          expiresAt: new Date(lateNow() + 600000).toISOString(), expectedIssueRevision: fx.revision } }));
      assert.ok(claimed.ok, JSON.stringify(claimed));
    }

    const before = await fx.read();
    const checkpoint: WorkflowResearchCheckpoint = { type: "workflow_improvement_research", schemaVersion: 1,
      scope: fx.options.scope, inputVersionId: fx.funded.inputVersionId, grantId: fx.funded.grantId,
      step: 1, reservationId: reserved.value.reservationId, contextRef: fx.checkpoint.contextRef,
      previousVersionId: fx.checkpointRef, status: "continue", observation: { kind: "invalid_response",
        code: "learning_incomplete", message: "The original paid response reached its output boundary." } };
    const saved = await fx.ports.store.saveResearch!(checkpoint, { reservation: reserved.value,
      signal: new AbortController().signal, now: lateNow });

    assert.equal(saved.ok, !replacement, JSON.stringify(saved));
    const after = await fx.read();

    if (replacement) assert.equal(after.sequence, before.sequence);
    else assert.ok(after.sequence > before.sequence);

    assert.deepEqual(after.centralLearningGrants, before.centralLearningGrants,
      "checkpointing confirmed work does not allocate or change a claim, reservation or bill");
    assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), { tokens: 1000, calls: 2, steps: 2 });
  });
});

test("a refocus rejects the original workflow research finish for yield and stopped completion without changing its grant or known bill", async t => {
  const fx = await fixture(t), before = await fx.refocus();
  const yielded = await fx.funding.finish(fx.reservation, { kind: "yielded", reason: "original_segment_handoff" });
  const stopped = await fx.funding.finish(fx.reservation, { kind: "completed", resultRefs: [fx.checkpointRef] });
  const legacy = createWorkflowImprovementFunding({ ...fx.options, researchOwnerId: "original-research-owner",
    binding: { grantId: fx.funded.grantId, inputVersionId: fx.funded.inputVersionId } });
  const legacyYield = await legacy.finish(fx.legacyReservation, { kind: "yielded", reason: "legacy_original_handoff" });

  assert.ok(!yielded.ok, JSON.stringify(yielded));
  assert.equal(yielded.code, "learning_claim_conflict");
  assert.ok(!stopped.ok, JSON.stringify(stopped));
  assert.equal(stopped.code, "learning_claim_conflict");
  assert.ok(!legacyYield.ok, JSON.stringify(legacyYield));
  assert.equal(legacyYield.code, "learning_claim_conflict");
  assert.equal(Reflect.get(fx.reservation, "expectedIssueRevision"), fx.revision);
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.centralLearningGrants![0]!.status, "open");
  assert.equal(after.centralLearningGrants![0]!.claim?.claimId, fx.reservation.claimId);
  assert.equal(after.jobs[0]?.state, "running");
  assert.equal(after.jobs[0]?.coordination?.resultRefs, undefined);
  assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), { tokens: 500, calls: 1, steps: 1 });
});

test("a confirmed candidate cannot publish or replay a checkpoint through its original stale owner after workflow refocus", async t => {
  const fx = await fixture(t), claimed = await fx.funding.research!.claim(fx.funded);
  assert.ok(claimed.ok);
  const before = await fx.refocus();
  const published = await fx.ports.store.publish(fx.artifact, new Date(fx.options.now()).toISOString(), fx.owner);
  const replayed = await fx.ports.store.saveResearch!(fx.checkpoint, fx.legacyOwner);

  assert.ok(!published.ok, JSON.stringify(published));
  assert.equal(published.code, "learning_claim_conflict");
  assert.ok(!replayed.ok, JSON.stringify(replayed));
  assert.equal(replayed.code, "learning_claim_conflict");
  assert.equal(Reflect.get(claimed.value, "expectedIssueRevision"), fx.revision);
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.assets.length, before.assets.length);
  assert.equal(after.assets.some(item => item.content !== null && typeof item.content === "object"
    && "type" in item.content && item.content.type === "workflow_improvement"), false);
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.centralLearningGrants![0]!.status, "open");
  assert.equal(after.jobs[0]?.state, "running");
  assert.equal(after.jobs[0]?.coordination?.resultRefs, undefined);
  assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), { tokens: 500, calls: 1, steps: 1 });
});
