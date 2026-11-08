import assert from "node:assert/strict";
import test from "node:test";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { collaborationSourceAdmission } from "../../learning/agent/subsystems/collaboration/control/source-admission.js";
import { createCollaborationWorker } from "../../learning/agent/subsystems/collaboration/orchestration/worker.js";
import { createCollaborationDecisionModel } from "../../learning/agent/subsystems/collaboration/runtime/decision-model.js";
import { createCollaborationExperienceStore } from "../../learning/agent/subsystems/collaboration/experience/store.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import { projectCollaborationCentralFeedback } from "../../learning/agent/subsystems/collaboration/runtime/central-feedback.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { readCollaborationNoChange } from "../../learning/agent/subsystems/collaboration/orchestration/no-change-receipt.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import type { CentralFundedStage } from "./contracts.js";
import { createCentralCollaborationExecution } from "./collaboration.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainProvider, domainTestSignal, successfulDomainResponse, withDomainBoard } from "./testing/domain-funding.test.js";

const authorization = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 20000, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 };
const owner = { kind: "personal_agent" as const, experienceKey: "trylo.personal_agent.v1" };
const reportId = "report:central-collaboration";
const proposal = () => ({ kind: "propose", familyId: "artifact-handoff", title: "Keep the artifact identity in the handoff",
  summary: "Missing artifact identity causes receiver rework; test an explicit reference at the next relevant boundary.",
  sourceRefs: [reportId], adjustments: [{ memberId: "personal_agent", kind: "handoff",
    instruction: "Include the artifact version and remaining unresolved work before handing over." }],
  experiences: [{ ownerRef: "personal_agent", familyId: "artifact-handoff", situation: "Before handing an artifact to a dependent receiver",
    responsibilities: ["Preserve the handoff identity"], practice: "Include its version reference and unresolved work; ask the receiver to confirm the exact artifact.",
    sourceRefs: [reportId] }], needs: [] });

async function collaborationFixture(fx: Parameters<Parameters<typeof withDomainBoard>[0]>[0], provider: ReturnType<typeof domainProvider>, maxCalls = 2,
  contextForIssue?: CentralLearningContextReader, onWorkerContext?: () => void) {
  const board = createFileCollaborationBoard(fx.boardRoot);
  const receiptWriter = createCollaborationRuntimeReceiptWriter({ board, scope: DOMAIN_TEST_SCOPE });
  const experience = createCollaborationExperienceStore({ board, scope: DOMAIN_TEST_SCOPE, now: () => DOMAIN_TEST_NOW,
    recordRuntimeReceipt: receiptWriter.record });
  const worker = createCollaborationWorker({ board, scope: DOMAIN_TEST_SCOPE, now: () => DOMAIN_TEST_NOW,
    model: createCollaborationDecisionModel({ provider: provider.provider, model: "scripted-domain-transport" }),
    resources: { async query() { return { ok: false, reason: "test_did_not_register_a_resource_query" }; } },

    context: async () => {
      onWorkerContext?.();
      return { surface: "code", owners: [{ ref: "personal_agent", owner }] };
    },

    async prepareDependencies(input) {
      return { ok: true, resultRefs: input.dependencies.flatMap(dependency => dependency.state.kind === "ready" ? [dependency.state.resultRef] : []) };
    },

    async experienceInput(issueId, draft) {
      if (draft.ownerRef !== "personal_agent") return { ok: false, reason: "experience_owner_unknown" };
      return { ok: true, input: { issueId, owner, familyId: draft.familyId, situation: draft.situation,
        responsibilities: draft.responsibilities, practice: draft.practice, sourceRefs: draft.sourceRefs } };
    }, preflightExperience: experience.preflightExperience, publishExperience: experience.publishExperience });
  const control = createCollaborationControl({ board, worker, now: () => DOMAIN_TEST_NOW, ownerId: "central-collaboration-contract" });
  const reported = await control.report({ scope: DOMAIN_TEST_SCOPE, problemKey: "artifact-handoff", report: {
    reportId, source: { teamRunId: "team:central-contract", taskId: "task:central-contract", memberId: "receiver" },
    facts: ["The receiver repeated work because the handoff omitted its exact artifact reference."], evidenceRefs: ["execution:receiver-rework"] } });

  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Explicit local contract focus; no effectiveness claim.", sourceRefs: [reportId] });

  assert.ok(focused.ok);
  const execution = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control,
    ...(contextForIssue === undefined ? {} : { contextForIssue }) });
  const cap = { ...authorization, maxCalls, maxSteps: maxCalls };
  const prepared = await execution.prepare({ issueId: focused.issue.issueId, authorizedAllowance: cap }, domainTestSignal());
  const funded = await fx.fund(prepared);

  return { control, experience, execution, funded, cap };
}

test("managed collaboration reaches its real decision worker, publishes owner-bound trial versions and keeps later retrieval", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(proposal()));
  const originalContext = { ref: "central-content:collaboration-original-question", text: "Original requirement: retain member ownership. Existing answer applies only when the receiver acknowledges the exact artifact version." };
  let context = originalContext;
  const h = await collaborationFixture(fx, provider, 2, async () => context, () => {
    context = { ref: "central-content:arrived-after-dispatch-admission", text: "A later source packet must wait for another decision basis." };
  });

  context = { ...originalContext, text: "A changed analysis under the same reference invalidates preparation." };
  assert.equal((await h.execution.dispatch(h.funded, domainTestSignal())).ok, false);
  assert.equal(provider.requests.length, 0);
  context = originalContext;
  const result = await h.execution.dispatch(h.funded, domainTestSignal());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  assert.equal(result.workAttempted, true);
  const observation = await h.execution.observe(h.funded, domainTestSignal());

  assert.equal(observation.outcome, "qualified");
  assert.equal(observation.resultRefs.length, 2);
  const state = await fx.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(grant.grantId, h.funded.grantId);
  assert.equal(grant.status, "closed");
  assert.deepEqual(centralLearningSpent(grant), { tokens: 1500, calls: 1, steps: 1 });
  assert.equal(provider.requests.length, 1);
  assert.equal(state.activations.length, 0);
  const body = JSON.parse(provider.requests[0]!.messages.find(message => message.role === "user")!.content);

  assert.deepEqual(body.material.centralContent, originalContext, "the original decision prompt and funding estimate see the same frozen source packet");
  assert.ok(state.proposals.filter(item => item.domain === "collaboration").every(item => item.lifecycle === "evaluating"));
  const prepared = await h.experience.prepareExperience({ owner, maxChars: 600 });
  assert.ok(prepared.ok);
  assert.equal(prepared.versionIds.length, 1);
  assert.match(prepared.text, /artifact/);
  const reopened = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control: h.control });

  assert.equal((await reopened.observe(h.funded, domainTestSignal())).outcome, "qualified");
  assert.equal((await reopened.observe({ ...h.funded, expectedIssueRevision: h.funded.expectedIssueRevision + 1 }, domainTestSignal())).outcome, "pending");
}));

test("a complete no_change has an original typed receipt and is distinct from completion without a proposal", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse({ kind: "no_change", reason: "The isolated report has no supported reusable intervention yet.", sourceRefs: [reportId] }));
  const h = await collaborationFixture(fx, provider), result = await h.execution.dispatch(h.funded, domainTestSignal());

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "completed");
  const observation = await h.execution.observe(h.funded, domainTestSignal());

  assert.equal(observation.outcome, "closed_no_result");
  assert.equal(observation.resultRefs.length, 1);
  const state = await fx.load(), receipt = readCollaborationNoChange(state, DOMAIN_TEST_SCOPE, observation.resultRefs[0]!);

  assert.ok(receipt);
  assert.equal(receipt.grantId, h.funded.grantId);
  assert.equal(receipt.issueId, h.funded.issueId);
  assert.equal(state.assets.length, 0);
  assert.equal(provider.requests.length, 1);
}));

test("dependency waiting and a later local return never back-label the earlier stage from a grant's final result", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse({ ...proposal(), experiences: [],
    needs: [{ owner: "expert", memberId: "personal_agent", instruction: "Prepare the explicitly requested source reviewer after owner consent." }] }));
  const h = await collaborationFixture(fx, provider, 1), waiting = await h.execution.dispatch(h.funded, domainTestSignal());

  assert.ok(waiting.ok, JSON.stringify(waiting));
  assert.equal(waiting.status, "waiting_dependency");
  assert.equal((await h.execution.observe(h.funded, domainTestSignal())).outcome, "pending");
  const before = await fx.load(), dependency = before.learningDependencies![0]!;
  const returned = await h.control.updateDependency({ dependencyId: dependency.dependencyId, expectedRevision: dependency.revision,
    state: { kind: "ready", resultRef: "expert-configuration:external-contract-receipt", resultVersion: "version:1", evidenceRefs: ["execution:external-owner-confirmation"] } });

  assert.ok(returned.ok);
  const prepared = await h.execution.prepare({ issueId: h.funded.issueId, authorizedAllowance: h.cap }, domainTestSignal());

  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;

  assert.deepEqual(prepared.offer.reserve, { tokens: 0, calls: 0, steps: 0 });
  const continued: CentralFundedStage = { issueId: h.funded.issueId, grantId: h.funded.grantId,
    expectedIssueRevision: (await fx.load()).learningIssues![0]!.revision, stageRef: prepared.stageRef,
    policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  const completed = await h.execution.dispatch(continued, domainTestSignal());
  assert.ok(completed.ok, JSON.stringify(completed));
  assert.equal(completed.status, "completed");
  assert.equal(provider.requests.length, 1);
  assert.equal((await fx.load()).centralLearningGrants!.length, 1);
  assert.equal((await h.execution.observe(h.funded, domainTestSignal())).outcome, "pending");
  assert.equal((await h.execution.observe(continued, domainTestSignal())).outcome, "pending", "an external configuration return is not a new collaboration proposal");
  const reopened = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control: h.control });

  assert.equal((await reopened.observe(h.funded, domainTestSignal())).outcome, "pending", "the original wait receipt never acquires a later stage's final result");
}));

test("a reopened adapter preserves an old wait when the same grant later delivers a real proposal", async () => withDomainBoard(async fx => {
  let response: unknown = { ...proposal(), experiences: [],
    needs: [{ owner: "expert", memberId: "personal_agent", instruction: "Prepare the requested reviewer after owner consent." }] };
  const provider = domainProvider(() => successfulDomainResponse(response)), h = await collaborationFixture(fx, provider);
  const waiting = await h.execution.dispatch(h.funded, domainTestSignal());
  assert.ok(waiting.ok);
  assert.equal(waiting.status, "waiting_dependency");
  const dependency = (await fx.load()).learningDependencies![0]!;

  assert.ok((await h.control.updateDependency({ dependencyId: dependency.dependencyId, expectedRevision: dependency.revision,
    state: { kind: "ready", resultRef: "expert-configuration:reviewer-contract", resultVersion: "version:1", evidenceRefs: ["execution:reviewer-confirmation"] } })).ok);
  response = proposal();
  const prepared = await h.execution.prepare({ issueId: h.funded.issueId, authorizedAllowance: h.cap }, domainTestSignal());

  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") throw new Error("continuation_not_ready");

  const continued: CentralFundedStage = { issueId: h.funded.issueId, grantId: h.funded.grantId,
    expectedIssueRevision: (await fx.load()).learningIssues![0]!.revision, stageRef: prepared.stageRef,
    policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  const delivered = await h.execution.dispatch(continued, domainTestSignal());
  assert.ok(delivered.ok);
  assert.equal(delivered.status, "completed");
  assert.equal((await h.execution.observe(continued, domainTestSignal())).outcome, "qualified");
  assert.equal(provider.requests.length, 2);
  const reopened = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control: h.control });

  assert.equal((await reopened.observe(continued, domainTestSignal())).outcome, "qualified");
  assert.equal((await reopened.observe(h.funded, domainTestSignal())).outcome, "pending", "the earlier persisted wait has no result refs to back-label");
}));

test("the original collaboration dispatcher rejects another grant and stale issue revision before invoking its real worker", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(proposal())), h = await collaborationFixture(fx, provider);
  const before = await fx.load();
  const unrelated = await h.control.dispatch({ scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId, grantId: "grant:not-the-selected-one",
    expectedIssueRevision: h.funded.expectedIssueRevision, signal: domainTestSignal() });

  assert.ok(unrelated.ok);
  assert.equal(unrelated.status, "idle");
  assert.equal(provider.requests.length, 0);
  const stale = await h.control.dispatch({ scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId, grantId: h.funded.grantId,
    expectedIssueRevision: h.funded.expectedIssueRevision - 1, signal: domainTestSignal() });

  assert.equal(stale.ok, false);
  assert.equal(provider.requests.length, 0);
  assert.equal((await fx.load()).sequence, before.sequence);
}));

test("actual mounted team/source admission rejects an old opportunity before preparing a bid or invoking its original worker", async () => withDomainBoard(async fx => {
  const provider = domainProvider(() => successfulDomainResponse(proposal())), h = await collaborationFixture(fx, provider);
  const before = await fx.load();
  const moved = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true,
    control: h.control, admitSource: issue => collaborationSourceAdmission(issue, { currentTeamRunId: "team:a-later-run" }) });
  const prepared = await moved.prepare({ issueId: h.funded.issueId, authorizedAllowance: h.cap }, domainTestSignal());

  assert.equal(prepared.status, "unavailable");
  assert.equal(prepared.reason, "learning_source_team_changed");
  const rejected = await moved.dispatch(h.funded, domainTestSignal());
  assert.equal(rejected.ok, false);
  assert.equal(provider.requests.length, 0);
  assert.equal((await fx.load()).sequence, before.sequence);
  const issue = before.learningIssues![0]!;

  assert.deepEqual(collaborationSourceAdmission(issue, { sourceIssueId: "issue:another" }), { status: "rejected", reason: "learning_source_issue_changed" });
  const paOnly = { ...issue, reports: issue.reports.map(report => ({ ...report,
    source: { teamRunId: "team:earlier", taskId: "task:central-contract", memberId: "personal_agent" } })) };

  assert.deepEqual(collaborationSourceAdmission(paOnly, { currentTeamRunId: "team:a-later-run" }), { status: "ready" });
}));

test("normal collaboration exposure and PA uncertain feedback change the next original worker's source packet without becoming economic gain", async () => withDomainBoard(async fx => {
  let output: unknown = proposal();
  const provider = domainProvider(() => successfulDomainResponse(output));
  const reader: CentralLearningContextReader = async issueId => {
    const feedback = projectCollaborationCentralFeedback(await fx.load(), { scope: DOMAIN_TEST_SCOPE, issueId });
    return feedback === undefined ? undefined : { ref: feedback.sourceRef, text: canonicalJson(feedback.records) };
  };
  const h = await collaborationFixture(fx, provider, 2, reader);
  const first = await h.execution.dispatch(h.funded, domainTestSignal());
  assert.ok(first.ok);
  assert.equal(first.status, "completed");
  const before = projectCollaborationCentralFeedback(await fx.load(), { scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId });
  assert.ok(before);
  const selected = await h.experience.prepareExperience({ owner, maxChars: 600 });
  assert.ok(selected.ok);
  assert.equal(selected.versionIds.length, 1);
  const boundary = { executionId: "execution:normal-consumer", taskId: "task:later-normal-consumer", round: 1, role: "personal_agent" };

  assert.ok((await h.experience.recordLoad({ receiptId: "loaded:normal-consumer", owner, versionIds: selected.versionIds,
    boundary, recordedAt: DOMAIN_TEST_NOW })).ok);
  const consumer = domainProvider(() => successfulDomainResponse("controlled normal response"));
  const request = { attemptId: "request:normal-consumer", model: "scripted-normal-consumer", tools: [],
    messages: [{ role: "system" as const, content: selected.text }, { role: "user" as const, content: "Use the supplied owner-specific handoff guidance." }] };
  let finished = false;

  for await (const event of consumer.provider.stream(request, domainTestSignal())) if (event.type === "finish") finished = true;

  assert.equal(finished, true);
  assert.equal(consumer.requests[0]!.messages[0]!.content, selected.text);
  assert.ok((await h.experience.recordDispatch({ receiptId: "dispatched:normal-consumer", owner, versionIds: selected.versionIds,
    boundary: { ...boundary, requestId: request.attemptId, configurationRef: `configuration:${contentHashOf(request)}` }, recordedAt: DOMAIN_TEST_NOW })).ok);
  assert.ok((await h.experience.recordUseFeedback({ receiptId: "feedback:normal-consumer", owner, versionIds: selected.versionIds,
    usageReceiptId: "dispatched:normal-consumer", sourceRefs: [request.attemptId], outcome: "uncertain",
    summary: "The request contained the guidance; independent evidence of changed handoff behavior is still missing.", recordedAt: DOMAIN_TEST_NOW })).ok);
  const after = projectCollaborationCentralFeedback(await fx.load(), { scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId });
  assert.ok(after);
  assert.notEqual(after.sourceRef, before.sourceRef);
  assert.equal(after.records.filter(item => item.kind === "collaboration_loaded").length, 1);
  assert.equal(after.records.filter(item => item.kind === "collaboration_dispatched").length, 1);
  const observed = after.records.find(item => item.kind === "collaboration_use_feedback");
  assert.ok(observed);
  assert.equal(observed.outcome, "uncertain");
  const appended = await h.control.report({ scope: DOMAIN_TEST_SCOPE, issueId: h.funded.issueId, problemKey: "artifact-handoff",
    report: { reportId: "report:normal-consumer-feedback", source: { teamRunId: "team:central-contract", taskId: boundary.taskId, memberId: "personal_agent" },
      facts: ["The normal request included the owner guidance; behavioral effect remains uncertain."], evidenceRefs: ["feedback:normal-consumer", request.attemptId] } });
  assert.ok(appended.ok);
  const focused = await h.control.decide({ issueId: h.funded.issueId, expectedRevision: appended.issue.revision,
    decision: "focused_learning", reason: "Explicitly reconsider the new attributed feedback, retaining uncertainty.", sourceRefs: ["feedback:normal-consumer"] });
  assert.ok(focused.ok);
  const prepared = await h.execution.prepare({ issueId: h.funded.issueId, authorizedAllowance: h.cap }, domainTestSignal());
  const next = await fx.fund(prepared);
  output = { kind: "no_change", reason: "Request exposure alone does not justify another reusable practice.", sourceRefs: ["report:normal-consumer-feedback"] };
  const second = await h.execution.dispatch(next, domainTestSignal());
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(second.status, "completed");
  assert.equal(provider.requests.length, 2);
  const material = JSON.parse(provider.requests[1]!.messages.find(message => message.role === "user")!.content);
  const packet = JSON.parse(material.material.centralContent.text);

  assert.ok(packet.some((item: { kind: string; outcome?: string }) => item.kind === "collaboration_use_feedback" && item.outcome === "uncertain"));
  assert.equal((await h.execution.observe(next, domainTestSignal())).outcome, "closed_no_result");
}));
