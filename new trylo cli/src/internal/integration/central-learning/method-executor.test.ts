import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { emptyUsage, type ProviderPort } from "../../ports/provider.js";
import type { CentralLearningAllowance, CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createLearningAllocationApplication } from "../learning-allocation/application.js";
import { createMethodBoardWriter } from "../../learning/agent/subsystems/method/adapters/board-writer.js";
import { createExperienceStore } from "../../learning/agent/subsystems/method/adapters/experience-store.js";
import { createExperienceRuntime } from "../../learning/agent/subsystems/method/orchestration/experience-runtime.js";
import { nicheOf } from "../../learning/agent/subsystems/method/domain/niche.js";
import type { MethodCard } from "../../learning/agent/subsystems/method/domain/contracts.js";
import type { ExperienceContext, ExperienceReviewRequest } from "../../learning/agent/subsystems/method/experience-port.js";
import { procedureFixture } from "../../learning/agent/subsystems/method/testing/procedure-fixture.js";
import { createCentralMethodExecutor } from "./method-executor.js";
import type { CentralFundedStage, CentralStagePreparation } from "./contracts.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import { readMethodCentralFeedback } from "../../learning/agent/subsystems/method/adapters/index.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { createCentralLearningHost } from "./host.js";
import { prepareCentralCandidates } from "./candidates.js";
import { readFrozenStage, refreshFrozenStageObservation, retainFrozenStage } from "./stage-evidence.js";
import { recordCentralStageObservation } from "./observations.js";
import { buildCentralPursuitQualificationRevisionDraft } from "../learning-allocation/pursuit-revision.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";

const at = "2026-11-04T13:00:00.000Z", scope = "workspace:central-method", versionId = "method:central-source";
// Fixed test authorization and scripted responses are not measured utility or provider acceptance.
const authorized: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 24000,
  maxCalls: 4, maxSteps: 4, maxPromptChars: 12000 };
const card: MethodCard = { schemaVersion: 1,
  hint: "Read the complete structured document and verify its declared schema before editing any payload.",
  appliesWhen: { tools: ["read_file"] }, labels: ["containment"], family: "containment",
  lineage: { createdFrom: { turnId: "source-task", beat: 1, reason: "containment" } } };
const context = (taskId: string): ExperienceContext => ({ taskId, opportunityId: "schema-edit",
  situation: "Edit a JSON document with its declared schema", features: { format: "json" } });

async function fixture(t: TestContext, response: "promote" | "defer" | "invalid" | "cancel" = "promote", contextForIssue?: CentralLearningContextReader,
  modelRef?: string, controls: { readonly claimReview?: () => boolean; readonly now?: () => string } = {}) {
  const parent = testScratchPath("central-method-executor-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  const writer = createMethodBoardWriter(root), store = createExperienceStore(root, () => at);
  const saved = await writer.commitCard({ card, versionId, nicheId: nicheOf(card), proposalId: "proposal:method-source",
    evidenceId: "evidence:method-source", writeId: "seed:method-source", sample: "schema editing", observedAt: at });

  assert.ok(saved.ok);
  await store.append(current => ({ kind: "scope", factId: "scope:method-source", versionId, sequence: current.sequence + 1,
    description: "JSON schema editing", hypothesis: { id: "range:method-source", versionId, scopeId: "json",
      proposedSequence: current.sequence, predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } }));
  const runtime = createExperienceRuntime({ store, emit: () => {}, correct: async () => {}, revise: async () => {} });

  for (let index = 0; index < 10; index += 1) {
    const taskId = `source-use:${index}`, selected = await runtime.context(context(taskId));

    assert.ok(selected.some(item => item.versionId === versionId));
    const delivery = await runtime.slot(taskId);
    assert.ok(delivery);
    const receipt = delivery.receipts.find(item => item.versionId === versionId);
    assert.ok(receipt);
    const exposureId = `exposure:${index}`;

    assert.ok((await writer.recordUse({ writeId: exposureId, exposureId, versionId, proposalId: "proposal:method-source",
      turnId: taskId, beat: 1, requestId: `request:${index}`, scope: "json", observedAt: at,
      ...(receipt.binding === undefined ? {} : { binding: receipt.binding }) })).ok);
    await runtime.decide({ versionId, scopeId: "json", action: "adopt", reason: "Apply the supplied method before editing" });
    assert.ok((await writer.recordFeedback({ writeId: `feedback:${index}`, exposureId, versionId, turnId: taskId,
      helped: true, context: context(taskId), observedAt: at })).ok);
  }

  let serial = 0, calls = 0;
  const supplied: ExperienceReviewRequest[] = [];
  const requestedModels: string[] = [];
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, board => board.apply({ type: "coordinate_learning", commandId: `test-coordinate:${++serial}`,
      issuedAt: at, action }));
    assert.ok(result.ok);
    return result.state;
  };

  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "root:method", scope,
    unit: "total_model_tokens", limits: { tokens: 50000, calls: 8, steps: 8 }, authorizationRef: "test:independent-root-authorization" } });
  const controller = new AbortController();
  const child: ProviderPort = { async *stream(request) {
    calls += 1;
    requestedModels.push(request.model);
    const material = JSON.parse(request.messages.find(item => item.role === "user")!.content) as ExperienceReviewRequest;

    supplied.push(material);
    yield { type: "stream_start", providerId: "scripted-contract", model: request.model, warnings: [] };

    if (response === "cancel") {
      controller.abort();
      yield { type: "cancel_ack" };
      return;
    }

    yield { type: "text_delta", blockId: "review", text: response === "invalid" ? "INVALID JSON" : JSON.stringify({
      decision: response, score: .93, reason: "Scripted contract output from the actual supplied source observations.", sources: [material.versionId],
      ...(response === "promote" ? { compact: { when: `${material.scope.scopeId.toUpperCase()} document`, action: "Validate schema, then edit.", exceptions: "Unknown schema: inspect first." },
        procedure: procedureFixture(material, "Validate schema, then edit.") } : {}),
    }) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 30, totalTokens: 150 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const options = { boardRoot: root, workspaceId: "legacy:method-workspace", scope, turnId: "central-method-task",
    provider: { stream: child.stream, fork: () => child }, model: "scripted-contract", now: controls.now ?? (() => at),
    emit: () => {}, authorized: () => true, ...(contextForIssue === undefined ? {} : { contextForIssue }),
    ...(modelRef === undefined ? {} : { modelRef }), ...(controls.claimReview === undefined ? {} : { claimReview: controls.claimReview }) };
  const executor = createCentralMethodExecutor(options);
  const nominateAndFocus = async () => {
    const ids = await executor.nominate!(controller.signal);
    assert.equal(ids.length, 1);
    const before = await load(), issue = before.learningIssues!.find(item => item.issueId === ids[0])!;

    assert.equal(issue.decision.kind, "unreviewed", "nomination leaves the PA decision untouched");
    assert.equal(before.centralLearningGrants?.length ?? 0, 0);
    assert.equal(calls, 0);
    await act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
      reason: "TEST PA focuses the actual qualified source", sourceRefs: issue.reports[0]!.evidenceRefs });
    const prepared = await executor.prepare({ issueId: issue.issueId, authorizedAllowance: authorized }, controller.signal);

    assert.ok(prepared.status === "ready", JSON.stringify(prepared));
    assert.equal(prepared.policyFamily?.response, "shared_or_exact_treatment");
    assert.equal(prepared.policyFamily?.sourceRef, prepared.policyFamily?.ref);

    if (modelRef === undefined || modelRef === options.model) assert.equal(prepared.policyFamily?.ref, prepared.policyRef);

    return prepared;
  };
  const fund = async (prepared: Extract<CentralStagePreparation, { status: "ready" }>): Promise<CentralFundedStage> => {
    const state = await load(), issue = state.learningIssues!.find(item => item.issueId === prepared.source.issueId)!;
    const app = createLearningAllocationApplication({ boardRoot: root, now: () => at, enabled: () => true });
    const committed = await app.commit({ kind: "portfolio", authorizationRef: "test:independent-stage-authorization",
      proposalJson: JSON.stringify({ schemaVersion: 1, basis: { scope, boardSequence: state.sequence, budgetId: "root:method",
        utilityUnit: "test-only-proposal-delivery", valuationRef: "test-only-fixed-comparison" }, unit: "total_model_tokens", domainRelation: "separable",
        budget: { tokens: 50000, calls: 8, steps: 8 }, groups: [{ owner: prepared.offer.owner, tiers: [{ quota: 1, netValue: .1, offer: prepared.offer }] }] }),
      bindingsJson: JSON.stringify([{ offerId: prepared.offer.offerId, offerHash: contentHashOf(prepared.offer), policyRef: prepared.policyRef,
        sourceBindingRef: prepared.source.sourceBindingRef, authorizedAllowance: authorized, issueId: issue.issueId,
        expectedIssueRevision: issue.revision, grantId: prepared.source.grantId, mode: "fund", chargedAtBasis: { tokens: 0, calls: 0, steps: 0 } }]) });

    assert.equal(committed.status, "committed");
    const after = await load();

    return { issueId: issue.issueId, grantId: prepared.source.grantId, expectedIssueRevision: after.learningIssues!.find(item => item.issueId === issue.issueId)!.revision,
      stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  };

  return { root, load, act, executor, options, runtime, writer, controller, nominateAndFocus, fund, supplied, requestedModels, calls: () => calls };
}

test("central method nomination, actual allocation and real review produce a next-task compiled consumer", async t => {
  const f = await fixture(t), prepared = await f.nominateAndFocus();
  const cumulative = { ...authorized, maxCalls: 1000, maxSteps: 1000 };
  const bounded = await f.executor.prepare({ issueId: prepared.source.issueId, authorizedAllowance: cumulative,
    operationAllowance: { ...authorized, maxCalls: 1, maxSteps: 1 } }, f.controller.signal);

  assert.equal(bounded.status, "ready", JSON.stringify(bounded));

  if (bounded.status === "ready") assert.deepEqual([bounded.offer.reserve.calls, bounded.offer.reserve.steps], [1, 1]);

  const unbounded = await f.executor.prepare({ issueId: prepared.source.issueId, authorizedAllowance: cumulative }, f.controller.signal);

  assert.equal(unbounded.status, "unavailable", "a cumulative ceiling alone cannot become a legacy operation");
  const beforeFunding = await readMethodCentralFeedback({ boardRoot: f.root, scope, issueId: prepared.source.issueId });
  const funded = await f.fund(prepared);

  assert.deepEqual(await readMethodCentralFeedback({ boardRoot: f.root, scope, issueId: funded.issueId }), beforeFunding,
    "committing a financial allowance is not new semantic source evidence");
  const result = await f.executor.dispatch(funded, f.controller.signal);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(f.calls(), 1);
  const state = await f.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(grant.grantId, funded.grantId);
  assert.equal(grant.status, "open");
  assert.equal(grant.claim, undefined);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 150, calls: 1, steps: 1 });
  assert.equal(state.activations.length, 0, "a review does not bypass the original activation owner");
  const observation = await createCentralMethodExecutor(f.options).observe(funded, new AbortController().signal);

  assert.equal(observation.outcome, "qualified");
  assert.ok(observation.resultRefs.length > 0);
  const next = await f.runtime.context(context("later-task"));

  assert.ok(next.some(item => observation.resultRefs.includes(item.compilationId) && item.compact.includes("Validate schema")));
  const repeated = await f.executor.dispatch(funded, new AbortController().signal);

  assert.equal(repeated.ok, false);
  assert.equal(f.calls(), 1, "the same frozen snapshot is not bought twice");
});

test("the common host consumes actual method sources, timing and posterior planning, then records and reconciles their original work", async t => {
  const f = await fixture(t), signal = f.controller.signal;
  const store = createExperienceStore(f.root, () => at);
  const secondVersionId = "method:independent-json-source", secondProposalId = "proposal:independent-json-source";
  const secondCard: MethodCard = { ...card,
    hint: "Check required JSON fields against their schema and preserve unrelated values while editing." };

  assert.ok((await f.writer.commitCard({ card: secondCard, versionId: secondVersionId, nicheId: nicheOf(secondCard), proposalId: secondProposalId,
    evidenceId: "evidence:independent-json-source", writeId: "seed:independent-json-source", sample: "JSON field editing", observedAt: at })).ok);
  await store.append(current => ({ kind: "scope", factId: "scope:independent-json-source", versionId: secondVersionId, sequence: current.sequence + 1,
    description: "JSON document schema editing", hypothesis: { id: "range:independent-json-source", versionId: secondVersionId, scopeId: "json",
      proposedSequence: current.sequence, predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } }));

  // A second independent method is actually trialed in the same registered
  // feature class. This does not transfer a JSON response into YAML or assert
  // an economic treatment effect from either source's helpfulness testimony.
  for (let index = 0; index < 10; index += 1) {
    const taskId = `independent-json-use:${index}`, input = context(taskId);
    const selected = await f.runtime.context(input, { versionId: secondVersionId, scopeId: "json" });

    assert.ok(selected.some(row => row.versionId === secondVersionId && row.scopeId === "json"));
    const delivery = await f.runtime.slot(taskId);
    assert.ok(delivery);
    const receipt = delivery.receipts.find(row => row.versionId === secondVersionId);
    assert.ok(receipt?.binding);
    assert.ok((await f.writer.recordUse({ writeId: taskId, exposureId: taskId, versionId: secondVersionId, proposalId: secondProposalId,
      turnId: taskId, beat: 1, requestId: `independent-json-request:${index}`, scope: "json", binding: receipt.binding, observedAt: at })).ok);
    await f.runtime.decide({ versionId: secondVersionId, scopeId: "json", action: "adopt", reason: "TEST applies this independent source method" });
    assert.ok((await f.writer.recordFeedback({ writeId: `independent-json-feedback:${index}`, exposureId: taskId, versionId: secondVersionId,
      turnId: taskId, helped: true, observedAt: at })).ok);
  }

  const control = createCollaborationControl({ board: createFileCollaborationBoard(f.root), now: () => at,
    ownerId: "test:common-host-pa", enabled: () => true });
  const rootAllowance: CentralLearningAllowance = { ...authorized, maxTokens: 50000, maxCalls: 8, maxSteps: 8 };
  const host = createCentralLearningHost({ boardRoot: f.root, scope, allowance: rootAllowance,
    authorizationRef: "test:independent-root-authorization", now: () => at, enabled: () => true,
    ports: [f.executor], control });
  const issueIds = await host.nominate(signal);
  assert.equal(issueIds.length, 2);
  assert.equal(f.calls(), 0);

  for (const issueId of issueIds) {
    const issue = (await f.load()).learningIssues!.find(row => row.issueId === issueId)!;
    assert.equal(issue.decision.kind, "unreviewed");
    assert.ok((await host.focusIssue({ issueId, expectedRevision: issue.revision,
      reason: "TEST PA selects real qualified method conditions", sourceRefs: issue.reports[0]!.evidenceRefs }, signal)).ok);
  }

  const jsonIssue = (await f.load()).learningIssues!.find(row => row.reports.some(report => "versionId" in report.source
    && report.source.versionId === versionId && report.facts.includes("scope:json")))!;
  const first = await host.run(signal, jsonIssue.issueId);

  assert.equal(first.status, "dispatched", JSON.stringify(first));
  if (first.status !== "dispatched") assert.fail("common host did not dispatch");

  assert.equal(first.decision.mode, "stage_objective_pursuit");
  assert.equal(first.decision.nextStep.kind, "fund_and_dispatch");
  assert.ok(first.result.ok);
  assert.equal(first.observation.outcome, "qualified");

  if (first.result.ok) assert.equal(first.result.status, "completed");

  if (first.decision.mode !== "stage_objective_pursuit") assert.fail("fixture has no registered economic response comparison");

  const firstEvaluation = first.decision.valuation.evaluations.find(row => row.candidate.source.issueId === jsonIssue.issueId)!;

  assert.equal(firstEvaluation.prediction.support, "reference_prior");
  assert.equal(firstEvaluation.prediction.mean, .5);
  assert.equal(firstEvaluation.timing?.status, "ready");

  if (firstEvaluation.timing?.status === "ready") assert.equal(firstEvaluation.timing.selectedControl, "now");

  assert.ok(first.decision.valuation.plan, "the original sequential allocator produced the actual committed first stage");
  assert.equal(f.calls(), 1);
  const afterFirst = await f.load(), firstGrant = afterFirst.centralLearningGrants!.find(row => row.grantId === first.input.grantId)!;

  assert.deepEqual(centralLearningSpent(firstGrant), { tokens: 150, calls: 1, steps: 1 });
  assert.deepEqual({ tokens: firstGrant.allowance.maxTokens, calls: firstGrant.allowance.maxCalls, steps: firstGrant.allowance.maxSteps },
    { tokens: 150, calls: 1, steps: 1 }, "host reconciles only after the original worker has settled and yielded");
  assert.equal(firstGrant.claim, undefined);
  assert.equal(firstGrant.reservations[0]!.usage?.kind, "reported");
  assert.deepEqual(centralBudgetProjection(afterFirst, "root:method")?.available, { tokens: 49850, calls: 7, steps: 7 });
  const history = readCentralPursuitObservations(afterFirst, scope);
  assert.equal(history.status, "ready");

  if (history.status !== "ready") assert.fail("host observation was not admitted to original Board");

  assert.equal(history.observations.length, 1);
  assert.equal(history.observations[0]!.grantId, first.input.grantId);
  assert.equal(history.observations[0]!.outcome, "qualified");
  assert.ok(first.observation.resultRefs.includes(history.observations[0]!.sourceRef));

  // Re-entering the actual host cannot buy the unchanged JSON snapshot. Its
  // next original source is the other method in the same feature class.
  const second = await host.run(signal, jsonIssue.issueId);

  assert.equal(second.status, "dispatched", JSON.stringify(second));
  if (second.status !== "dispatched") assert.fail("second actual source was not dispatched");

  assert.notEqual(second.input.issueId, first.input.issueId);
  assert.notEqual(second.input.grantId, first.input.grantId);
  assert.equal(second.decision.mode, "stage_objective_pursuit");

  if (second.decision.mode !== "stage_objective_pursuit") assert.fail("unexpected economic comparison");

  const updated = second.decision.valuation.evaluations.find(row => row.candidate.source.issueId === second.input.issueId)!;

  assert.equal(updated.candidate.opportunity.conditionRef, firstEvaluation.candidate.opportunity.conditionRef);
  assert.equal(updated.prediction.support, "updated_reference_model");
  assert.equal(updated.prediction.qualified, 1);
  assert.ok(updated.prediction.mean > firstEvaluation.prediction.mean && updated.prediction.mean < 1,
    "the actual positive head updates the reference forecast, with transfer controlled by the declared resource model");
  assert.ok(updated.prediction.sourceRefs.includes(history.observations[0]!.sourceRef));
  assert.equal(updated.timing?.status, "ready");
  assert.equal(f.calls(), 2);
  const afterSecond = await f.load();

  assert.equal(afterSecond.centralLearningGrants!.find(row => row.grantId === first.input.grantId)!.reservations.length, 1);
  assert.deepEqual(centralBudgetProjection(afterSecond, "root:method")?.available, { tokens: 49700, calls: 6, steps: 6 });

  const taskId = "host-real-follow-up", selected = await f.runtime.context(context(taskId));

  assert.ok(selected.some(row => row.compilationId === first.observation.resultRefs[0]));
  const delivery = await f.runtime.slot(taskId);
  assert.ok(delivery);
  const receipt = delivery.receipts.find(row => row.versionId === versionId);
  assert.ok(receipt?.binding);
  assert.ok((await f.writer.recordUse({ writeId: taskId, exposureId: taskId, versionId, proposalId: "proposal:method-source",
    turnId: taskId, beat: 1, requestId: taskId, scope: "json", binding: receipt.binding, observedAt: at })).ok);
  await f.runtime.decide({ versionId, scopeId: "json", action: "adopt", reason: "TEST next consumer uses the source-bound compiled method" });
  assert.ok((await f.writer.recordFeedback({ writeId: `${taskId}:negative`, exposureId: taskId, versionId,
    turnId: taskId, helped: false, observedAt: at })).ok);
  const continuation = await host.run(signal, jsonIssue.issueId);
  if (continuation.status === "dispatched") {
    assert.equal(continuation.input.grantId, first.input.grantId);
    assert.notEqual(continuation.input.stageRef, first.input.stageRef);
    assert.equal(continuation.candidate.opportunity.stage, "continuation");
  } else {
    assert.ok(continuation.status === "wait" || continuation.status === "stop" || continuation.status === "defer", JSON.stringify(continuation));
    assert.ok(continuation.unavailable?.some(row => row.issueId === jsonIssue.issueId), "a non-executable real source exposes its domain wait reason");
  }

  assert.equal((await f.load()).centralLearningBudgets!.length, 1);
});

test("the common host retains an unclaimed method stage and an explicit later-clock resume executes its original grant once", async t => {
  let allowClaim = false, nowMs = Date.parse(at);
  const now = () => new Date(nowMs).toISOString();
  const f = await fixture(t, "promote", undefined, undefined, { claimReview: () => allowClaim, now }), signal = f.controller.signal;
  const control = createCollaborationControl({ board: createFileCollaborationBoard(f.root), now,
    ownerId: "test:unclaimed-method-host", enabled: () => true });
  const host = createCentralLearningHost({ boardRoot: f.root, scope,
    allowance: { ...authorized, maxTokens: 50000, maxCalls: 8, maxSteps: 8 },
    authorizationRef: "test:independent-root-authorization", now, enabled: () => true, ports: [f.executor], control });
  const issueIds = await host.nominate(signal);
  assert.equal(issueIds.length, 1);
  const issue = (await f.load()).learningIssues!.find(row => row.issueId === issueIds[0])!;

  assert.ok((await host.focusIssue({ issueId: issue.issueId, expectedRevision: issue.revision,
    reason: "TEST explicitly focuses this actual method source", sourceRefs: issue.reports[0]!.evidenceRefs }, signal)).ok);
  const first = await host.run(signal, issue.issueId);

  assert.equal(first.status, "dispatched", JSON.stringify(first));
  if (first.status !== "dispatched") assert.fail("source was not funded");

  assert.equal(first.decision.nextStep.kind, "fund_and_dispatch");
  assert.ok(first.result.ok);

  if (first.result.ok) assert.equal(first.result.status, "idle");

  assert.equal(first.result.workAttempted, undefined);
  assert.equal(first.observation.outcome, "pending");
  assert.deepEqual(first.settlement, { status: "retained", reason: "worker_attempt_not_confirmed" });
  assert.equal(f.calls(), 0);
  const afterGate = await f.load(), originalGrant = afterGate.centralLearningGrants!.find(row => row.grantId === first.input.grantId)!;

  assert.equal(originalGrant.status, "open");
  assert.equal(originalGrant.claim, undefined);
  assert.equal(originalGrant.reservations.length, 0);
  assert.equal(afterGate.jobs.find(row => row.jobId === originalGrant.jobId)?.attempt, 0);
  assert.equal(afterGate.jobs.find(row => row.jobId === originalGrant.jobId)?.state, "queued");
  assert.deepEqual(centralLearningSpent(originalGrant), { tokens: 0, calls: 0, steps: 0 });
  assert.deepEqual(centralBudgetProjection(afterGate, "root:method")?.occupied, first.input.offer.reserve,
    "the unexecuted initial stage keeps the same canonical commitment");
  const address = { boardRoot: f.root, scope, grantId: first.input.grantId, stageRef: first.input.stageRef };
  const frozen = await readFrozenStage(address);
  assert.equal(frozen.status, "ready");
  const pending = readCentralPursuitObservations(afterGate, scope);
  assert.equal(pending.status, "ready");

  if (pending.status === "ready") {
    assert.equal(pending.observations.length, 1);
    assert.equal(pending.observations[0]!.outcome, "pending");
  }

  allowClaim = true;
  nowMs += 1000;
  const resumed = await host.run(signal, issue.issueId);

  assert.equal(resumed.status, "dispatched", JSON.stringify(resumed));
  if (resumed.status !== "dispatched") assert.fail("explicit resume did not dispatch");

  assert.equal(resumed.decision.nextStep.kind, "dispatch_existing");
  assert.ok(resumed.result.ok);

  if (resumed.result.ok) assert.equal(resumed.result.status, "completed");

  assert.equal(resumed.result.workAttempted, true);
  assert.equal(resumed.observation.outcome, "qualified");
  assert.equal(resumed.input.grantId, first.input.grantId);
  assert.equal(resumed.input.stageRef, first.input.stageRef);
  assert.equal(resumed.input.sourceBindingRef, first.input.sourceBindingRef);
  assert.equal(f.calls(), 1);
  const after = await f.load(), grant = after.centralLearningGrants!.find(row => row.grantId === first.input.grantId)!;

  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(grant.reservations.length, 1);
  assert.equal(grant.claim, undefined);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 150, calls: 1, steps: 1 });
  assert.deepEqual(centralBudgetProjection(after, "root:method")?.available, { tokens: 49850, calls: 7, steps: 7 });
  assert.deepEqual(await readFrozenStage(address), frozen, "the original assignment clock and source prefix remain immutable");
  const observed = readCentralPursuitObservations(after, scope);
  assert.equal(observed.status, "ready");

  if (observed.status === "ready" && pending.status === "ready") {
    assert.equal(observed.observations.length, 1);
    assert.equal(observed.observations[0]!.outcome, "qualified");
    assert.equal(observed.observations[0]!.unitId, pending.observations[0]!.unitId);
  }
});

test("a complete defer closes without a proposal, while failed or cancelled method calls remain pending", async t => {
  for (const response of ["defer", "invalid", "cancel"] as const) {
    const f = await fixture(t, response), funded = await f.fund(await f.nominateAndFocus());
    await f.executor.dispatch(funded, f.controller.signal);
    const observation = await f.executor.observe(funded, new AbortController().signal);
    assert.equal(observation.outcome, response === "defer" ? "closed_no_result" : "pending");
    assert.equal(f.calls(), 1);
    assert.equal((await f.load()).centralLearningGrants![0]!.status, "open");
  }
});

test("a frozen pending stage is refreshed from its actual original method receipt and a final delivery head is preserved", async t => {
  const f = await fixture(t), funded = await f.fund(await f.nominateAndFocus()), board = await f.load();
  const preparation = await prepareCentralCandidates({ board, scope, ports: [f.executor], allowance: authorized,
    nowMs: Date.parse(at), basis: { scope, budgetId: "root:method", boardSequence: board.sequence,
      utilityUnit: "qualified_objective_completions", valuationRef: "test:actual-method-stage" } }, f.controller.signal);
  const candidate = preparation.prepared[0]?.candidate;
  assert.ok(candidate);
  assert.equal(candidate.source.domainStage.stageRef, funded.stageRef);
  const retained = await retainFrozenStage({ boardRoot: f.root, candidate, input: funded });
  assert.equal(retained.status, "retained");

  if (retained.status === "retained" && retained.value.schemaVersion === 2) {
    assert.equal(retained.value.sourceSnapshot.actualUses.methodFieldings.available, 10);
    assert.equal(retained.value.sourceSnapshot.responseRegistrations.available, 0,
      "the original ten method uses are source history, not a paired economic baseline");
  }

  const pending = await f.executor.observe(funded, f.controller.signal);
  assert.equal(pending.outcome, "pending");
  assert.equal((await recordCentralStageObservation({ boardRoot: f.root, enabled: () => true, candidate, input: funded, observed: pending })).status, "written");
  const address = { boardRoot: f.root, scope, grantId: funded.grantId, stageRef: funded.stageRef };
  const before = await refreshFrozenStageObservation({ ...address, port: f.executor }, f.controller.signal);

  assert.equal(before.status, "refreshed");
  if (before.status === "refreshed") assert.equal(before.observed.outcome, "pending");

  assert.ok((await f.executor.dispatch(funded, f.controller.signal)).ok);
  assert.equal(f.calls(), 1);
  const completedIssue = (await f.load()).learningIssues!.find(row => row.issueId === funded.issueId)!;

  await f.act({ kind: "report", issueId: funded.issueId, scope, problemKey: completedIssue.problemKey,
    report: { reportId: "report:later-tool-requirement", source: { subsystem: "tool", taskId: "task:later-requirement", versionId: "tool:later-source" },
      facts: ["A separate later capability requirement"], evidenceRefs: ["evidence:later-tool-requirement"] } });
  const refreshed = await refreshFrozenStageObservation({ ...address,
    port: createCentralMethodExecutor({ ...f.options, model: "a-different-later-host-model" }) }, f.controller.signal);

  assert.equal(refreshed.status, "refreshed");
  if (refreshed.status !== "refreshed") assert.fail("actual original receipt was not refreshed");

  assert.equal(refreshed.observed.outcome, "qualified");
  assert.ok(refreshed.observed.resultRefs.length > 0);
  const after = await f.load(), revised = buildCentralPursuitQualificationRevisionDraft({ board: after, scope,
    unitId: refreshed.frozen.unitId, expectedHeadFactId: refreshed.expectedHeadRef, review: {
      kind: "original_criterion_review", definitionRef: refreshed.frozen.candidate.objective.definitionRef,
      frameRef: refreshed.frozen.input.stageRef, origin: "domain_receipt", outcome: refreshed.observed.outcome,
      sourceRef: refreshed.observed.resultRefs[0]!, evidenceRefs: refreshed.observed.resultRefs } });

  assert.equal(revised.status, "ready");
  if (revised.status !== "ready") assert.fail("original observation revision rejected");

  assert.equal((await createRewardV2BoardPort(f.root, () => true).append(after.sequence, revised.draft)).status, "written");
  const qualifiedBoard = await f.load();
  const assignedAgain = await recordCentralStageObservation({ boardRoot: f.root, enabled: () => true, candidate, input: funded, mode: "initial",
    observed: { outcome: "pending", resultRefs: [], sourceRefs: [funded.sourceBindingRef, funded.stageRef, funded.grantId],
      reason: "funded_stage_outcome_unresolved_not_proof_of_execution" } });

  assert.equal(assignedAgain.status, "previous");
  assert.deepEqual(await f.load(), qualifiedBoard, "retrying the original assignment cannot downgrade its qualified head or mutate the Board");
  const stalePostDispatch = await recordCentralStageObservation({ boardRoot: f.root, enabled: () => true,
    candidate, input: funded, observed: pending });

  assert.equal(stalePostDispatch.status, "previous");
  assert.deepEqual(await f.load(), qualifiedBoard, "a real pending read captured before delivery cannot overwrite the later qualified head");
  assert.equal(f.calls(), 1);
  const originalAssessment = (await f.load()).feedbacks.find(row => row.exposureId === "exposure:0")?.observation;

  assert.ok(originalAssessment);
  assert.equal(originalAssessment.compilationId, undefined);
  assert.ok((await f.writer.recordFeedback({ writeId: "late-original-source-correction", exposureId: "exposure:0", versionId,
    turnId: originalAssessment.taskId, helped: false, observedAt: at,
    observation: { ...originalAssessment, revision: originalAssessment.revision + 1, outcome: "unhelpful" } })).ok);
  assert.equal((await f.executor.observe(funded, f.controller.signal)).outcome, "qualified",
    "superseding a source helpfulness assessment changes current evidence, not the frozen historical delivery fact");
  const final = await refreshFrozenStageObservation({ ...address, port: { domain: "prompt", observe: async () => {
    assert.fail("ordinary disappearance or later task failure must not re-observe and reverse a delivered proposal");
  } } }, f.controller.signal);

  assert.equal(final.status, "unchanged");
  if (final.status === "unchanged") assert.equal(final.outcome, "qualified");

  const reread = await readFrozenStage(address);
  assert.equal(reread.status, "ready");

  if (reread.status === "ready") assert.deepEqual(reread.value.input, funded);

  const history = readCentralPursuitObservations(await f.load(), scope);
  assert.equal(history.status, "ready");

  if (history.status === "ready") {
    assert.equal(history.observations.length, 1);
    assert.equal(history.observations[0]!.outcome, "qualified");
  }

  assert.equal(f.calls(), 1, "refresh performs no dispatch, funding or extra model request");
});

test("an actual later compiled adoption and corrected feedback change the next source without creating economic gain", async t => {
  const f = await fixture(t), funded = await f.fund(await f.nominateAndFocus());

  assert.ok((await f.executor.dispatch(funded, f.controller.signal)).ok);
  const input = { boardRoot: f.root, scope, issueId: funded.issueId };
  const before = await readMethodCentralFeedback(input);
  assert.ok(before);
  const selected = await f.runtime.context(context("compiled-follow-up"));
  const compilationId = selected.find(item => item.versionId === versionId)?.compilationId;
  assert.ok(compilationId);
  const delivery = await f.runtime.slot("compiled-follow-up");
  assert.ok(delivery);
  const receipt = delivery.receipts.find(item => item.versionId === versionId);
  assert.ok(receipt?.binding);
  assert.equal(receipt.binding.compilationId, compilationId);
  assert.ok((await f.writer.recordUse({ writeId: "compiled-use", exposureId: "compiled-use", versionId,
    proposalId: "proposal:method-source", turnId: "compiled-follow-up", beat: 1, requestId: "compiled-request", scope: "json",
    binding: receipt.binding, observedAt: at })).ok);
  await f.runtime.decide({ versionId, scopeId: "json", action: "adopt", reason: "TEST consumer applies this exact compiled procedure" });
  assert.ok((await f.writer.recordFeedback({ writeId: "compiled-negative", exposureId: "compiled-use", versionId,
    turnId: "compiled-follow-up", helped: false, observedAt: at })).ok);
  const after = await readMethodCentralFeedback(input);
  assert.ok(after);
  assert.notEqual(after.sourceRef, before.sourceRef);
  assert.ok(after.records.some(row => row.unit === "method_adoption_decision"));
  const negative = after.records.find(row => row.kind === "method_assessment" && row.outcome === "unhelpful");
  assert.ok(negative);
  assert.equal(negative.economicComparison, "unregistered");
  const next = await f.executor.prepare({ issueId: funded.issueId, authorizedAllowance: authorized }, f.controller.signal);

  assert.ok(next.status === "ready", JSON.stringify(next));
  assert.equal(next.source.domainStage.kind, "continuation");
  assert.notEqual(next.stageRef, funded.stageRef, "the original method selector sees the compiled counterexample in its next request");
  const state = await f.load(), observation = state.feedbacks.find(row => row.exposureId === "compiled-use")?.observation;
  assert.ok(observation);
  assert.equal(observation.compilationId, compilationId);
  assert.ok((await f.writer.recordFeedback({ writeId: "compiled-correction", exposureId: "compiled-use", versionId,
    turnId: "compiled-follow-up", helped: true, observedAt: at,
    observation: { ...observation, revision: observation.revision + 1, outcome: "helped" } })).ok);
  const corrected = await readMethodCentralFeedback(input);
  assert.ok(corrected);
  assert.notEqual(corrected.sourceRef, after.sourceRef);
  const revised = corrected.records.filter(row => row.kind === "method_assessment" && row.factRef === observation.observationId);

  assert.equal(revised.length, 1, "a correction replaces its original assessment instead of creating another trial");
  assert.equal(revised[0]!.revision, 1);
  assert.equal(revised[0]!.outcome, "helped");
  assert.equal(f.calls(), 1);
});

test("a changed issue revision cannot claim the committed method stage", async t => {
  const f = await fixture(t), funded = await f.fund(await f.nominateAndFocus()), before = await f.load();

  await f.act({ kind: "report", issueId: funded.issueId, scope, problemKey: before.learningIssues![0]!.problemKey,
    report: { reportId: "report:new-method-evidence", source: { subsystem: "method", taskId: "new-task", versionId },
      facts: ["scope:json", "new evidence requires re-evaluation"], evidenceRefs: ["new-evidence:method"] } });
  const result = await f.executor.dispatch(funded, new AbortController().signal);

  assert.ok(!result.ok);
  assert.equal(result.reason, "learning_issue_conflict");
  assert.equal(f.calls(), 0);
  assert.equal((await f.load()).centralLearningGrants![0]!.claim, undefined);
});

test("method configuration identity is frozen for dispatch without replacing the actual provider model or its late receipt", async t => {
  const f = await fixture(t, "promote", undefined, "test:full-provider-config:first"), prepared = await f.nominateAndFocus();
  const other = createCentralMethodExecutor({ ...f.options, modelRef: "test:full-provider-config:other" });
  const next = await other.prepare({ issueId: prepared.source.issueId, authorizedAllowance: authorized }, f.controller.signal);

  assert.ok(next.status === "ready", JSON.stringify(next));
  assert.equal(next.policyRef, prepared.policyRef, "the original model policy retains its receipt meaning");
  assert.notEqual(next.policyFamily?.ref, prepared.policyFamily?.ref);
  assert.notEqual(next.stageRef, prepared.stageRef);
  assert.notEqual(next.source.sourceBindingRef, prepared.source.sourceBindingRef);
  assert.equal(next.condition?.ref, prepared.condition?.ref);
  const funded = await f.fund(prepared), staleConfig = await other.dispatch(funded, f.controller.signal);

  assert.ok(!staleConfig.ok);
  assert.equal(f.calls(), 0);
  assert.equal((await f.load()).centralLearningGrants![0]!.claim, undefined);
  assert.ok((await f.executor.dispatch(funded, f.controller.signal)).ok);
  assert.deepEqual(f.requestedModels, ["scripted-contract"], "only the real provider model name enters the request");
  const restored = createCentralMethodExecutor({ ...f.options, model: "a-later-configured-model", modelRef: "test:full-provider-config:other" });

  assert.equal((await restored.observe(funded, f.controller.signal)).outcome, "qualified");
  assert.equal(f.calls(), 1);
});

test("public issue content reaches the original method prompt and a changed reference invalidates dispatch", async t => {
  let content = { ref: "content:method-public-v1", text: "Keep the schema boundary and the caller's unresolved fallback requirement." };
  const f = await fixture(t, "defer", async () => content), funded = await f.fund(await f.nominateAndFocus());
  const completed = await f.executor.dispatch(funded, f.controller.signal);
  assert.ok(completed.ok);
  assert.equal(f.supplied[0]!.centralSourceContext?.ref, content.ref);
  assert.ok(f.supplied[0]!.centralSourceContext?.text.includes(content.text));
  assert.ok(f.supplied[0]!.centralSourceContext?.text.includes("not independent observations"));
  const other = await fixture(t, "defer", async () => content), stale = await other.fund(await other.nominateAndFocus());

  content = { ref: "content:method-public-v2", text: "A newer source context changes the unresolved condition." };
  const rejected = await other.executor.dispatch(stale, other.controller.signal);

  assert.ok(!rejected.ok);
  assert.equal(other.calls(), 0);
  assert.equal((await other.load()).centralLearningGrants![0]!.claim, undefined);
});

test("a public method packet that exceeds the real prompt envelope is rejected before funding", async t => {
  const f = await fixture(t, "defer", async () => ({ ref: "content:method-large", text: "Complete source condition. ".repeat(1000) }));
  const ids = await f.executor.nominate!(f.controller.signal), state = await f.load(), issue = state.learningIssues!.find(item => item.issueId === ids[0])!;

  await f.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "TEST PA selected the original source", sourceRefs: issue.reports[0]!.evidenceRefs });
  const prepared = await f.executor.prepare({ issueId: issue.issueId, authorizedAllowance: authorized }, f.controller.signal);

  assert.ok(prepared.status === "unavailable");
  assert.equal(prepared.reason, "method_review_prompt_limit");
  assert.equal(f.calls(), 0);
  assert.equal((await f.load()).centralLearningGrants?.length ?? 0, 0);
});
