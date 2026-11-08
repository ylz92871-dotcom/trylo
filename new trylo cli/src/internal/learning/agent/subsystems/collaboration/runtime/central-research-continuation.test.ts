import assert from "node:assert/strict";
import test from "node:test";
import { createCollaborationControl } from "../control/central.js";
import { createFileCollaborationBoard } from "./board-port.js";
import { createCollaborationRuntimeReceiptWriter } from "./receipts/index.js";
import { readCollaborationResearchContinuation } from "./central-research-continuation.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createCentralCollaborationExecution } from "../../../../../integration/central-learning/collaboration.js";
import { centralCandidateForStage } from "../../../../../integration/central-learning/candidates.js";
import { retainFrozenStage } from "../../../../../integration/central-learning/stage-evidence.js";
import type { CentralFundedStage, CentralStagePreparation } from "../../../../../integration/central-learning/contracts.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainTestSignal, withDomainBoard } from "../../../../../integration/central-learning/testing/domain-funding.test.js";

test("original writer continuation accepts confirmed query content without refunding unknown usage, waits on exact repetition and inspects an unconfirmed unknown step", async () => withDomainBoard(async fx => {
  const scope = DOMAIN_TEST_SCOPE, board = createFileCollaborationBoard(fx.boardRoot), receipts = createCollaborationRuntimeReceiptWriter({ board, scope });
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 6000, maxCalls: 4, maxSteps: 4, maxPromptChars: 40_000 };
  const operationAllowance = { ...allowance, maxTokens: 1000, maxCalls: 1, maxSteps: 1 };
  let actions = 0;
  const control = createCollaborationControl({ board, now: () => DOMAIN_TEST_NOW, ownerId: "original-continuing-researcher", worker: { async run(input) {
    actions += 1;
    const reservationId = `collaboration-decision:${input.claimId}:0`;
    const reserved = await input.funding.reserve({ reservationId, maxTokens: 1000 });
    assert.ok(reserved.ok);
    assert.ok((await input.funding.settle({ reservationId, usage: actions === 2 ? { kind: "reported", totalTokens: 100 }
      : { kind: "unknown", reason: actions === 1 ? "billing_tail_missing_confirmed_content" : "response_missing" } })).ok);

    if (actions < 3) {
      const action = { kind: "query" as const, owner: "research" as const, query: "Inspect the actual original prerequisite" };
      const base = { schemaVersion: 1 as const, scope, issueId: input.issue.issueId, jobId: input.jobId, grantId: input.grantId,
        requestId: `collaboration-resource:${contentHashOf([input.claimId, 0, action])}`, owner: action.owner, query: action.query, recordedAt: DOMAIN_TEST_NOW,
        boundary: { executionId: `execution:segment:${actions}`, taskId: input.issue.issueId, round: 1, role: "collaboration_learning" } };

      assert.ok((await receipts.record({ ...base, phase: "resource_query", receiptId: `query:${actions}`, resultRefs: [], summary: "Requested the actual source" })).ok);
      assert.ok((await receipts.record({ ...base, phase: "resource_result", receiptId: `result:${actions}`,
        resultRefs: actions === 1 ? ["source:a", "source:b"] : ["source:b", "source:a"], status: "available", summary: "The exact original prerequisite is visible" })).ok);
    }

    return { kind: "yielded", reason: "original_explicit_segment_handoff" };
  } } });
  const reported = await control.report({ scope, problemKey: "original-prerequisite", report: { reportId: "report:original-prerequisite",
    source: { teamRunId: "team:original", taskId: "task:original", memberId: "personal_agent" }, facts: ["The dependent owner lacks its exact prerequisite"], evidenceRefs: ["execution:original"] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision, decision: "focused_learning",
    reason: "Investigate the exact original prerequisite", sourceRefs: ["report:original-prerequisite"] });
  assert.ok(focused.ok);
  const execution = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope, enabled: () => true, control });
  const first = await execution.prepare({ issueId: reported.issue.issueId, authorizedAllowance: allowance, operationAllowance }, domainTestSignal());
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;

  await fx.act({ kind: "fund", domain: "collaboration", issueId: reported.issue.issueId, expectedRevision: focused.issue.revision,
    expectedSequence: (await fx.load()).sequence, grantId: first.source.grantId, allowance, budgetId: "budget:domain-contract",
    authorizationRef: "host:original-research", planRef: "plan:original-research" });
  const freeze = async (prepared: CentralStagePreparation) => {
    assert.equal(prepared.status, "ready", JSON.stringify(prepared));
    if (prepared.status !== "ready") throw new Error("Original stage unavailable");

    const input: CentralFundedStage = { issueId: reported.issue.issueId, grantId: first.source.grantId,
      expectedIssueRevision: (await fx.load()).learningIssues![0]!.revision, stageRef: prepared.stageRef, policyRef: prepared.policyRef,
      sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
    const retained = await retainFrozenStage({ boardRoot: fx.boardRoot, input, candidate: centralCandidateForStage({ scope,
      issueId: input.issueId, domain: "collaboration", stage: prepared, nowMs: Date.parse(DOMAIN_TEST_NOW), budgetId: "budget:domain-contract" }) });

    assert.equal(retained.status, "retained", JSON.stringify(retained));
    if (retained.status !== "retained") throw new Error("Original assignment was not frozen");

    return retained.value;
  };
  const originalStage = await freeze(first);
  const dispatch = async () => { const result = await control.dispatch({ scope, issueId: reported.issue.issueId, grantId: first.source.grantId, operationAllowance });
    assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "idle"); };

  await dispatch();
  const continuation = async (lastStage = originalStage) => readCollaborationResearchContinuation({ board: await fx.load(), scope,
    issueId: reported.issue.issueId, grantId: first.source.grantId, programRef: lastStage.input.policyRef, lastStage }, domainTestSignal());
  const novel = await continuation();
  assert.equal(novel.kind, "continuable");
  if (novel.kind === "continuable") assert.equal(novel.cursorRef, "result:1");

  assert.deepEqual(centralLearningSpent((await fx.load()).centralLearningGrants![0]!), { tokens: 1000, calls: 1, steps: 1 });
  const next = await execution.prepare({ issueId: reported.issue.issueId, authorizedAllowance: allowance, operationAllowance }, domainTestSignal());

  assert.equal(next.status, "ready");
  if (next.status === "ready") assert.ok(next.source.domainStage.readiness.evidenceRefs.includes("result:1"));

  const nextStage = await freeze(next);
  assert.equal((await continuation(nextStage)).kind, "waiting", "an actual captured cursor cannot be assigned twice");
  await dispatch();
  const repeated = await continuation(nextStage);
  assert.equal(repeated.kind, "waiting");

  if (repeated.kind === "waiting") assert.equal(repeated.reason, "collaboration_continuation_result_already_observed");

  // This explicit original-owner call supplies a new action; the continuation
  // reader above did not authorize repeating or refunding the observed result.
  await dispatch();
  const unknown = await continuation(nextStage);
  assert.equal(unknown.kind, "inspection");
  const final = await fx.load();
  assert.equal(final.centralLearningGrants!.length, 1);
  assert.equal(final.centralLearningGrants![0]!.status, "open");
  assert.deepEqual(centralLearningSpent(final.centralLearningGrants![0]!), { tokens: 2100, calls: 3, steps: 3 });
  assert.equal(final.collaborationRuntimeReceipts?.length, 4);
  assert.equal(actions, 3);
}));
