import assert from "node:assert/strict";
import test from "node:test";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createCollaborationWorker } from "../../learning/agent/subsystems/collaboration/orchestration/worker.js";
import { createCollaborationResearchRecovery } from "../../learning/agent/subsystems/collaboration/runtime/research-history.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import { publishCollaborationArtifact } from "../../learning/agent/subsystems/collaboration/artifacts/publish.js";
import { centralLearningRemaining, centralLearningSpent, type CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createCentralCollaborationExecution } from "./collaboration.js";
import { readCentralStageDispatchEvidence } from "./stage-dispatch-evidence.js";
import type { CentralFundedStage, CentralStagePreparation } from "./contracts.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainTestSignal, withDomainBoard } from "./testing/domain-funding.test.js";

test("one continuing collaboration grant crosses 64 cumulative calls while each operation stays bounded and its unknown bill survives restart", async () => withDomainBoard(async fx => {
  const scope = DOMAIN_TEST_SCOPE, board = createFileCollaborationBoard(fx.boardRoot), reportId = "report:continuing-handoff";
  const act = async (action: CoordinationAction) => { const saved = await board.apply({ type: "coordinate_learning",
    commandId: `central-learning:${contentHashOf(action)}`, issuedAt: DOMAIN_TEST_NOW, action });
  assert.ok(saved.ok, JSON.stringify(saved));
  return saved.state; };
  const receiptWriter = createCollaborationRuntimeReceiptWriter({ board, scope });
  let decisions = 0, resourceCalls = 0;
  const worker = createCollaborationWorker({ board, scope, now: () => DOMAIN_TEST_NOW, context: async () => ({}),
    recoverResearch: createCollaborationResearchRecovery({ board, scope }),
    experienceInput: async () => ({ ok: false, reason: "unexpected_experience" }), publishExperience: async () => ({ ok: false, reason: "unexpected_publication" }),
    resources: { async query(input) {
      resourceCalls += 1;
      const base = { schemaVersion: 1 as const, scope, issueId: input.issue.issueId, jobId: input.jobId, grantId: input.grantId,
        requestId: input.requestId, owner: input.owner, query: input.query, recordedAt: DOMAIN_TEST_NOW,
        boundary: { executionId: "learning:continuing-original", taskId: input.issue.issueId, round: 1, role: "collaboration_learning" } };

      assert.ok((await receiptWriter.record({ ...base, phase: "resource_query", receiptId: "query:call-65", resultRefs: [], summary: "Requested actual prerequisite evidence" })).ok);
      assert.ok((await receiptWriter.record({ ...base, phase: "resource_result", receiptId: "result:call-65", resultRefs: ["source:actual-prerequisite"],
        status: "available", summary: "The existing expert confirms the exact prerequisite contract" })).ok);

      return { ok: true, summary: "The exact original prerequisite is visible", sourceRefs: ["source:actual-prerequisite"] };
    } },
    model: { async decide(input) {
      decisions += 1;
      const before = await input.funding.inspect();
      assert.ok(before.ok);
      assert.equal(before.remaining.calls, 1);
      assert.equal(before.grant.allowance.maxCalls, 70, "the original cumulative grant is preserved in the funding view");

      if (decisions === 2) {
        assert.ok(input.knownSourceRefs?.includes("source:actual-prerequisite"));
        assert.match(JSON.stringify(input.material), /summary_only/);
      }

      const reservationId = `collaboration-decision:${input.claimId}:${input.step}`;
      const [reserved, concurrentExcess] = await Promise.all([input.funding.reserve({ reservationId, maxTokens: 2 }),
        input.funding.reserve({ reservationId: `concurrent-excess:${input.claimId}`, maxTokens: 1 })]);

      assert.ok(reserved.ok);
      assert.ok(!concurrentExcess.ok);
      assert.equal(concurrentExcess.reason, "learning_operation_exhausted");
      const settled = await input.funding.settle({ reservationId, usage: { kind: "reported", totalTokens: 1 } });
      assert.ok(settled.ok);
      assert.equal(settled.remaining.calls, 0);
      assert.ok(centralLearningRemaining(settled.grant).calls >= 4);
      const excess = await input.funding.reserve({ reservationId: `excess:${input.claimId}`, maxTokens: 1 });

      assert.ok(!excess.ok);
      assert.equal(excess.reason, "learning_operation_exhausted");

      return decisions === 1 ? { ok: true, action: { kind: "query", owner: "research", query: "Inspect the actual prerequisite contract" } }
        : { ok: true, action: { kind: "no_change", reason: "The confirmed original prerequisite needs no replacement plan.", sourceRefs: ["source:actual-prerequisite"] } };
    } } });
  const control = createCollaborationControl({ board, worker, now: () => DOMAIN_TEST_NOW, ownerId: "continuing-collaboration-owner" });

  await act({ kind: "set_budget_limit", budgetId: "budget:domain-contract", expectedSequence: (await fx.load()).sequence,
    changeId: "root:initial-collaboration-cap", limits: { tokens: 128, calls: 64, steps: 64 }, authorizationRef: "host:original-root-cap" });
  const reported = await control.report({ scope, problemKey: "continuing-handoff", report: { reportId,
    source: { teamRunId: "team:original", taskId: "task:original", memberId: "personal_agent" },
    facts: ["The receiver lacks an exact prerequisite contract"], evidenceRefs: ["execution:actual-handoff"] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Investigate the ongoing original handoff question", sourceRefs: [reportId] });
  assert.ok(focused.ok);
  const initial = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 128, maxCalls: 64, maxSteps: 64, maxPromptChars: 10_000 };
  const funded = await act({ kind: "fund", issueId: focused.issue.issueId, expectedRevision: focused.issue.revision, grantId: "grant:continuing-collaboration",
    domain: "collaboration", expectedSequence: (await fx.load()).sequence, budgetId: "budget:domain-contract",
    authorizationRef: "host:original-collaboration-cap", planRef: "plan:original-collaboration-cap", allowance: initial });
  const grant = funded.centralLearningGrants![0]!, oldClaim = "claim:confirmed-prefix";

  await act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: oldClaim, ownerId: "original-owner", expiresAt: "2026-11-04T13:01:00.000Z" });

  for (let step = 0; step < 64; step += 1) {
    const reservationId = `collaboration-decision:${oldClaim}:${step}`;
    await act({ kind: "reserve", grantId: grant.grantId, claimId: oldClaim, reservationId, maxTokens: 2 });
    await act({ kind: "settle", grantId: grant.grantId, reservationId, usage: step === 63
      ? { kind: "unknown", reason: "original_usage_not_reported" } : { kind: "reported", totalTokens: 1 } });
  }

  const plan = { schema: "collaboration-plan/v1" as const, issueId: grant.issueId, focusRevision: grant.focusRevision,
    familyId: "original-prerequisite", title: "Preserve the prerequisite contract", summary: "The original evidence needs an existing expert's confirmation.",
    sourceRefs: [reportId], adjustments: [{ memberId: "personal_agent", kind: "handoff" as const, instruction: "Attach the immutable prerequisite identity." }],
    experienceVersionIds: [], needs: [{ owner: "expert" as const, memberId: "personal_agent", instruction: "Confirm the actual missing prerequisite after consent." }] };
  const published = await publishCollaborationArtifact({ board, scope, now: () => DOMAIN_TEST_NOW }, { issueId: grant.issueId,
    familyId: plan.familyId, title: plan.title, hypothesis: plan.summary, sourceRefs: plan.sourceRefs, content: plan, schemaVersion: 3, kind: "plan" });
  assert.ok(published.ok);
  const dependencyId = `collaboration-dependency:${contentHashOf([grant.jobId, published.versionId, 0])}`;

  await act({ kind: "finish", jobId: grant.jobId, claimId: oldClaim, result: { kind: "waiting_dependency", dependencies: [{ dependencyId,
    owner: "expert", correlationRef: `${published.versionId}#need:0`, state: { kind: "waiting", reason: "actual_owner_consent_pending" } }] } });
  const dependency = (await fx.load()).learningDependencies![0]!;

  assert.ok((await control.updateDependency({ dependencyId, expectedRevision: dependency.revision, state: { kind: "ready",
    resultRef: "expert:existing-prerequisite", resultVersion: "version:original", evidenceRefs: ["receipt:actual-consent"] } })).ok);
  await act({ kind: "set_budget_limit", budgetId: "budget:domain-contract", expectedSequence: (await fx.load()).sequence,
    changeId: "root:explicit-collaboration-increase", limits: { tokens: 1000, calls: 1000, steps: 1000 }, authorizationRef: "host:explicit-root-increase" });
  const cumulative = { ...initial, maxTokens: 80, maxCalls: 70, maxSteps: 70 };

  await act({ kind: "rebudget", grantId: grant.grantId, expectedSequence: (await fx.load()).sequence,
    authorizationRef: "host:explicit-original-grant-increase", planRef: "plan:continue-original-question", limits: { tokens: 80, calls: 70, steps: 70 } });
  const operationAllowance = { ...initial, maxTokens: 2, maxCalls: 1, maxSteps: 1 };
  const asFunded = async (stage: CentralStagePreparation): Promise<CentralFundedStage> => {
    assert.equal(stage.status, "ready", JSON.stringify(stage));
    if (stage.status !== "ready") throw new Error("Original stage not ready");
    assert.deepEqual(stage.offer.reserve, { tokens: 2, calls: 1, steps: 1 });
    assert.deepEqual(stage.authorizedAllowance, cumulative);
    return { issueId: grant.issueId, grantId: grant.grantId, expectedIssueRevision: (await fx.load()).learningIssues![0]!.revision,
      stageRef: stage.stageRef, policyRef: stage.policyRef, sourceBindingRef: stage.source.sourceBindingRef, offer: stage.offer };
  };
  const execution = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope, enabled: () => true, control });
  const first = await asFunded(await execution.prepare({ issueId: grant.issueId, authorizedAllowance: cumulative, operationAllowance }, domainTestSignal()));
  const yielded = await execution.dispatch(first, domainTestSignal());
  assert.ok(yielded.ok, JSON.stringify(yielded));
  assert.equal(yielded.status, "idle");
  assert.equal(yielded.result?.kind, "yielded");
  const after65 = await fx.load(), original = after65.centralLearningGrants![0]!;

  assert.equal(original.status, "open");
  assert.equal(original.claim, undefined);
  assert.equal(after65.jobs[0]?.state, "queued");
  assert.deepEqual(centralLearningSpent(original), { tokens: 66, calls: 65, steps: 65 });
  assert.deepEqual(original.reservations[63]?.usage, { kind: "unknown", reason: "original_usage_not_reported" });
  const cold = await readCentralStageDispatchEvidence({ boardRoot: fx.boardRoot, scope, domain: "collaboration" }, first);

  assert.equal(cold.status, "ready");
  if (cold.status === "ready") {
    assert.ok(cold.dispatch.ok);
    assert.equal(cold.dispatch.result?.kind, "yielded");
  }

  const resumedControl = createCollaborationControl({ board, worker, now: () => DOMAIN_TEST_NOW, ownerId: "restarted-collaboration-owner" });
  const resumed = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope, enabled: () => true, control: resumedControl });
  const second = await asFunded(await resumed.prepare({ issueId: grant.issueId, authorizedAllowance: cumulative, operationAllowance }, domainTestSignal()));
  const completed = await resumed.dispatch(second, domainTestSignal());
  assert.ok(completed.ok, JSON.stringify(completed));
  assert.equal(completed.status, "completed");
  const final = await fx.load();
  assert.equal(final.learningIssues!.length, 1);
  assert.equal(final.centralLearningGrants!.length, 1);
  assert.equal(final.centralLearningGrants![0]!.grantId, grant.grantId);
  assert.deepEqual(centralLearningSpent(final.centralLearningGrants![0]!), { tokens: 67, calls: 66, steps: 66 });
  assert.equal(decisions, 2);
  assert.equal(resourceCalls, 1);
  assert.deepEqual(centralBudgetProjection(final, "budget:domain-contract")!.occupied, { tokens: 67, calls: 66, steps: 66 });
  assert.equal((await resumed.observe(first, domainTestSignal())).outcome, "pending");
  assert.equal((await resumed.observe(second, domainTestSignal())).outcome, "closed_no_result");
}));
