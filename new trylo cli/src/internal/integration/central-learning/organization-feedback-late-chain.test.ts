import assert from "node:assert/strict";
import test from "node:test";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningConfiguration,
  CentralLearningIntentDraft, CentralLearningRuntimeState } from "../../learning/central/runtime/contracts.js";
import type { OrganizationFeedback } from "../../learning/central/organization/contracts.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { completeOperation, startWork } from "../../learning/central/runtime/transitions.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { createWorkflowImprovementFunding } from "../../learning/agent/subsystems/workflow/adapters/improvement-funding.js";
import { createWorkflowImprovementModel } from "../../learning/agent/subsystems/workflow/adapters/improvement-model.js";
import { createFileWorkflowImprovementRuntime, fileWorkflowImprovementPorts } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { commitWorkflowImprovementRecord } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { parseWorkflowImprovementFeedback } from "../../learning/agent/subsystems/workflow/improvement/index.js";
import { searchImprovementFixture } from "../../learning/agent/subsystems/workflow/testing/improvement-fixtures.js";
import type { WorkflowImprovementEvidenceSnapshot } from "../../learning/agent/subsystems/workflow/runtime/improvement-contracts.js";
import { record } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { createCentralWorkflowExecution } from "./workflow.js";
import { createCentralRuntimeAgentExecution } from "./runtime-agent-execution.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralOrganizationFeedbackRefresh } from "./organization-feedback.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { centralOrganizationDeliberationRef } from "./organization-feedback-runtime.js";
import { centralDeliberationReservation } from "./deliberation-prompt.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainProvider, domainTestSignal,
  successfulDomainResponse, withDomainBoard } from "./testing/domain-funding.test.js";

const scope = DOMAIN_TEST_SCOPE, signal = domainTestSignal();
const rootAllowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 100000, maxCalls: 16, maxSteps: 16, maxPromptChars: 40000 };
const increment = { ...rootAllowance, maxTokens: 32000, maxCalls: 1, maxSteps: 1, maxPromptChars: 24000 };
const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "late-chain:configuration",
  authorizationRef: "late-chain:authorization", allowance: rootAllowance };

type Fixture = Parameters<Parameters<typeof withDomainBoard>[0]>[0];

async function scenario(fx: Fixture) {
  const source = searchImprovementFixture(), provider = domainProvider(() => successfulDomainResponse(source.proposal));
  const evidence: { snapshot: WorkflowImprovementEvidenceSnapshot } = { snapshot: {
    executionId: "session:late-chain/turn:source", watermark: 100, evidence: source.evidence, receipts: [] } };
  const options = { boardRoot: fx.boardRoot, scope: source.opportunity.task.scope, centralScope: scope, research: false,
    budgetId: "late-chain:workflow-source", sessionId: "session:late-chain", allowance: increment.maxTokens,
    now: () => Date.parse(DOMAIN_TEST_NOW), publicData: () => true, warn: () => {},
    readEvidence: async () => ({ ok: true as const, value: evidence.snapshot }),
    newModel: (maxPromptChars: number) => createWorkflowImprovementModel({ provider: provider.provider.fork!(), model: "scripted-domain-transport", maxPromptChars }) };
  const prepared = await createWorkflowImprovementFunding(options).prepare({ type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: source.opportunity, evidence: source.evidence });

  assert.ok(prepared.ok, JSON.stringify(prepared));
  let board = await fx.load();
  const issue = board.learningIssues!.find(row => row.issueId === prepared.value.issueId)!;
  if (issue.decision.kind === "unreviewed") {
    await fx.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
      reason: "The original owner selected a bounded source-navigation investigation", sourceRefs: [issue.reports[0]!.reportId] });
  } else assert.equal(issue.decision.kind, "focused_learning");

  const operation = { kind: "dispatch" as const, operationId: "late-chain:D0", allowance: increment,
    purpose: "Investigate the original source-navigation gap", expectedChange: "Deliver a conditional procedure for later real use",
    sourceRefs: [prepared.value.inputVersionId] };
  const intent: CentralLearningIntentDraft = { intentId: "late-chain:original-purpose", subject: { plane: "agent", domain: "workflow", issueId: issue.issueId },
    goal: "Preserve complete source evidence when narrowing navigation", rationale: "The original discarded searches justify a bounded proposal",
    conditions: ["Current source-navigation process"], knowledge: [], residual: ["Does the original proposed procedure survive real use?"],
    commitment: { purpose: "Test the original procedure against later use", assumptions: [], reconsiderWhen: ["A real use or correction arrives"] },
    revisionReason: "Retain the original purpose", sourceRefs: [prepared.value.inputVersionId], continuation: { kind: "ready", operation } };
  const store = createCentralRuntimeStore({ boardRoot: fx.boardRoot, enabled: () => true });
  const save = async (change: (state: CentralLearningRuntimeState) => CentralLearningRuntimeState, reason: string) => {
    const cursor = await store.read(scope);
    const result = await store.append({ expectedRevision: cursor.revision, previousRef: cursor.stateRef, state: change(cursor.state),
      reason, sourceRefs: [operation.operationId] });
    assert.equal(result.status, "written", reason);
  };

  await save(() => ({ ...emptyCentralRuntimeState(scope), intents: [intent] }), "late_chain_original_purpose");
  const service = createCentralOrganizationService({ boardRoot: fx.boardRoot, scope, enabled: () => true });
  const organization = createCentralRuntimeOrganization({ boardRoot: fx.boardRoot, scope, workspaceId: options.scope, enabled: () => true, service });
  const request = async (operationId: string): Promise<CentralDeliberationRequest> => {
    const cursor = await store.read(scope);
    return { schemaVersion: 1, scope, budgetId: "budget:domain-contract", configuration, boardSequence: cursor.revision,
      resources: { boardSequence: cursor.revision, budgetId: "budget:domain-contract", limits: { tokens: 100000, calls: 16, steps: 16 },
        occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 16, steps: 16 }, status: "available", holdReason: null },
      stateRef: cursor.stateRef, state: cursor.state, opportunities: [], materials: [], organization: [],
      operation: { kind: "think", operationId, purpose: `Organize the original purpose at ${operationId}`,
        expectedChange: "Choose the next bounded investigation", sourceRefs: [prepared.value.inputVersionId] } };
  };
  const originalRequest = await request("late-chain:C0"), output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent],
    publicExplanation: "Dispatch the original source-navigation investigation", sourceRefs: [prepared.value.inputVersionId],
    alternatives: ["Wait for later use"] };
  const accounting = createCentralAccountingFundingAtRoot({ boardRoot: fx.boardRoot, budgetId: originalRequest.budgetId, scope,
    owner: { kind: "central_deliberation", ownerId: originalRequest.operation.operationId }, enabled: () => true, now: () => DOMAIN_TEST_NOW });
  const reservationId = centralDeliberationReservation(originalRequest);

  assert.ok((await accounting.reserve({ reservationId, maxTokens: 500 })).ok);
  assert.ok((await accounting.settle({ reservationId, usage: { kind: "reported", totalTokens: 123 } })).ok);
  await organization.recordDecision!({ request: originalRequest, output, decisionRef: originalRequest.operation.operationId, role: "deliberation" }, signal);
  await organization.recordDecision!({ request: originalRequest, output, decisionRef: operation.operationId, role: "operation_expectation" }, signal);
  const execution = createCentralWorkflowExecution({ ...options, enabled: () => true });
  const agent = createCentralRuntimeAgentExecution({ boardRoot: fx.boardRoot, scope, ports: [execution], enabled: () => true,
    now: () => DOMAIN_TEST_NOW, rootAllowance, authorizationRef: configuration.authorizationRef,
    control: { decide: async () => { throw new Error("The original workflow issue was already focused; no substitute decision may be injected"); } } });
  const work = await agent.prepare({ scope, intent, operation, configuration, signal });

  await save(state => startWork(state, work), "late_chain_original_running_work");
  const returned = await agent.execute(work, signal);

  assert.equal(returned.outcome, "returned", returned.publicResult);
  assert.equal(provider.requests.length, 1);
  board = await fx.load();
  const grant = board.centralLearningGrants!.find(row => row.issueId === issue.issueId)!;
  const job = board.jobs.find(row => row.jobId === grant.jobId)!;

  assert.equal(job.state, "succeeded");
  const versionId = job.coordination!.resultRefs!.find(ref => board.assets.some(asset => asset.versionId === ref && record(asset.content)
    && asset.content.type === "workflow_improvement"));
  assert.ok(versionId, "the real domain worker must publish A");
  assert.ok(returned.resultRefs.includes(versionId));
  await save(state => ({ ...completeOperation(state, { intentId: intent.intentId, operation, result: returned, workRef: work.workRef }),
    intents: [{ ...intent, continuation: { kind: "waiting", wait: { kind: "use_feedback", sourceRefs: [versionId], reason: "Await actual normal use" } } }] }),
  "late_chain_original_completed_work");
  // Actual recordDecision freezes both roles. No fabricated OrganizationDecision
  // rows, model/provider call or post-hoc role mutation makes D0 old enough.
  const newer: string[] = [];

  for (let index = 0; index < 4; index++) {
    const think = { kind: "think" as const, operationId: `late-chain:think:${index}`, purpose: `Reconsider a separate residual ${index}`,
      expectedChange: "Decide whether more original evidence is needed", sourceRefs: [prepared.value.inputVersionId] };
    const ready = { ...intent, revisionReason: `Local scripted continuation ${index}`, continuation: { kind: "ready" as const, operation: think } };
    const selectedOutput = { ...output, intents: [ready], publicExplanation: `Select bounded reconsideration ${index}` };

    await organization.recordDecision!({ request: await request(`late-chain:selector:${index}`), output: selectedOutput,
      decisionRef: think.operationId, role: "operation_expectation" }, signal);
    const waiting = { ...ready, continuation: { kind: "waiting" as const, wait: { kind: "facts" as const,
      sourceRefs: [prepared.value.inputVersionId], reason: "Await another actual source" } } };
    const ownOutput = { ...output, intents: [waiting], publicExplanation: `No new source claim was established in reconsideration ${index}` };

    await organization.recordDecision!({ request: await request(think.operationId), output: ownOutput,
      decisionRef: think.operationId, role: "deliberation" }, signal);
    const completed: CentralCompletedOperation = { intentId: intent.intentId, operation: think, outcome: "returned",
      resultRefs: [`late-chain:public-thought:${index}`], publicResult: ownOutput.publicExplanation };

    await save(state => ({ ...state, intents: [waiting], completed: [...state.completed, completed] }), `late_chain_scripted_think_${index}`);
    newer.push(think.operationId, centralOrganizationDeliberationRef(scope, think.operationId));
  }

  const runtime = createFileWorkflowImprovementRuntime({ ...options, newModel: () => options.newModel(increment.maxPromptChars),

    assessQuality: async input => {
      assert.ok(input.receipts.some(row => row.ref === "checker:late-failed" && row.checkStatus === "failed"));
      return { ok: true, value: { quality: "failed" } };
    } });

  return { source, provider, options, evidence, runtime, service, store, request, operation, originalRequest, versionId,
    issueId: issue.issueId, newer, reservationId };
}

test("one real late workflow use and correction reach its original producer and selecting agenda beyond eight newer decisions", async () => withDomainBoard(async fx => {
  const h = await scenario(fx);
  try {
    const c0 = centralOrganizationDeliberationRef(scope, h.originalRequest.operation.operationId), d0 = h.operation.operationId;
    const frozen = await h.service.read();
    assert.equal(frozen.status, "ready");
    if (frozen.status !== "ready") return;

    assert.equal(frozen.projection.decisions.filter(row => h.newer.includes(row.value.decisionRef)).length, 8);
    const adopted = await h.runtime.context("late-chain:normal-use", { task: h.source.opportunity.task,
      boundary: "Before a current source-navigation task", versionId: h.versionId });

    assert.ok(adopted.ok && record(adopted.value) && record(adopted.value.use));
    const useId = String(adopted.value.use.useId);
    assert.equal(adopted.value.use.versionId, h.versionId);
    h.evidence.snapshot = { ...h.evidence.snapshot, executionId: "session:late-chain/turn:normal-use", watermark: 120,
      receipts: [{ ref: "checker:late-failed", sequence: 110, executionId: "session:late-chain/turn:normal-use",
        toolCallId: "late-source-check", tool: "run_shell", outcome: "succeeded", checkStatus: "failed" }] };
    const feedback = await h.runtime.feedback("late-chain:normal-feedback", { useId, exposure: "reported_used",
      evidenceRefs: ["checker:late-failed"], followedStepIds: ["confirm-owner"], explanation: "The host checker found incomplete source evidence after this real use." });

    assert.ok(feedback.ok, JSON.stringify(feedback));
    const view = await fileWorkflowImprovementPorts(h.options).store.read();
    assert.ok(view.ok);
    const base = view.value.feedback.find(row => row.useId === useId)!;
    assert.equal(base.quality, "failed");
    const createRefresh = (service = h.service) => createCentralOrganizationFeedbackRefresh({ boardRoot: fx.boardRoot, scope, workspaceId: h.options.scope,
      enabled: () => true, service });
    const refresh = createRefresh(), failed = await refresh.refresh({ issueRefs: [h.issueId] }, signal);

    assert.equal(failed.status, "ready", JSON.stringify(failed));
    if (failed.status !== "ready") return;

    const first = await h.service.read();
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;

    const firstRows = (ref: string) => first.projection.feedback.filter(row => row.value.decisionRef === ref);

    assert.ok(firstRows(d0).some(row => row.value.result.kind === "adoption" && row.value.result.state === "used"),
      "old producing D0 must receive the real use even after eight newer role decisions");
    const priorOutcomes = new Map<string, { readonly factId: string; readonly unitRef: string }>();

    for (const decisionRef of [d0, c0]) {
      assert.ok(firstRows(decisionRef).some(row => row.value.result.kind === "adoption" && row.value.result.state === "used"));
      const outcome = firstRows(decisionRef).find(row => row.value.result.kind === "outcome" && row.value.result.state === "observed"
        && row.value.result.attribution === "unknown" && row.value.result.summary.includes("failed"));
      assert.ok(outcome);
      priorOutcomes.set(decisionRef, { factId: outcome.factId, unitRef: outcome.value.unitRef });
    }

    const correction = parseWorkflowImprovementFeedback({ ...base,
      userAssessment: { judgment: "harmed", evidenceRef: "user:late-chain-harmed" }, explanation: "The user says this same use hindered source investigation." });

    assert.ok(correction.ok);
    assert.ok((await commitWorkflowImprovementRecord(fx.boardRoot, { type: "workflow_improvement_feedback", schemaVersion: 1,
      feedback: correction.value }, DOMAIN_TEST_NOW)).ok);
    const abort = new AbortController();
    let writesBeforeAbort = 0;
    const interrupted = createRefresh({ ...h.service, async observe(value, expected) {
      const saved = await h.service.observe(value, expected);
      if (saved.status === "saved" && !saved.idempotent) {
        writesBeforeAbort++;
        abort.abort("after one confirmed original feedback revision");
      }
      return saved;
    } });
    const partial = await interrupted.refresh({ issueRefs: [h.issueId] }, abort.signal);

    assert.equal(partial.status, "rejected");
    assert.equal(writesBeforeAbort, 1, "one original revision commits before interruption");
    const reopened = createCentralOrganizationService({ boardRoot: fx.boardRoot, scope, enabled: () => true });
    const refreshed = await createRefresh(reopened).refresh({ issueRefs: [h.issueId] }, signal);

    assert.equal(refreshed.status, "ready", JSON.stringify(refreshed));
    if (refreshed.status !== "ready") return;

    const observed = await reopened.read();
    assert.equal(observed.status, "ready");
    if (observed.status !== "ready") return;

    const rows = (ref: string) => observed.projection.feedback.filter(row => row.value.decisionRef === ref);

    for (const decisionRef of [d0, c0]) {
      assert.ok(rows(decisionRef).some(row => row.value.result.kind === "adoption" && row.value.result.state === "used"));
      assert.ok(rows(decisionRef).some(row => row.value.result.kind === "outcome" && row.value.result.state === "observed"
        && row.value.result.attribution === "unknown" && row.value.result.summary.includes("failed")));
      assert.ok(rows(decisionRef).some(row => row.value.result.kind === "correction" && row.value.result.statement.includes("harmed")));
      const revised = rows(decisionRef).find(row => row.value.result.kind === "outcome" && row.value.unitRef === priorOutcomes.get(decisionRef)!.unitRef)!;
      assert.equal(revised.value.supersedes, priorOutcomes.get(decisionRef)!.factId, "same U/F correction replaces its prior organization outcome head");
    }

    assert.ok(h.newer.every(ref => !rows(ref).some(row => row.value.result.kind === "adoption" || row.value.result.kind === "outcome"
      || row.value.result.kind === "correction")), "same-issue newer thoughts only receive background, never fabricated ownership");
    const catalogs = refreshed.materials.map(material => JSON.parse(material.text) as Record<string, unknown>)
      .filter(body => body.role === "organization_feedback_relationship_catalog_not_read_body");

    assert.ok(catalogs.some(body => {
      const entries = body.entries;
      return body.issueId === h.issueId && Array.isArray(entries)
        && h.newer.every(ref => entries.some(entry => record(entry) && entry.decisionRef === ref && entry.relation === "related_background"));
    }));
    const units = new Map<string, Set<string>>();

    for (const row of [...rows(d0), ...rows(c0)]) {
      const owners = units.get(row.value.unitRef) ?? new Set<string>();
      owners.add(row.value.decisionRef);
      units.set(row.value.unitRef, owners);
    }

    assert.ok([...units.values()].some(owners => owners.has(d0) && owners.has(c0)), "two decision projections retain one original source unit");
    const c0Feedback = rows(c0).find(row => row.value.result.kind === "correction")!;
    const source = createCentralRuntimeSource({ boardRoot: fx.boardRoot, scope, ports: [], enabled: () => true });
    const exact = await source.read(scope, [c0Feedback.factId], 32768, signal);
    const original = exact.map(material => readOrganizationFeedbackMaterial(material, scope)).find(value => value !== undefined);

    assert.ok(original);
    assert.equal(original.factId, c0Feedback.factId);
    assert.equal(original.value.decisionRef, c0);
    assert.equal(original.value.unitRef, c0Feedback.value.unitRef);
    const costs = observed.projection.feedback.filter(row => [d0, c0].includes(row.value.decisionRef) && row.value.result.kind === "cost"
      && row.value.sourceRefs.includes(h.reservationId));

    assert.equal(costs.length, 2);
    assert.equal(new Set(costs.map(row => row.value.unitRef)).size, 1);
    const once = new Map<string, OrganizationFeedback>();
    for (const cost of costs) once.set(cost.value.unitRef, cost.value);

    assert.equal([...once.values()].reduce((sum, row) => sum + (row.result.kind === "cost" && row.result.usage.kind === "reported" ? row.result.usage.tokens : 0), 0), 123);
    const count = (await fx.load()).rewardV2Facts!.length;

    assert.equal((await refresh.refresh({ issueRefs: [h.issueId] }, signal)).status, "ready");
    assert.equal((await createRefresh().refresh({ issueRefs: [h.issueId] }, signal)).status, "ready");
    assert.equal((await fx.load()).rewardV2Facts!.length, count, "repeat and restarted refresh must not add facts or samples");
    assert.equal(h.provider.requests.length, 1, "mechanical backfill never buys a planning or worker call");
    assert.equal(base.feedbackId, correction.value.feedbackId);
    assert.equal(base.useId, correction.value.useId);
    assert.equal(canonicalJson(base.task), canonicalJson(correction.value.task));
  } finally { await h.runtime.close(); }
}));
