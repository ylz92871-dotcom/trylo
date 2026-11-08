import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovementModelPort, WorkflowImprovementProposal, WorkflowImprovementResearchAction, WorkflowImprovementResearchInput } from "../improvement/contracts.js";
import type { WorkflowResearchFinding } from "../improvement/research-contracts.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { createWorkflowImprovementFunding } from "../adapters/improvement-funding.js";
import { fileWorkflowImprovementPorts, type FileWorkflowImprovementOptions } from "../adapters/improvement-composition.js";
import type { WorkflowImprovementFunding, WorkflowImprovementStorePort } from "./improvement-contracts.js";
import type { WorkflowResearchStageBinding } from "./research-funding-contracts.js";
import { createCentralWorkflowExecution } from "../../../../../integration/central-learning/workflow.js";
import { workWorkflowImprovement } from "./improvement-worker.js";
import { readWorkflowCentralResearchContinuation } from "../adapters/central-research-continuation.js";

type ScriptedStep = {
  readonly action: WorkflowImprovementResearchAction;
  readonly tokens?: number;
  readonly calls?: 0 | 1;
  readonly uncertain?: boolean;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly check?: (input: WorkflowImprovementResearchInput) => void | Promise<void>;
};

function scriptedModel(proposal: WorkflowImprovementProposal, steps: readonly ScriptedStep[]) {
  let researchCalls = 0, legacyCalls = 0;
  let latest = { calls: 0, tokens: 0, observedTokens: 0, uncertain: false };
  const inputs: WorkflowImprovementResearchInput[] = [];
  const port: WorkflowImprovementModelPort = {
    async propose() {
      legacyCalls += 1;
      return { ok: true, value: proposal };
    },
    usage: () => ({ calls: legacyCalls, tokens: legacyCalls * 500, observedTokens: legacyCalls * 500, uncertain: false }),
    async research(input) {
      const step = steps[researchCalls];
      assert.ok(step, "The worker requested an unplanned extra research sample");
      researchCalls += 1;
      inputs.push(structuredClone(input));
      const tokens = step.tokens ?? 500;
      latest = { calls: step.calls ?? 1, tokens, observedTokens: tokens, uncertain: step.uncertain === true };
      await step.check?.(input);
      return step.failure === undefined ? { ok: true, value: step.action } : workflowFailure(step.failure.code, step.failure.message);
    },
    researchUsage: () => latest,
  };

  return { port, inputs, researchCalls: () => researchCalls, legacyCalls: () => legacyCalls };
}

async function fixture(t: TestContext, input: { readonly calls?: number; readonly centralContent?: CentralLearningSourceContext } = {}) {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-research-runtime-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), path.resolve(tmpdir()));
    assert.ok(path.basename(boardRoot).startsWith("workflow-research-runtime-"));
    await rm(boardRoot, { recursive: true, force: true });
  });
  const source = searchImprovementFixture();
  const record = { type: "workflow_improvement_opportunity" as const, schemaVersion: 1 as const,
    opportunity: source.opportunity, evidence: source.evidence };
  let clock = 1_793_761_200_000, command = 0;
  const options: FileWorkflowImprovementOptions = { boardRoot, scope: source.opportunity.task.scope,
    centralScope: "D:/workspace/workflow-research-runtime", sessionId: "session:workflow-research",
    budgetId: "workflow-research-original-run", allowance: 16_000, now: () => clock,
    ...(input.centralContent === undefined ? {} : { centralContent: input.centralContent }),
    publicData: () => true, warn: () => {},
    readEvidence: async () => ({ ok: true, value: { evidence: source.evidence, receipts: [], watermark: 0,
      executionId: "session:workflow-research/turn:original" } }),
    newModel: () => scriptedModel(source.proposal, []).port };
  const read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => {
    const applied = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning",
      commandId: `workflow-research-runtime:${++command}`, issuedAt: new Date(clock).toISOString(), action }));
    assert.ok(applied.ok, JSON.stringify(applied));
    return applied.state;
  };
  const original = createWorkflowImprovementFunding({ ...options, research: true });
  const prepared = await original.prepare(record);
  assert.ok(prepared.ok);
  await act({ kind: "open_budget", expectedSequence: (await read()).sequence,
    budget: { schemaVersion: 1, budgetId: "central-budget:workflow-research", scope: options.centralScope!,
      unit: "total_model_tokens", limits: { tokens: 32_000, calls: Math.max(8, input.calls ?? 4), steps: Math.max(8, input.calls ?? 4) }, authorizationRef: "host:research-fixture" } });
  const fundedState = await act({ kind: "fund", domain: "workflow", issueId: prepared.value.issueId,
    expectedRevision: prepared.value.expectedIssueRevision, expectedSequence: (await read()).sequence,
    grantId: prepared.value.grantId, allowance: { ...prepared.value.allowance, maxCalls: input.calls ?? 4, maxSteps: input.calls ?? 4 },
    budgetId: "central-budget:workflow-research", authorizationRef: "host:research-initial", planRef: "plan:research-initial" });
  const grant = fundedState.centralLearningGrants![0]!;
  const funded: WorkflowImprovementFunding = { grantId: grant.grantId, jobId: grant.jobId,
    inputVersionId: prepared.value.inputVersionId, state: "queued", resultRefs: [] };
  const ports = fileWorkflowImprovementPorts(options);
  const funding = (owner: string, stage?: WorkflowResearchStageBinding) => createWorkflowImprovementFunding({ ...options, research: true, researchOwnerId: owner,
    binding: { grantId: funded.grantId, inputVersionId: funded.inputVersionId, ...(stage === undefined ? {} : { stage }) } });
  const run = (model: WorkflowImprovementModelPort, owner: string,
    override: { readonly store?: WorkflowImprovementStorePort; readonly centralContent?: CentralLearningSourceContext; readonly stage?: WorkflowResearchStageBinding } = {}) =>
    workWorkflowImprovement({ ...options, store: override.store ?? ports.store, funding: funding(owner, override.stage), newModel: () => model,
      ...(override.centralContent === undefined ? {} : { centralContent: override.centralContent }) }, funded, record, new AbortController().signal);

  return { source, record, options, funded, ports, read, act, funding, run, advance: (milliseconds: number) => { clock += milliseconds; } };
}

function expectState(result: WorkflowLearningResult<unknown>, status: string) {
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(Reflect.get(result.value as object, "status"), status);
}

test("research reads source material, repairs a rejected candidate and publishes through the original worker with three paid checkpoints", async t => {
  const fx = await fixture(t);
  const invalidProposal = { ...fx.source.proposal, procedure: { ...fx.source.proposal.procedure, requiredConditions: {} } };
  const model = scriptedModel(fx.source.proposal, [
    { action: { kind: "read_material", evidenceRefs: [fx.source.evidence[0]!.ref] }, check: async () => {
      const state = await fx.read();
      assert.equal(state.centralLearningGrants![0]!.reservations[0]?.state, "reserved");
    } },
    { action: { kind: "propose", proposal: invalidProposal }, check: input => {
      assert.deepEqual(input.observations, [{ kind: "material_read", evidenceRefs: [fx.source.evidence[0]!.ref] }]);
    } },
    { action: { kind: "propose", proposal: fx.source.proposal }, check: input => {
      assert.equal(input.observations[1]?.kind, "invalid_response");
      assert.match(JSON.stringify(input.observations[1]), /improvement_conditions_weakened/);
    } },
  ]);
  const result = await fx.run(model.port, "worker:three-step");
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("versionId" in result.value);
  assert.equal(model.researchCalls(), 3);
  assert.equal(model.legacyCalls(), 0);
  const state = await fx.read(), grant = state.centralLearningGrants![0]!;

  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(grant.grantId, fx.funded.grantId);
  assert.equal(grant.status, "closed");
  assert.equal(grant.closedReason, "completed");
  assert.deepEqual(centralLearningSpent(grant), { tokens: 1500, calls: 3, steps: 3 });
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.deepEqual(view.value.research?.map(item => item.record.status), ["continue", "continue", "candidate"]);
  assert.equal(view.value.versions[0]?.versionId, result.value.versionId);
  assert.equal(view.value.versions[0]?.status, "eligible");
  assert.equal(state.activations.length, 0, "publication is not an automatic activation or quality result");
});

test("a budget yield resumes confirmed research in a new factory only after rebudgeting the same original grant", async t => {
  const fx = await fixture(t, { calls: 1 });
  const first = scriptedModel(fx.source.proposal, [{ action: { kind: "read_material", evidenceRefs: [fx.source.evidence[0]!.ref] } }]);

  expectState(await fx.run(first.port, "worker:first-segment"), "yielded");
  const paused = await fx.read();
  assert.equal(paused.jobs[0]?.state, "queued");
  assert.equal(paused.centralLearningGrants![0]!.claim, undefined);
  const noNewFunds = scriptedModel(fx.source.proposal, []);

  expectState(await fx.run(noNewFunds.port, "worker:new-factory-before-investment"), "yielded");
  assert.equal(noNewFunds.researchCalls(), 0);
  await fx.act({ kind: "rebudget", grantId: fx.funded.grantId, expectedSequence: (await fx.read()).sequence,
    limits: { tokens: 16_000, calls: 3, steps: 3 }, authorizationRef: "host:research-continuation", planRef: "plan:research-continuation" });
  const resumed = scriptedModel(fx.source.proposal, [{ action: { kind: "propose", proposal: fx.source.proposal }, check: input => {
    assert.deepEqual(input.observations, [{ kind: "material_read", evidenceRefs: [fx.source.evidence[0]!.ref] }]);
  } }]);
  const result = await fx.run(resumed.port, "worker:new-factory-after-investment");
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("versionId" in result.value);
  assert.equal(resumed.researchCalls(), 1);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.deepEqual(state.centralLearningGrants![0]!.reservations.map(item => item.reservationId.split(":").slice(-2).join(":")), ["wf-research:0", "wf-research:1"]);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: 1000, calls: 2, steps: 2 });
});

for (const operationCalls of [1, 5]) {
test(`a central workflow operation preserves four checkpoints and spends only its ${operationCalls}-call continuation envelope on the original grant`, async t => {
  const lifetimeCalls = Math.max(8, 4 + operationCalls), fx = await fixture(t, { calls: lifetimeCalls });
  const unfetched = await fx.read();
  const nativeInput = { scope: fx.options.centralScope!, issueId: unfetched.centralLearningGrants![0]!.issueId,
    grantId: fx.funded.grantId, lastStageCommittedAtSequence: unfetched.sequence, previousCursorRefs: [fx.funded.inputVersionId] };
  const noHead = readWorkflowCentralResearchContinuation({ ...nativeInput, board: unfetched });

  assert.equal(noHead.kind, "waiting");
  assert.match(noHead.reason, /confirmed_checkpoint_missing/);
  const stageAllowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 16000, maxCalls: 4, maxSteps: 4, maxPromptChars: 24000 };
  const first = scriptedModel(fx.source.proposal, Array.from({ length: 4 }, (_, index) => ({
    action: { kind: "read_material" as const, evidenceRefs: [fx.source.evidence[index % fx.source.evidence.length]!.ref] },
  })));

  expectState(await fx.run(first.port, "worker:four-call-operation", { stage: {
    chargedAtStart: { tokens: 0, calls: 0, steps: 0 }, allowance: stageAllowance } }), "yielded");
  const paused = await fx.read(), originalGrant = paused.centralLearningGrants![0]!, issueId = originalGrant.issueId;

  assert.equal(first.researchCalls(), 4);
  assert.equal(originalGrant.status, "open");
  assert.equal(paused.jobs[0]!.state, "queued");
  assert.deepEqual(centralLearningSpent(originalGrant), { tokens: 2000, calls: 4, steps: 4 });
  assert.equal(originalGrant.allowance.maxCalls, lifetimeCalls, "the original grant retains capacity beyond the first operation");
  const before = await fx.ports.store.read();
  assert.ok(before.ok);
  assert.equal(before.value.research?.length, 4);
  const prefix = structuredClone(originalGrant.reservations), checkpointRefs = before.value.research!.map(item => item.versionId);
  const finding: WorkflowResearchFinding = { kind: "hypothesis", statement: "The known owner should bound the next source search.",
    conditions: "The recorded owner and repository snapshot still match.", sourceRefs: [fx.source.evidence[0]!.ref],
    nextQuestion: "Does the current owner still contain the requested symbol?" };
  const continuation = scriptedModel(fx.source.proposal, Array.from({ length: operationCalls }, (_, index) => ({
    action: { kind: "record_finding", finding: { ...finding, statement: `${finding.statement} Interpretation ${index}.` } },
  })));
  const modelCaps: number[] = [];
  const execution = createCentralWorkflowExecution({ ...fx.options, research: true, enabled: () => true,
    newModel(maxPromptChars) {
      modelCaps.push(maxPromptChars);
      return continuation.port;
    } });
  const operation = { ...stageAllowance, maxTokens: 30000, maxCalls: operationCalls, maxSteps: operationCalls, maxPromptChars: 12000 };
  const prepared = await execution.prepare({ issueId,
    authorizedAllowance: { ...stageAllowance, maxTokens: 32000, maxCalls: 1000, maxSteps: 1000 }, operationAllowance: operation }, new AbortController().signal);

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));

  if (prepared.status !== "ready") throw new Error("one_call_workflow_stage_not_ready");

  assert.equal(prepared.offer.reserve.calls, operationCalls);
  assert.equal(prepared.offer.reserve.steps, operationCalls);
  assert.equal(prepared.offer.maxPromptChars, 12000);
  assert.equal(prepared.authorizedAllowance.maxPromptChars, 24000);
  assert.equal(prepared.authorizedAllowance.maxTokens, 32000, "the authorized continuation is not clamped to the original 16000-token startup envelope");
  const priorHead = before.value.research!.at(-1)!;

  assert.equal(prepared.source.domainStage.readiness.kind, "ready");
  const cursorRefs = prepared.source.domainStage.readiness.evidenceRefs;

  assert.ok(cursorRefs.includes(priorHead.versionId));
  const consumed = readWorkflowCentralResearchContinuation({ ...nativeInput, board: paused, previousCursorRefs: cursorRefs });

  assert.equal(consumed.kind, "waiting");
  assert.match(consumed.reason, /cursor_already_consumed/);
  const repeatedRead = readWorkflowCentralResearchContinuation({ ...nativeInput, board: paused,
    previousCursorRefs: [fx.funded.inputVersionId, priorHead.record.contextRef] });

  assert.equal(repeatedRead.kind, "waiting");
  assert.match(repeatedRead.reason, /material_already_read/);
  await fx.act({ kind: "rebudget", grantId: fx.funded.grantId, expectedSequence: (await fx.read()).sequence,
    limits: { tokens: prepared.authorizedAllowance.maxTokens, calls: prepared.authorizedAllowance.maxCalls, steps: prepared.authorizedAllowance.maxSteps },
    authorizationRef: "host:one-call-continuation", planRef: "plan:one-call-continuation" });
  const lastStageCommittedAtSequence = (await fx.read()).sequence;
  const result = await execution.dispatch({ issueId, grantId: fx.funded.grantId,
    expectedIssueRevision: (await fx.read()).learningIssues!.find(item => item.issueId === issueId)!.revision,
    stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer }, new AbortController().signal);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "idle");
  assert.equal(result.workAttempted, true);
  assert.equal(continuation.researchCalls(), operationCalls);
  assert.equal(continuation.legacyCalls(), 0);
  assert.deepEqual(modelCaps, [12000]);
  const after = await fx.read(), finalGrant = after.centralLearningGrants![0]!;

  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.centralLearningBudgets!.length, 1);
  assert.equal(finalGrant.grantId, originalGrant.grantId);
  assert.equal(finalGrant.issueId, issueId);
  assert.equal(finalGrant.budgetId, originalGrant.budgetId);
  assert.equal(finalGrant.status, "open");
  assert.equal(after.jobs[0]!.state, "queued");
  assert.equal(finalGrant.claim, undefined);
  assert.equal(finalGrant.reservations.length, 4 + operationCalls);
  assert.deepEqual(finalGrant.reservations.slice(0, 4), prefix);
  assert.deepEqual(centralLearningSpent(finalGrant), { tokens: 2000 + 500 * operationCalls, calls: 4 + operationCalls, steps: 4 + operationCalls });
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.research?.length, 4 + operationCalls);
  assert.deepEqual(view.value.research!.slice(0, 4).map(item => item.versionId), checkpointRefs);
  assert.equal(view.value.research!.at(-1)!.record.status, "continue");
  assert.equal(view.value.versions.length, 0);
  const head = view.value.research!.at(-1)!;
  const nextInput = { ...nativeInput, board: after, lastStageCommittedAtSequence, previousCursorRefs: cursorRefs };
  const next = readWorkflowCentralResearchContinuation(nextInput);

  assert.equal(next.kind, "continuable", JSON.stringify(next));
  if (next.kind === "continuable") assert.equal(next.cursorRef, head.versionId);

  assert.equal(readWorkflowCentralResearchContinuation({ ...nextInput, previousCursorRefs: [...cursorRefs, head.versionId] }).kind, "waiting");
  const wrongSequence = readWorkflowCentralResearchContinuation({ ...nextInput, lastStageCommittedAtSequence: after.sequence });

  assert.equal(wrongSequence.kind, "inspection");
  assert.match(wrongSequence.reason, /assignment_checkpoint_mismatch/);
  const wrongContext = readWorkflowCentralResearchContinuation({ ...nextInput, previousCursorRefs: cursorRefs.filter(ref => ref !== head.record.contextRef) });

  assert.equal(wrongContext.kind, "inspection");
  assert.match(wrongContext.reason, /assignment_checkpoint_mismatch/);
  const unknown = { ...after, centralLearningGrants: after.centralLearningGrants!.map(grant => grant.grantId !== finalGrant.grantId ? grant : { ...grant,
    reservations: grant.reservations.map((reservation, index) => index !== grant.reservations.length - 1 ? reservation : { ...reservation,
      usage: { kind: "unknown" as const, reason: "projection:unreconciled-provider-usage" } }) }) };

  assert.equal(readWorkflowCentralResearchContinuation({ ...nextInput, board: unknown }).kind, "inspection", "unknown usage never advances the native cursor");
});
}

test("an unknown sent step without a checkpoint is handed back and never sampled again, including after late known usage", async t => {
  const fx = await fixture(t);
  const first = scriptedModel(fx.source.proposal, [{ action: { kind: "read_material", evidenceRefs: [fx.source.evidence[0]!.ref] }, uncertain: true }]);

  expectState(await fx.run(first.port, "worker:unknown"), "waiting_evidence");
  const afterUnknown = await fx.read();
  assert.equal(afterUnknown.centralLearningGrants![0]!.reservations.length, 1);
  assert.equal(afterUnknown.centralLearningGrants![0]!.reservations[0]?.usage?.kind, "unknown");
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.research?.length ?? 0, 0);
  const restarted = scriptedModel(fx.source.proposal, []);

  expectState(await fx.run(restarted.port, "worker:restart-unknown"), "waiting_evidence");
  assert.equal(restarted.researchCalls(), 0);
  const reservation = afterUnknown.centralLearningGrants![0]!.reservations[0]!;

  await fx.act({ kind: "settle", grantId: fx.funded.grantId, reservationId: reservation.reservationId,
    usage: { kind: "reported", totalTokens: 500 } });
  expectState(await fx.run(restarted.port, "worker:restart-known-without-content"), "waiting_evidence");
  assert.equal(restarted.researchCalls(), 0);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 1);
  assert.equal(centralLearningSpent(state.centralLearningGrants![0]!).tokens, 500);
});

test("waiting for external evidence does not buy another sample until original source context actually changes", async t => {
  const initialContent = { ref: "central-content:original-v1", text: "The original task does not yet identify the acceptance observation." };
  const fx = await fixture(t, { centralContent: initialContent });
  const waiting = scriptedModel(fx.source.proposal, [
    { action: { kind: "read_material", evidenceRefs: [fx.source.evidence[0]!.ref] } },
    { action: { kind: "wait_for_evidence", reason: "Need the actual acceptance observation before deciding whether to change the flow.",
      evidenceRefs: [fx.source.evidence[0]!.ref] } },
  ]);

  expectState(await fx.run(waiting.port, "worker:wait"), "waiting_evidence");
  const noChange = scriptedModel(fx.source.proposal, []), before = await fx.read();

  expectState(await fx.run(noChange.port, "worker:same-context"), "waiting_evidence");
  assert.equal(noChange.researchCalls(), 0);
  assert.equal((await fx.read()).sequence, before.sequence);
  const changed = { ref: "central-content:observed-v2", text: "The task's acceptance observation is now attached to the original source." };
  const continued = scriptedModel(fx.source.proposal, [{ action: { kind: "propose", proposal: fx.source.proposal }, check: input => {
    assert.deepEqual(input.centralContent, changed);
    assert.equal(input.observations.at(-1)?.kind, "invalid_response");
    assert.equal(input.observations.filter(item => item.kind === "material_read").length, 0,
      "Exposure receipts from the old context cannot expose missing or changed material in the new context");
  } }]);
  const result = await fx.run(continued.port, "worker:changed-context", { centralContent: changed });

  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("versionId" in result.value);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 3);
});

test("a known zero-call projection failure checkpoints its local boundary and can continue after original-grant investment", async t => {
  const fx = await fixture(t, { calls: 1 });
  const localFailure = scriptedModel(fx.source.proposal, [{ action: { kind: "read_material", evidenceRefs: [] }, calls: 0, tokens: 0,
    failure: { code: "learning_budget_exhausted", message: "The real bounded prompt does not fit this authorized segment" } }]);

  expectState(await fx.run(localFailure.port, "worker:local-projection"), "yielded");
  const before = await fx.ports.store.read();
  assert.ok(before.ok);
  assert.equal(before.value.research?.length, 1, "A confirmed no-send boundary must not look like a missing provider response");
  assert.equal(before.value.research?.[0]?.record.status, "continue");
  const paused = await fx.read();
  assert.equal(centralLearningSpent(paused.centralLearningGrants![0]!).tokens, 0);
  await fx.act({ kind: "rebudget", grantId: fx.funded.grantId, expectedSequence: paused.sequence,
    limits: { tokens: 24_000, calls: 3, steps: 3 }, authorizationRef: "host:projection-continuation", planRef: "plan:projection-continuation" });
  const continued = scriptedModel(fx.source.proposal, [{ action: { kind: "propose", proposal: fx.source.proposal } }]);
  const result = await fx.run(continued.port, "worker:after-projection-investment");

  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("versionId" in result.value);
  assert.equal(continued.researchCalls(), 1);
  const after = await fx.read();
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), { tokens: 500, calls: 2, steps: 2 });
});

test("a confirmed candidate checkpoint recovers publication locally after restart without another reservation or model call", async t => {
  const fx = await fixture(t);
  const first = scriptedModel(fx.source.proposal, [{ action: { kind: "propose", proposal: fx.source.proposal } }]);
  const publishUnavailable: WorkflowImprovementStorePort = { ...fx.ports.store,
    publish: async () => workflowFailure("workflow_publication_unavailable", "Publication failed before its writer operation") };
  const result = await fx.run(first.port, "worker:before-crash", { store: publishUnavailable });

  expectState(result, "yielded");
  assert.ok(result.ok && "reason" in result.value);
  assert.equal(result.value.reason, "workflow_publication_unavailable");
  const before = await fx.read(), view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.research?.[0]?.record.status, "candidate");
  assert.equal(view.value.versions.length, 0);
  assert.equal(before.centralLearningGrants![0]!.reservations.length, 1);
  assert.equal(before.centralLearningGrants![0]!.claim, undefined, "A confirmed local publication failure releases its lease immediately");
  const restart = scriptedModel(fx.source.proposal, []);
  const execution = createCentralWorkflowExecution({ ...fx.options, research: true, enabled: () => true, newModel: () => restart.port });
  const grant = before.centralLearningGrants![0]!;
  const prepared = await execution.prepare({ issueId: grant.issueId, authorizedAllowance: grant.allowance,
    operationAllowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1, maxCalls: 1, maxSteps: 1, maxPromptChars: 1 } }, new AbortController().signal);

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));

  if (prepared.status !== "ready") throw new Error("free_candidate_publication_not_ready");

  assert.deepEqual(prepared.offer.reserve, { tokens: 0, calls: 0, steps: 0 });
  assert.deepEqual(prepared.authorizedAllowance, grant.allowance, "a free publication retains the existing cumulative grant instead of shrinking it to a paid probe");
  const recovered = await execution.dispatch({ issueId: grant.issueId, grantId: grant.grantId,
    expectedIssueRevision: before.learningIssues!.find(item => item.issueId === grant.issueId)!.revision,
    stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer }, new AbortController().signal);

  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(recovered.status, "completed");
  assert.equal(restart.researchCalls(), 0);
  assert.equal(restart.legacyCalls(), 0);
  const after = await fx.read();
  assert.equal(after.centralLearningGrants![0]!.reservations.length, 1);
  assert.equal(after.centralLearningGrants![0]!.grantId, grant.grantId);
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.centralLearningBudgets!.length, 1);
  assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), centralLearningSpent(grant));
  assert.equal(after.centralLearningGrants![0]!.status, "closed");
  assert.equal(after.jobs[0]?.state, "succeeded");
});

test("public findings survive another material read, a context change and a new research factory without becoming source evidence", async t => {
  const fx = await fixture(t, { calls: 3 });
  const finding: WorkflowResearchFinding = { kind: "hypothesis", statement: "Repeated whole-repository searches may discard an already identified owner.",
    conditions: "Applies only after the current snapshot and owning directory are confirmed.", sourceRefs: [fx.source.evidence[0]!.ref],
    nextQuestion: "Does a scoped lookup preserve complete evidence when the repository snapshot changes?" };
  const first = scriptedModel(fx.source.proposal, [
    { action: { kind: "read_material", evidenceRefs: [fx.source.evidence[0]!.ref] } },
    { action: { kind: "record_finding", finding } },
    { action: { kind: "read_material", evidenceRefs: [fx.source.evidence[1]!.ref] }, check: input => {
      assert.ok(input.observations.some(item => item.kind === "finding_recorded" && item.finding.statement === finding.statement));
    } },
  ]);

  expectState(await fx.run(first.port, "worker:initial-understanding"), "yielded");
  const before = await fx.ports.store.read();
  assert.ok(before.ok);
  assert.equal(before.value.research?.[1]?.record.status, "continue");
  await fx.act({ kind: "rebudget", grantId: fx.funded.grantId, expectedSequence: (await fx.read()).sequence,
    limits: { tokens: 16_000, calls: 6, steps: 6 }, authorizationRef: "host:finding-continuation", planRef: "plan:finding-continuation" });
  const nextContext = { ref: "central-content:finding-next-context", text: "Recheck the same hypothesis against this task's current snapshot before using it." };
  const restarted = scriptedModel(fx.source.proposal, [
    { action: { kind: "read_material", evidenceRefs: [fx.source.evidence[0]!.ref, fx.source.evidence[1]!.ref] }, check: input => {
      assert.deepEqual(input.observations.filter(item => item.kind === "finding_recorded"), [{ kind: "finding_recorded", finding }]);
      assert.equal(input.observations.filter(item => item.kind === "material_read").length, 0,
        "Old material exposure is context-specific even when the public finding is retained");
      assert.ok(!input.evidence.some(item => item.ref === finding.statement), "A finding is a model interpretation, never a generated evidence source");
    } },
    { action: { kind: "propose", proposal: fx.source.proposal }, check: input => {
      assert.deepEqual(input.observations.find(item => item.kind === "finding_recorded"), { kind: "finding_recorded", finding });
      assert.deepEqual(input.observations.at(-1), { kind: "material_read", evidenceRefs: [fx.source.evidence[0]!.ref, fx.source.evidence[1]!.ref] });
    } },
  ]);
  const result = await fx.run(restarted.port, "worker:retained-understanding", { centralContent: nextContext });

  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("versionId" in result.value);
  assert.equal(first.researchCalls(), 3);
  assert.equal(restarted.researchCalls(), 2);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 5);
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.research?.length, 5);
});

test("authorized research can pass the old 32-step boundary on its original grant while keeping each request's working set bounded", async t => {
  const fx = await fixture(t, { calls: 40 });
  const steps: ScriptedStep[] = Array.from({ length: 33 }, () => ({
    action: { kind: "read_material" as const, evidenceRefs: [fx.source.evidence[0]!.ref] }, tokens: 10,
    check: (input: WorkflowImprovementResearchInput) => { assert.ok(input.observations.length <= 20); },
  }));

  steps.push({ action: { kind: "propose", proposal: fx.source.proposal }, tokens: 10,
    check: input => {
      assert.ok(input.observations.length <= 20);
      assert.ok(input.observations.length > 0);
    } });
  const model = scriptedModel(fx.source.proposal, steps);
  const result = await fx.run(model.port, "worker:more-than-32-authorized-steps");

  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("versionId" in result.value);
  assert.equal(model.researchCalls(), 34);
  assert.equal(model.legacyCalls(), 0);
  const state = await fx.read();
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 34);
  assert.deepEqual(centralLearningSpent(state.centralLearningGrants![0]!), { tokens: 340, calls: 34, steps: 34 });
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.research?.length, 34);
  assert.equal(view.value.research?.at(-1)?.record.step, 33);
});
