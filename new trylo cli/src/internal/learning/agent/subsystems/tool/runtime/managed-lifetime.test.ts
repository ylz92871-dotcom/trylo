import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { resultVersionId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingClaimId, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { createToolCentralLearning } from "./central-learning.js";
import { createToolLearningFunding, nominateToolLearningSource } from "./learning-funding.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";
import type { ToolLearningContext } from "../domain/evolution/learning-plan.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";

test("a managed tool continues beyond its old private lifetime caps in the same original account", async t => {
  const parent = testScratchPath("tool-managed-lifetime");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  const scope = "tool:lifetime-assets", centralScope = "tool:lifetime-root", at = "2026-11-05T01:00:00.000Z";
  const signal = new AbortController().signal;
  let currentTime = Date.parse(at);
  const now = () => currentTime;
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, createdAt: at,
    capability: "TEST ONLY same-account continuation", trigger: { runId: "task:lifetime", proposalKey: "test:lifetime",
      action: "user_requested", evidenceRefs: ["source:lifetime"] } };
  const queued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(queued.ok);
  const identity = toolLearningFundingIdentity(plan), budgetId = "root:tool-lifetime";
  let serial = 0;
  const command = async (value: BoardCommand) => {
    const result = await withBoardWriter(boardRoot, board => board.apply(value));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const act = (action: CoordinationAction) => command({ type: "coordinate_learning", commandId: `lifetime:${++serial}`, issuedAt: at, action });
  const load = async () => {
    const result = await createBoardReader(boardRoot).load();
    assert.ok(result.ok);
    return result.state;
  };

  assert.ok((await nominateToolLearningSource({ boardRoot, scope, centralScope, now }, plan, signal)).ok);
  await act({ kind: "decide", issueId: identity.issueId, expectedRevision: 1, decision: "focused_learning",
    reason: "TEST authorized original research", sourceRefs: ["source:lifetime"] });
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId, scope: centralScope,
    unit: "total_model_tokens", limits: { tokens: 96000, calls: 8, steps: 8 }, authorizationRef: "test:initial" } });
  const initialAllowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 96000, maxCalls: 8, maxSteps: 8, maxPromptChars: 24000 };

  await act({ kind: "fund", issueId: identity.issueId, expectedRevision: 2, grantId: identity.grantId, domain: "tool",
    allowance: initialAllowance, budgetId, expectedSequence: (await load()).sequence,
    authorizationRef: "test:initial", planRef: "test:original-plan" });
  let originalCalls = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await command({ type: "requeue_job", commandId: `test:requeue:${attempt}`, issuedAt: at,
      jobId: queued.jobId, expectedAttempt: attempt - 1 });

    await command({ type: "start_job", commandId: `test:start:${attempt}`, issuedAt: at, jobId: queued.jobId });
    const grant = (await load()).centralLearningGrants![0]!, claimId = toolLearningFundingClaimId(plan, queued.jobId, attempt, attempt);

    await act({ kind: "claim", jobId: grant.jobId, expectedAttempt: attempt - 1, claimId,
      ownerId: identity.ownerId, expiresAt: "2026-11-05T01:10:00.000Z" });

    for (let call = 0; call < (attempt === 3 ? 2 : 3); call++) {
      const reservationId = `test:original-call:${++originalCalls}`;
      await act({ kind: "reserve", grantId: grant.grantId, claimId, reservationId, maxTokens: 12000 });
      await act({ kind: "settle", grantId: grant.grantId, reservationId, usage: originalCalls === 8
        ? { kind: "unknown", reason: "test:original-response-lost" } : { kind: "reported", totalTokens: 12000, model: "scripted" } });
    }

    const inputFingerprint = toolLearningInputFingerprint(await load(), plan);
    const saved = await withBoardWriter(boardRoot, board => savePipelineAsset(board, { kind: "workflow", scope, source: "inferred", issuedAt: at,
      versionId: resultVersionId(queued.jobId, attempt), content: { type: "tool_learning_result", schemaVersion: 1,
        jobId: queued.jobId, attempt, outcome: "waiting_evidence", code: "learning_budget_exhausted",
        search: { status: "complete", candidates: [], failures: [] }, occurredAt: at, inputFingerprint, inputFingerprintPolicy: 2 } }));
    assert.ok(saved.ok);
    await command({ type: "complete_job", commandId: `${queued.jobId}:terminal:${attempt}`, issuedAt: at, jobId: queued.jobId, next: "waiting_evidence" });
    await act({ kind: "finish", jobId: grant.jobId, claimId, result: { kind: "yielded", reason: "test:confirmed-checkpoint" } });
  }

  const before = await load(), originalGrant = before.centralLearningGrants![0]!;

  assert.deepEqual(centralLearningSpent(originalGrant), { tokens: 96000, calls: 8, steps: 8 });
  await act({ kind: "set_budget_limit", budgetId, expectedSequence: before.sequence, changeId: "test:explicit-more-research",
    limits: { tokens: 2000000, calls: 1000, steps: 1000 }, authorizationRef: "test:explicit-more-research" });
  const authorizedAllowance = { ...initialAllowance, maxTokens: 2000000, maxCalls: 1000, maxSteps: 1000 };
  const operationAllowance = { ...initialAllowance, maxTokens: 4000, maxCalls: 1, maxSteps: 1, maxPromptChars: 12000 };
  let modelCalls = 0;
  const owner = createToolCentralLearning({ boardRoot, scope, centralScope, now, authorized: () => true, modelRef: "scripted", mode: "after_turn",
    run: async (jobId, managedBinding, abort) => {
      const funding = createToolLearningFunding({ boardRoot, scope, centralScope, now, managedBinding });
      const worker = { boardRoot, scope, now, managedBinding, mode: "after_turn" as const, signal: abort, jobIds: [jobId], services: {
        search: async () => { throw new Error("No public lookup requested"); }, evolve: async () => { throw new Error("No construction requested"); },
        allowance: (value: ToolLearningPlan) => funding.allowance(value), releaseAllowance: () => funding.release(),
        plan: async (context: ToolLearningContext) => {
          assert.equal(context.allowance.maxPromptChars, 12000);
          assert.ok((await funding.reserve("test:next-call", 1000)).ok);
          modelCalls++;
          assert.ok((await funding.settle("test:next-call", { kind: "reported", totalTokens: 100, model: "scripted" })).ok);
          // A real late receipt replaces the old unknown estimate. It releases
          // original-root commitment, never refunds this operation's 100 tokens.
          assert.ok((await funding.settle("test:original-call:8", { kind: "reported", totalTokens: 11900, model: "scripted" })).ok);
          const inspected = await funding.inspect();
          assert.ok(inspected.ok);
          assert.equal(inspected.remaining.tokens, 3900);
          const overflow = await funding.reserve("test:outside-operation", 1000);
          assert.ok(!overflow.ok);

          return { action: "defer", reason: "more_evidence", neededEvidence: ["A new authoritative contract"], rationale: "Test checkpoint",
            existingInsufficiency: "Unknown contract", expectedBenefit: "Ground further work", constructionCost: "One scripted call", alternatives: [] };
        } } };

      return workToolLearningPipeline(worker);
    } });
  const prepared = await owner.prepare({ issueId: identity.issueId, authorizedAllowance, operationAllowance }, signal);

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  if (prepared.status !== "ready") return;

  assert.deepEqual(prepared.offer.reserve, { tokens: 4000, calls: 1, steps: 1 });
  assert.equal(prepared.offer.maxPromptChars, 12000);
  await act({ kind: "rebudget", grantId: identity.grantId, expectedSequence: (await load()).sequence,
    limits: { tokens: 100000, calls: 9, steps: 9 }, authorizationRef: "test:explicit-more-research", planRef: prepared.stageRef });
  const ready = await load(), issue = ready.learningIssues!.find(item => item.issueId === identity.issueId)!;
  const rejected = (continuation?: import("../../../../control/commands.js").ManagedJobContinuation) => withBoardWriter(boardRoot,
    board => board.apply({ type: "requeue_job", commandId: `test:bad-proof:${++serial}`, issuedAt: at,
      jobId: queued.jobId, expectedAttempt: 3, ...(continuation === undefined ? {} : { continuation }) }));

  assert.ok(!(await rejected()).ok);
  const budgetJob = ready.jobs.find(item => item.jobId === originalGrant.jobId)!;
  const prestartClaim = toolLearningFundingClaimId(plan, queued.jobId, 4, budgetJob.attempt + 1);

  await act({ kind: "claim", jobId: budgetJob.jobId, expectedAttempt: budgetJob.attempt, claimId: prestartClaim,
    ownerId: identity.ownerId, expiresAt: new Date(now() + 1000).toISOString(), expectedIssueRevision: issue.revision });
  const proof = { grantId: identity.grantId, claimId: prestartClaim, expectedIssueRevision: issue.revision,
    resultRef: resultVersionId(queued.jobId, 3), expectedAttempt: 3 };

  assert.ok(!(await rejected({ ...proof, claimId: "test:wrong-claim" })).ok);
  assert.ok(!(await rejected({ ...proof, resultRef: resultVersionId(queued.jobId, 2) })).ok);
  const live = await load();
  assert.ok((await owner.recover(signal, issue.issueId)).ok);
  assert.equal((await load()).sequence, live.sequence);
  currentTime += 2000;
  assert.ok((await owner.recover(signal, issue.issueId)).ok);
  const recovered = await load();
  assert.equal(recovered.centralLearningGrants![0]!.claim, undefined);
  assert.deepEqual(recovered.centralLearningGrants![0]!.reservations, originalGrant.reservations);
  assert.equal(recovered.jobs.find(item => item.jobId === queued.jobId)!.attempt, 3);
  const result = await owner.dispatch({ issueId: issue.issueId, grantId: identity.grantId, expectedIssueRevision: issue.revision,
    stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer }, signal);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(modelCalls, 1, JSON.stringify(result));
  const after = await load(), grant = after.centralLearningGrants![0]!;

  assert.equal(after.jobs.find(job => job.jobId === queued.jobId)!.attempt, 4);
  assert.equal(after.jobs.find(job => job.jobId === queued.jobId)!.state, "waiting_evidence");
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(grant.grantId, originalGrant.grantId);
  assert.equal(grant.budgetId, budgetId);
  assert.deepEqual(grant.reservations.slice(0, 7), originalGrant.reservations.slice(0, 7));
  assert.equal(grant.reservations[7]!.reservationId, originalGrant.reservations[7]!.reservationId);
  assert.deepEqual(grant.reservations[7]!.usage, { kind: "reported", totalTokens: 11900, model: "scripted" });
  assert.deepEqual(centralLearningSpent(grant), { tokens: 96000, calls: 9, steps: 9 });
  assert.equal(grant.claim, undefined);
  const executedProof = { ...proof, claimId: grant.reservations[8]!.claimId };
  const commandId = `${queued.jobId}:start:4:managed:${contentHashOf(executedProof)}`;

  assert.ok(after.appliedCommands.some(item => item.commandId === commandId && item.payloadHash !== undefined));
  const replaced = await withBoardWriter(boardRoot, board => board.apply({ type: "start_job", commandId, issuedAt: at,
    jobId: queued.jobId, continuation: { ...executedProof, claimId: "test:replacement-claim" } }));

  assert.ok(!replaced.ok);
  assert.equal(replaced.reason, "command_payload_conflict");
  assert.equal((await load()).sequence, after.sequence);
});
