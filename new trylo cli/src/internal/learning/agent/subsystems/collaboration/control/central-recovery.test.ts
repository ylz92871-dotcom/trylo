import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileCollaborationBoard } from "../runtime/board-port.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "./central.js";
import { createCentralCollaborationExecution } from "../../../../../integration/central-learning/collaboration.js";
import { createCollaborationRuntimeReceiptWriter } from "../runtime/receipts/index.js";
import { createCollaborationResearchRecovery } from "../runtime/research-history.js";
import { createCollaborationWorker } from "../orchestration/worker.js";
import { recordCollaborationNoChange } from "../orchestration/no-change-receipt.js";
import { publishCollaborationArtifact } from "../artifacts/publish.js";
import type { CollaborationCentralWorker } from "./contracts.js";
import { buildCollaborationCentralResearchRecord, type CollaborationCentralResearchRequest } from "./central-research-record.js";

const scope = "workspace:collaboration-expired-recovery";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 12_000, maxCalls: 4, maxSteps: 4, maxPromptChars: 10_000 };

async function fixture(t: TestContext, fromResearch = false) {
  const root = await mkdtemp(path.join(tmpdir(), "collaboration-expired-recovery-"));

  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("collaboration-expired-recovery-"));
  await rm(root, { recursive: true, force: true }); });
  let clock = Date.parse("2026-11-05T00:00:00.000Z"), calls = 0;
  const board = createFileCollaborationBoard(root), now = () => new Date(clock).toISOString();
  const worker: CollaborationCentralWorker = { async run() {
    calls += 1;
    return { kind: "completed", resultRefs: [] };
  } };
  const control = createCollaborationControl({ board, now, ownerId: "recovery-owner", worker });
  const read = async () => {
    const loaded = await board.load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => { const result = await board.apply({ type: "coordinate_learning",
    commandId: `central-learning:${contentHashOf(action)}`, issuedAt: now(), action });
  assert.ok(result.ok, JSON.stringify(result));
  return result.state; };
  const operation = { kind: "dispatch" as const, operationId: "operation:original-research", purpose: "Compare original handoff evidence",
    expectedChange: "Explain the missing input contract", sourceRefs: ["evidence:handoff-contract"],
    destination: { plane: "agent" as const, domain: "collaboration" as const }, allowance };
  const research: CollaborationCentralResearchRequest = { schema: "collaboration-central-research-request/v1", scope,
    requestRef: "request:original-research", intentRef: "intent:original-research",
    intent: { intentId: "intent:original-research", subject: { plane: "central", questionRef: "intent:original-research" },
      goal: "Understand missing handoff prerequisites", rationale: "A completed task exposes a reusable coordination question",
      conditions: ["Use actual receipts"], knowledge: [], residual: ["Which prerequisite was omitted?"],
      commitment: { purpose: "Compare actual contracts", assumptions: ["Receipts retain their identity"], reconsiderWhen: ["The contract was already attached"] },
      revisionReason: "Investigate the observed handoff gap", sourceRefs: ["evidence:handoff-contract"],
      derivation: { relation: "Compare repeated prerequisite gaps", whenRelevant: "At dependent handoffs", parentRefs: ["evidence:handoff-contract"],
        citations: [{ evidenceRef: "evidence:handoff-contract", quote: "The exact input contract was omitted" }] }, continuation: { kind: "ready", operation } },
    operation, materials: [{ ref: "evidence:handoff-contract", kind: "source", text: "The exact input contract was omitted", sourceRefs: ["execution:original"] }],
    sourceRefs: ["evidence:handoff-contract"] };
  const fact = fromResearch ? buildCollaborationCentralResearchRecord(research) : undefined;

  if (fromResearch) { assert.ok(fact);
  const saved = await board.apply({ type: "record_reward_v2_fact", commandId: fact.id,
    issuedAt: now(), expectedSequence: (await read()).sequence, fact });
  assert.ok(saved.ok); }

  const reported = await control.report({ scope, problemKey: "handoff-gap", report: { reportId: "report:handoff-gap",
    source: fromResearch ? { kind: "research_request", domain: "collaboration", requestRef: "request:original-research", intentRef: "intent:original-research" }
      : { teamRunId: "team:recovery", taskId: "task:recovery", memberId: "worker" }, facts: ["The downstream owner did not receive the exact input contract."],
    evidenceRefs: ["evidence:handoff-contract", ...(fact === undefined ? [] : [fact.id, research.intentRef])] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "A grounded handoff gap merits bounded research.", sourceRefs: ["report:handoff-gap"] });
  assert.ok(focused.ok);
  await act({ kind: "open_budget", expectedSequence: (await read()).sequence,
    budget: { schemaVersion: 1, budgetId: "budget:collaboration-recovery", scope, unit: "total_model_tokens",
      limits: { tokens: 24_000, calls: 8, steps: 8 }, authorizationRef: "host:recovery-root" } });
  const state = await act({ kind: "fund", domain: "collaboration", issueId: focused.issue.issueId,
    expectedRevision: focused.issue.revision, expectedSequence: (await read()).sequence, grantId: "grant:collaboration-recovery", allowance,
    budgetId: "budget:collaboration-recovery", authorizationRef: "host:recovery-stage", planRef: "plan:recovery-stage" });
  const grant = state.centralLearningGrants![0]!, claimId = "claim:original-crashed";

  await act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId, ownerId: "original-owner",
    expiresAt: new Date(clock + 1000).toISOString() });
  const input = { scope, issueId: grant.issueId, grantId: grant.grantId };
  const reserve = async (known = false) => {
    const reservationId = `collaboration-decision:${claimId}:0`;
    await act({ kind: "reserve", grantId: grant.grantId, claimId, reservationId, maxTokens: 3000 });
    if (known) await act({ kind: "settle", grantId: grant.grantId, reservationId, usage: { kind: "reported", totalTokens: 400 } });
    return reservationId;
  };

  return { root, board, now, control, grant, claimId, input, act, read, reserve,
    expire: () => { clock += 1001; }, calls: () => calls };
}

test("a live collaboration claim remains untouched and cannot be reclassified as recovery", async t => {
  const fx = await fixture(t);
  await fx.reserve();
  const before = await fx.read();
  const result = await fx.control.recoverExpired(fx.input);
  assert.ok(result.ok);
  assert.equal(result.status, "busy");
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(fx.calls(), 0);
  assert.equal(after.centralLearningGrants![0]!.claim?.claimId, fx.claimId);
});

test("an expired zero-reservation research_request source becomes ready without pretending to be a member or buying a model call", async t => {
  const fx = await fixture(t, true);
  fx.expire();
  const execution = createCentralCollaborationExecution({ boardRoot: fx.root, scope, enabled: () => true, control: fx.control });
  const result = await execution.prepare({ issueId: fx.input.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(result.status, "ready", JSON.stringify(result));

  if (result.status === "ready") assert.ok(result.source.domainStage.readiness.evidenceRefs.some(ref => ref.startsWith("collaboration-central-context:")),
    "the truthful research source supplies its complete frozen material without a host context reader");

  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 0);
  assert.equal(state.centralLearningGrants![0]!.claim, undefined);
  assert.equal(state.jobs[0]?.state, "queued");
  assert.equal(fx.calls(), 0);
  const source = state.learningIssues![0]!.reports[0]!.source;

  assert.ok("kind" in source);
  assert.equal(source.kind, "research_request");
});

test("expired sent decisions without confirmed output become inspection and stay blocked after the lease is released", async t => {
  const fx = await fixture(t);
  await fx.reserve();
  fx.expire();
  const execution = createCentralCollaborationExecution({ boardRoot: fx.root, scope, enabled: () => true, control: fx.control });
  const first = await execution.prepare({ issueId: fx.input.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(first.status, "waiting");
  assert.ok("reason" in first);
  assert.equal(first.reason, "collaboration_recovery_sent_step_requires_inspection");
  const paused = await fx.read(), grant = paused.centralLearningGrants![0]!;

  assert.equal(paused.jobs[0]?.state, "queued");
  assert.equal(grant.claim, undefined);
  assert.equal(grant.status, "open");
  assert.deepEqual(grant.reservations[0]?.usage, { kind: "unknown", reason: "previous_claim_expired" });
  assert.equal(centralLearningSpent(grant).tokens, 3000);
  const repeated = await execution.prepare({ issueId: fx.input.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(repeated.status, "waiting");
  assert.ok("reason" in repeated);
  assert.equal(repeated.reason, first.reason);
  assert.equal((await fx.read()).sequence, paused.sequence);
  assert.equal((await fx.control.dispatch({ scope })).ok, false);
  assert.equal(fx.calls(), 0);
  assert.equal((await fx.read()).centralLearningGrants!.length, 1);
});

test("a confirmed legacy dependency return remains free and works through the original dispatch-only facade", async t => {
  const fx = await fixture(t), reservationId = "legacy:confirmed-decision";

  await fx.act({ kind: "reserve", grantId: fx.grant.grantId, claimId: fx.claimId, reservationId, maxTokens: allowance.maxTokens });
  await fx.act({ kind: "settle", grantId: fx.grant.grantId, reservationId, usage: { kind: "reported", totalTokens: allowance.maxTokens } });
  await fx.act({ kind: "finish", jobId: fx.grant.jobId, claimId: fx.claimId, result: { kind: "waiting_dependency", dependencies: [{
    dependencyId: "dependency:legacy-confirmed-return", owner: "expert", correlationRef: "original:confirmed-dependency",
    state: { kind: "ready", resultRef: "expert:existing-configuration", resultVersion: "version:original", evidenceRefs: ["receipt:actual-owner"] } }] } });
  const before = await fx.read();
  const execution = createCentralCollaborationExecution({ boardRoot: fx.root, scope, enabled: () => true,
    control: { dispatch: fx.control.dispatch } });
  const prepared = await execution.prepare({ issueId: fx.input.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  if (prepared.status !== "ready") return;

  assert.deepEqual(prepared.offer.reserve, { tokens: 0, calls: 0, steps: 0 });
  assert.equal((await fx.read()).sequence, before.sequence, "normal ready return does not acquire or release a recovery claim");
  const completed = await execution.dispatch({ issueId: fx.input.issueId, grantId: fx.input.grantId, expectedIssueRevision: before.learningIssues![0]!.revision,
    stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer }, new AbortController().signal);

  assert.ok(completed.ok, JSON.stringify(completed));
  assert.equal(completed.status, "completed");
  assert.equal(fx.calls(), 1);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 1);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: allowance.maxTokens, calls: 1, steps: 1 });
});

test("a paired original query continues real research under the same grant without repeating its resource side effect or refunding unknown usage", async t => {
  const fx = await fixture(t);
  await fx.reserve();
  const action = { kind: "query" as const, owner: "research" as const, query: "Inspect the recorded handoff contract" };
  const requestId = `collaboration-resource:${contentHashOf([fx.claimId, 0, action])}`;
  const base = { schemaVersion: 1 as const, ...fx.input, jobId: fx.grant.jobId, requestId, owner: action.owner, query: action.query,
    recordedAt: fx.now(), boundary: { executionId: "learning:original", taskId: fx.input.issueId, round: 1, role: "collaboration_learning" } };
  const writer = createCollaborationRuntimeReceiptWriter({ board: fx.board, scope });

  assert.ok((await writer.record({ ...base, phase: "resource_query", receiptId: "query:confirmed", resultRefs: [], summary: "Requested actual source" })).ok);
  assert.ok((await writer.record({ ...base, phase: "resource_result", receiptId: "result:confirmed", resultRefs: ["research:actual-contract"],
    summary: "Historical preview of the actual contract; body is not recovered", status: "available" })).ok);
  fx.expire();
  let modelCalls = 0, resourceCalls = 0;
  const worker = createCollaborationWorker({ board: fx.board, scope, now: fx.now, context: async () => ({}),
    recoverResearch: createCollaborationResearchRecovery({ board: fx.board, scope }),
    resources: { async query() {
      resourceCalls += 1;
      throw new Error("The old resource side effect must not be repeated");
    } },
    experienceInput: async () => ({ ok: false, reason: "unexpected_experience" }), publishExperience: async () => ({ ok: false, reason: "unexpected_publication" }),
    model: { async decide(input) {
      modelCalls += 1;
      assert.ok(input.knownSourceRefs?.includes("research:actual-contract"));
      assert.match(JSON.stringify(input.material), /summary_only/);
      const reservationId = `collaboration-decision:${input.claimId}:${input.step}`;
      assert.ok((await input.funding.reserve({ reservationId, maxTokens: 500 })).ok);
      assert.ok((await input.funding.settle({ reservationId, usage: { kind: "reported", totalTokens: 100 } })).ok);
      return { ok: true, action: { kind: "no_change", reason: "The confirmed resource addresses this issue without a new proposal.", sourceRefs: ["research:actual-contract"] } };
    } } });
  const control = createCollaborationControl({ board: fx.board, now: fx.now, ownerId: "resumed-owner", worker });
  const execution = createCentralCollaborationExecution({ boardRoot: fx.root, scope, enabled: () => true, control });
  const prepared = await execution.prepare({ issueId: fx.input.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  const result = await control.dispatch({ scope });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 1);
  assert.equal(resourceCalls, 0);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: 3100, calls: 2, steps: 2 });
  assert.equal(state.collaborationRuntimeReceipts?.length, 2);
});

test("confirmed no_change recovers locally and preserves the unknown original bill without a worker invocation", async t => {
  const fx = await fixture(t);
  await fx.reserve();
  const saved = await recordCollaborationNoChange(fx.board, scope, fx.now(), { schema: "collaboration-no-change/v1",
    issueId: fx.input.issueId, jobId: fx.grant.jobId, grantId: fx.grant.grantId, claimId: fx.claimId,
    reason: "The original confirmed decision requires no replacement plan.", sourceRefs: ["report:handoff-gap"] });
  assert.ok(saved.ok);
  fx.expire();
  const result = await fx.control.recoverExpired(fx.input);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "recovered");
  assert.deepEqual(result.result, { kind: "completed", resultRefs: [saved.receiptId] });
  assert.equal("workAttempted" in result, false);
  assert.equal(fx.calls(), 0);
  const state = await fx.read();
  assert.equal(state.jobs[0]?.state, "succeeded");
  assert.equal(state.centralLearningGrants![0]!.status, "closed");
  assert.equal(centralLearningSpent(state.centralLearningGrants![0]!).tokens, 3000);
});

test("a committed plan restores its original dependency wait locally without authorizing or rebuilding the capability", async t => {
  const fx = await fixture(t);
  await fx.reserve(true);
  const plan = { schema: "collaboration-plan/v1" as const, issueId: fx.input.issueId, focusRevision: fx.grant.focusRevision,
    familyId: "handoff-owner", title: "Preserve the exact handoff contract", summary: "An explicit owner needs the missing capability.",
    sourceRefs: ["report:handoff-gap"], adjustments: [{ memberId: "worker", kind: "handoff" as const, instruction: "Attach the exact input contract." }],
    experienceVersionIds: [], needs: [{ owner: "expert" as const, memberId: "worker", instruction: "An expert for the actual missing contract is required." }] };
  const published = await publishCollaborationArtifact({ board: fx.board, scope, now: fx.now }, { issueId: plan.issueId,
    familyId: plan.familyId, title: plan.title, hypothesis: plan.summary, sourceRefs: plan.sourceRefs, content: plan, schemaVersion: 3, kind: "plan" });
  assert.ok(published.ok);
  fx.expire();
  const recovered = await fx.control.recoverExpired(fx.input);
  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.result?.kind, "waiting_dependency");
  assert.equal(fx.calls(), 0);
  const state = await fx.read();
  assert.equal(state.jobs[0]?.state, "waiting_evidence");
  assert.equal(state.centralLearningGrants![0]!.status, "open");
  assert.equal(state.learningDependencies?.[0]?.dependencyId, `collaboration-dependency:${contentHashOf([fx.grant.jobId, published.versionId, 0])}`);
  assert.equal(state.learningDependencies?.[0]?.state.kind, "waiting");
});

test("recovery finish refuses a refocus racing after its final read instead of completing the old focus", async t => {
  const fx = await fixture(t);
  await fx.reserve(true);
  const saved = await recordCollaborationNoChange(fx.board, scope, fx.now(), { schema: "collaboration-no-change/v1",
    issueId: fx.input.issueId, jobId: fx.grant.jobId, grantId: fx.grant.grantId, claimId: fx.claimId,
    reason: "The old focus had no remaining proposal.", sourceRefs: ["report:handoff-gap"] });
  assert.ok(saved.ok);
  fx.expire();
  let raced = false;
  const board: Pick<BoardStore, "load" | "apply"> = { load: fx.board.load, async apply(command) {
    if (!raced && command.type === "coordinate_learning" && command.action.kind === "finish") {
      raced = true;
      const current = (await fx.read()).learningIssues![0]!;
      await fx.act({ kind: "decide", issueId: current.issueId, expectedRevision: current.revision,
        decision: "focused_learning", reason: "A new focus supersedes the recovery's exact issue revision.", sourceRefs: ["report:handoff-gap"] });
    }
    return fx.board.apply(command);
  } };
  const control = createCollaborationControl({ board, now: fx.now, ownerId: "racing-recovery-owner" });
  const result = await control.recoverExpired(fx.input);
  assert.ok(!result.ok);
  assert.equal(result.reason, "learning_claim_conflict");
  assert.equal(raced, true);
  const state = await fx.read();
  assert.equal(state.jobs[0]?.state, "running");
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.centralLearningGrants![0]!.status, "open");
  assert.ok(state.learningIssues![0]!.decision.kind === "focused_learning");
  assert.equal(state.jobs[0]?.coordination?.resultRefs, undefined);
  assert.equal(fx.calls(), 0);
});
