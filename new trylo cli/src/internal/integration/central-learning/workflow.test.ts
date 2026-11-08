import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowImprovementModel } from "../../learning/agent/subsystems/workflow/adapters/improvement-model.js";
import { createWorkflowImprovementFunding } from "../../learning/agent/subsystems/workflow/adapters/improvement-funding.js";
import { createFileWorkflowImprovementRuntime } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { searchImprovementFixture } from "../../learning/agent/subsystems/workflow/testing/improvement-fixtures.js";
import { runtimeFixture } from "../../learning/agent/subsystems/workflow/testing/improvement-runtime-fixtures.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import type { CentralLearningSourceContext } from "../../learning/control/source-context.js";
import type { WorkflowImprovementEvidenceSnapshot } from "../../learning/agent/subsystems/workflow/runtime/improvement-contracts.js";
import { projectWorkflowCentralFeedback } from "../../learning/agent/subsystems/workflow/adapters/central-feedback.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { record } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { createCentralWorkflowExecution } from "./workflow.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainProvider, domainTestSignal, successfulDomainResponse, withDomainBoard } from "./testing/domain-funding.test.js";

const authorization = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 32000, maxCalls: 1, maxSteps: 1, maxPromptChars: 24000 };

async function workflowFixture(fx: Parameters<Parameters<typeof withDomainBoard>[0]>[0], provider: ReturnType<typeof domainProvider>,
  contextForIssue?: CentralLearningContextReader) {
  const source = searchImprovementFixture();
  const state: { snapshot: WorkflowImprovementEvidenceSnapshot } = { snapshot: {
    executionId: "session:central-workflow/turn:followup", watermark: 100, evidence: source.evidence, receipts: [] } };
  const options = { boardRoot: fx.boardRoot, scope: source.opportunity.task.scope, centralScope: DOMAIN_TEST_SCOPE, research: false,
    budgetId: "run:central-workflow", sessionId: "session:central-workflow", allowance: authorization.maxTokens,
    now: () => Date.parse(DOMAIN_TEST_NOW), publicData: () => true, warn: () => {},
    readEvidence: async () => ({ ok: true as const, value: state.snapshot }),
    newModel: (maxPromptChars: number) => createWorkflowImprovementModel({ provider: provider.provider.fork!(), model: "scripted-domain-transport", maxPromptChars }) };
  const original = createWorkflowImprovementFunding(options);
  const preparedSource = await original.prepare({ type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: source.opportunity, evidence: source.evidence });

  assert.ok(preparedSource.ok);
  const execution = createCentralWorkflowExecution({ ...options, enabled: () => true,
    ...(contextForIssue === undefined ? {} : { contextForIssue }) });
  const prepared = await execution.prepare({ issueId: preparedSource.value.issueId, authorizedAllowance: authorization }, domainTestSignal());
  const funded = await fx.fund(prepared);

  return { source, options, original, preparedSource: preparedSource.value, execution, funded, state };
}

test("managed workflow reaches its real model/worker/publication and a later task adopts the actual version", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(searchImprovementFixture().proposal));
  const originalContext = { ref: "central-content:workflow-question-and-answer",
    text: "Original requirement: preserve complete source evidence. Existing answer: owner reuse works only after confirming the current snapshot." };
  let context = originalContext;
  const h = await workflowFixture(fx, provider, async () => context);
  const smallerPrompt = await h.execution.prepare({ issueId: h.funded.issueId, authorizedAllowance: authorization,
    operationAllowance: { ...authorization, maxPromptChars: authorization.maxPromptChars - 1 } }, domainTestSignal());

  assert.equal(smallerPrompt.status, "unavailable", "the v1 source must not quote an envelope its original dispatch cannot execute");
  const mismatched = await h.execution.dispatch({ ...h.funded, policyRef: "workflow:unregistered-policy",
    offer: { ...h.funded.offer, policyRef: "workflow:unregistered-policy" } }, domainTestSignal());

  assert.equal(mismatched.ok, false);
  assert.equal(provider.requests.length, 0);
  context = { ...originalContext, text: "A changed body under the same reference must invalidate the prepared source hash." };
  assert.equal((await h.execution.dispatch(h.funded, domainTestSignal())).ok, false);
  assert.equal(provider.requests.length, 0);
  context = originalContext;
  const result = await h.execution.dispatch(h.funded, domainTestSignal());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(result.workAttempted, true);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]!.tools?.length, 0);
  const modelInput = provider.requests[0]!.messages.find(message => message.role === "user")!.content;

  assert.deepEqual(JSON.parse(modelInput).centralContent, originalContext, "the source analysis must enter the actual model prompt, before original token accounting");
  const observation = await h.execution.observe(h.funded, domainTestSignal());

  assert.equal(observation.outcome, "qualified");
  assert.equal(observation.resultRefs.length, 1);
  const state = await fx.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(grant.grantId, h.funded.grantId);
  assert.equal(grant.status, "closed");
  assert.deepEqual(centralLearningSpent(grant), { tokens: 1500, calls: 1, steps: 1 });
  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.activations.length, 0);
  const runtime = createFileWorkflowImprovementRuntime({ ...h.options, newModel: () => h.options.newModel(authorization.maxPromptChars) });
  const adopted = await runtime.context("next-task", { task: h.source.opportunity.task, boundary: "before scoped source search" });

  assert.ok(adopted.ok);
  assert.ok(adopted.value !== null && typeof adopted.value === "object");
  assert.equal(Reflect.get(adopted.value, "status"), "frozen");
  assert.equal((await h.execution.dispatch(h.funded, domainTestSignal())).ok, false);
  assert.equal(provider.requests.length, 1);
  const reopened = createCentralWorkflowExecution({ ...h.options, enabled: () => true });

  assert.equal((await reopened.observe(h.funded, domainTestSignal())).outcome, "qualified", "the exact original dispatch receipt survives an adapter restart");
  assert.equal((await reopened.observe({ ...h.funded, expectedIssueRevision: h.funded.expectedIssueRevision + 1 }, domainTestSignal())).outcome, "pending",
    "an archived receipt cannot be rebound to another exact input");
  assert.equal((await reopened.observe({ ...h.funded, stageRef: "workflow-stage:old-without-an-original-receipt" }, domainTestSignal())).outcome, "pending",
    "old unrecorded stages cannot be reconstructed from the grant's later final result");
  const anotherRun = createCentralWorkflowExecution({ ...h.options, budgetId: "different-run-budget", enabled: () => true });
  const beforeReprepare = await fx.load();
  const replayed = await anotherRun.prepare({ issueId: h.funded.issueId, authorizedAllowance: authorization }, domainTestSignal());

  assert.equal(replayed.status, "terminal", "changing the run budget cannot buy another request for the same saved input");
  assert.equal((await fx.load()).sequence, beforeReprepare.sequence);
  await runtime.close();
}));

test("workflow cancellation retains unknown usage on the same managed grant and never labels a proposal", async () => withDomainBoard(async fx => {
  const controller = new AbortController();
  const provider = domainProvider(async function* () {
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: 10, totalTokens: 110,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    controller.abort("contract-cancel");
  });
  const h = await workflowFixture(fx, provider);
  const result = await h.execution.dispatch(h.funded, controller.signal);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "cancelled");
  const state = await fx.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(grant.reservations[0]?.usage?.kind, "unknown");
  assert.equal(grant.status, "closed");
  assert.equal(centralLearningSpent(grant).tokens, authorization.maxTokens);
  assert.equal((await h.execution.observe(h.funded, domainTestSignal())).outcome, "pending");
  assert.equal(provider.requests.length, 1);
  assert.equal(state.assets.filter(item => item.versionId.startsWith("wfi:workflow_improvement:")).length, 0);
}));

test("workflow reserve checks the issue revision under the original writer before claim or paid send", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(searchImprovementFixture().proposal));
  const h = await workflowFixture(fx, provider), state = await fx.load();
  const grant = state.centralLearningGrants![0]!;
  const exact = createWorkflowImprovementFunding({ ...h.options, binding: { grantId: grant.grantId,
    inputVersionId: h.preparedSource.inputVersionId, expectedIssueRevision: h.funded.expectedIssueRevision - 1 } });
  const reserved = await exact.reserve({ grantId: grant.grantId, jobId: grant.jobId,
    inputVersionId: h.preparedSource.inputVersionId, state: "queued", resultRefs: [] });

  assert.equal(reserved.ok, false, "stale source basis must not acquire a reservation");
  const after = await fx.load();
  assert.equal(after.sequence, state.sequence);
  assert.equal(after.centralLearningGrants![0]!.claim, undefined);
  assert.equal(after.centralLearningGrants![0]!.reservations.length, 0);
  assert.equal(provider.requests.length, 0);
}));

test("normal workflow hooks nominate real source-only work for central investment without an independent grant or background worker", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(searchImprovementFixture().proposal));
  const normal = runtimeFixture(fx.boardRoot, { centralScope: DOMAIN_TEST_SCOPE });
  const newModel = (maxPromptChars: number) => createWorkflowImprovementModel({ provider: provider.provider.fork!(), model: "scripted-domain-transport", maxPromptChars });
  const execution = createCentralWorkflowExecution({ ...normal.options, newModel, research: false, enabled: () => true });
  const runtime = createFileWorkflowImprovementRuntime({ ...normal.options,
    newModel: () => newModel(authorization.maxPromptChars), nominateOpportunity: execution.queueOpportunity });
  const nominated = await runtime.opportunity("actual-workflow-hook", normal.fixture.opportunity, domainTestSignal());

  assert.ok(nominated.ok, JSON.stringify(nominated));
  assert.ok(nominated.value !== null && typeof nominated.value === "object");
  assert.equal(Reflect.get(nominated.value, "status"), "queued_for_central");
  const sourceOnly = await fx.load();

  assert.equal(sourceOnly.centralLearningGrants?.length ?? 0, 0);
  assert.equal(sourceOnly.jobs.length, 0);
  assert.equal(sourceOnly.learningIssues?.length, 1);
  assert.equal(provider.requests.length, 0);
  assert.equal(normal.calls(), 0);
  const issueId = sourceOnly.learningIssues![0]!.issueId;
  const impossible = await execution.prepare({ issueId, authorizedAllowance: { ...authorization, maxPromptChars: 0 } }, domainTestSignal());

  assert.equal(impossible.status, "unavailable", "the original prompt preflight must reject an unusable envelope before funding");
  assert.equal((await fx.load()).sequence, sourceOnly.sequence);
  assert.equal(provider.requests.length, 0);
  const tooLong = createCentralWorkflowExecution({ ...normal.options, newModel, research: false, enabled: () => true,
    contextForIssue: async () => ({ ref: "central-content:full-packet-exceeds-domain-envelope", text: "x".repeat(24000) }) });

  assert.equal((await tooLong.prepare({ issueId, authorizedAllowance: authorization }, domainTestSignal())).status, "unavailable");
  assert.equal((await fx.load()).sequence, sourceOnly.sequence);
  assert.equal(provider.requests.length, 0);
  const prepared = await execution.prepare({ issueId, authorizedAllowance: authorization }, domainTestSignal());
  const funded = await fx.fund(prepared), worked = await execution.dispatch(funded, domainTestSignal());

  assert.ok(worked.ok, JSON.stringify(worked));
  assert.equal(worked.status, "completed");
  assert.equal(provider.requests.length, 1);
  assert.equal((await execution.observe(funded, domainTestSignal())).outcome, "qualified");
  await runtime.close();
  await normal.runtime.close();
}));

test("central source freshness is rechecked by the original preparation writer across host run prefixes", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(searchImprovementFixture().proposal));
  const h = await workflowFixture(fx, provider);
  const worked = await h.execution.dispatch(h.funded, domainTestSignal());
  assert.ok(worked.ok);
  assert.equal(worked.status, "completed");
  const before = await fx.load();
  const raced = createWorkflowImprovementFunding({ ...h.options, budgetId: "a-new-run-after-another-worker-finished",
    preparation: { kind: "central_source" } });
  const prepared = await raced.prepare({ type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: h.source.opportunity, evidence: h.source.evidence });

  assert.equal(prepared.ok, false, "a stale pre-read cannot let the writer refocus and rebuy the same sent input");
  const after = await fx.load();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.learningIssues![0]!.revision, before.learningIssues![0]!.revision);
  assert.equal(provider.requests.length, 1);
}));

test("normal workflow adoption and attributed feedback change the next source context and reach its real researcher prompt", async () => withDomainBoard(async fx => {
  let output: unknown = searchImprovementFixture().proposal;
  const provider = domainProvider(() => successfulDomainResponse(output));
  let context: CentralLearningSourceContext | undefined;
  const h = await workflowFixture(fx, provider, async () => context);

  assert.ok((await h.execution.dispatch(h.funded, domainTestSignal())).ok);
  const runtime = createFileWorkflowImprovementRuntime({ ...h.options, newModel: () => h.options.newModel(authorization.maxPromptChars),
    nominateOpportunity: h.execution.queueOpportunity });
  const adopted = await runtime.context("normal-handoff", { task: h.source.opportunity.task, boundary: "before following the revised search" });

  assert.ok(adopted.ok);
  assert.ok(record(adopted.value));
  assert.ok(record(adopted.value.use));
  const before = projectWorkflowCentralFeedback(await fx.load(), { scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId });
  assert.ok(before);
  assert.equal(before.records.filter(item => item.kind === "workflow_frozen_use").length, 1);
  const receiptRef = "receipt:post-adoption-read";

  h.state.snapshot = { ...h.state.snapshot, watermark: 101,
    evidence: [...h.state.snapshot.evidence, { ref: receiptRef, kind: "tool_success", summary: "A controlled normal-consumer source read returned successfully.", executionId: h.state.snapshot.executionId }],
    receipts: [{ ref: receiptRef, sequence: 101, executionId: h.state.snapshot.executionId, toolCallId: "post-adoption-read",
      tool: "read_file", outcome: "succeeded" }] };
  const feedback = await runtime.feedback("normal-feedback", { useId: adopted.value.use.useId, exposure: "reported_used",
    evidenceRefs: [receiptRef], followedStepIds: ["confirm-owner"],
    explanation: "The procedure was selected and the source read succeeded; full-path following and benefit remain unverified." });

  assert.ok(feedback.ok, JSON.stringify(feedback));
  const after = projectWorkflowCentralFeedback(await fx.load(), { scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId });
  assert.ok(after);
  assert.notEqual(after.sourceRef, before.sourceRef);
  const report = after.records.find(item => item.kind === "workflow_feedback");
  assert.ok(report);
  assert.equal(report.quality, "unknown");
  assert.equal(Object.hasOwn(report, "comparison"), false);
  assert.equal(typeof report.feedbackId, "string");
  context = { ref: after.sourceRef, text: canonicalJson(after.records) };
  const nominated = await runtime.opportunity("followup-question", { ...h.source.opportunity,
    problem: "Determine what evidence is still needed after this partially reported adoption.",
    evidenceRefs: ["receipt:search-1", receiptRef, report.feedbackId] });

  assert.ok(nominated.ok, JSON.stringify(nominated));
  const prepared = await h.execution.prepare({ issueId: h.funded.issueId, authorizedAllowance: authorization }, domainTestSignal());
  const next = await fx.fund(prepared);
  output = { abstain: true };
  const attempted = await h.execution.dispatch(next, domainTestSignal());
  assert.equal(attempted.workAttempted, true);
  assert.equal(provider.requests.length, 2);
  const material = JSON.parse(provider.requests[1]!.messages.find(message => message.role === "user")!.content);

  assert.deepEqual(material.centralContent, context);
  assert.ok(material.feedback.some((item: { feedbackId: string }) => item.feedbackId === report.feedbackId));
  assert.equal((await h.execution.observe(next, domainTestSignal())).outcome, "pending", "abstention/failure is not silently relabelled as a measured effect");
  await runtime.close();
}));
