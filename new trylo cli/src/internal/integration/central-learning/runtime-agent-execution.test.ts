import assert from "node:assert/strict";
import test from "node:test";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createCollaborationWorker } from "../../learning/agent/subsystems/collaboration/orchestration/worker.js";
import { createCollaborationDecisionModel } from "../../learning/agent/subsystems/collaboration/runtime/decision-model.js";
import { createCollaborationExperienceStore } from "../../learning/agent/subsystems/collaboration/experience/store.js";
import type { CentralLearningIntentDraft, CentralLearningConfiguration, CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { startWork } from "../../learning/central/runtime/transitions.js";
import { readCentralPursuitObservations } from "../learning-allocation/pursuit-observations.js";
import { createCentralCollaborationExecution } from "./collaboration.js";
import { createCentralRuntimeAgentExecution } from "./runtime-agent-execution.js";
import { readRuntimeAgentOriginalWork, readRuntimeAgentWork } from "./runtime-agent-execution-frame.js";
import { readFrozenStage } from "./stage-evidence.js";
import { recordCentralStageObservation } from "./observations.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { createCentralRuntimeContextReader } from "./runtime-context.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainProvider, domainTestSignal,
  successfulDomainResponse, withDomainBoard } from "./testing/domain-funding.test.js";

const rootAllowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 100000, maxCalls: 16, maxSteps: 16, maxPromptChars: 40000 };
const increment = { ...rootAllowance, maxTokens: 20000, maxCalls: 1, maxSteps: 1 };
const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "runtime-config:explicit",
  authorizationRef: "runtime-authorization:explicit", allowance: rootAllowance };
const operation = { kind: "dispatch" as const, operationId: "runtime-operation:compare-handoff", allowance: increment,
  purpose: "Investigate the selected handoff gap", expectedChange: "Determine which original handoff premise is missing",
  sourceRefs: ["runtime-report:new"] };

function intent(issueId: string): CentralLearningIntentDraft {
  return { intentId: "runtime-intent:preserve-handoff", subject: { plane: "agent", domain: "collaboration", issueId },
    goal: "Prevent receiver rework", rationale: "The selected new report concerns the current missing premise",
    conditions: ["The receiver depends on this artifact"], knowledge: [], residual: ["Which handoff premise is missing?"],
    commitment: { purpose: "Compare the handoff evidence", assumptions: [], reconsiderWhen: ["The original evidence changes"] },
    revisionReason: "Start a bounded investigation", sourceRefs: ["runtime-report:new"], continuation: { kind: "ready", operation } };
}

type Fixture = Parameters<Parameters<typeof withDomainBoard>[0]>[0];

async function fixture(fx: Fixture, mode: "no_change" | "dependency" = "no_change") {
  const board = createFileCollaborationBoard(fx.boardRoot);
  const provider = domainProvider(() => successfulDomainResponse(mode === "no_change" ? { kind: "no_change",
    reason: "The evidence does not support a reusable intervention yet.", sourceRefs: ["runtime-report:new"] }
    : { kind: "propose", familyId: "runtime-artifact-handoff", title: "Preserve the receiver's artifact identity",
      summary: "Compare the explicit artifact identity before the receiver repeats its work.", sourceRefs: ["runtime-report:new"],
      adjustments: [{ memberId: "personal_agent", kind: "handoff", instruction: "Keep the artifact identity in the handoff." }],
      experiences: [], needs: [{ owner: "expert", memberId: "personal_agent", instruction: "Prepare the requested source reviewer after the owner's consent." }] }));
  const experience = createCollaborationExperienceStore({ board, scope: DOMAIN_TEST_SCOPE, now: () => DOMAIN_TEST_NOW });
  const worker = createCollaborationWorker({ board, scope: DOMAIN_TEST_SCOPE, now: () => DOMAIN_TEST_NOW,
    model: createCollaborationDecisionModel({ provider: provider.provider, model: "scripted-runtime-transport" }),
    resources: { async query() { return { ok: false, reason: "not_requested" }; } }, context: async () => ({ surface: "code",
      owners: [{ ref: "personal_agent", owner: { kind: "personal_agent", experienceKey: "trylo.personal_agent.v1" } }] }),
    async prepareDependencies(input) { return { ok: true, resultRefs: input.dependencies.flatMap(row => row.state.kind === "ready" ? [row.state.resultRef] : []) }; },
    async experienceInput() { return { ok: false, reason: "no_experience_requested" }; },
    preflightExperience: experience.preflightExperience, publishExperience: experience.publishExperience });
  const control = createCollaborationControl({ board, worker, now: () => DOMAIN_TEST_NOW, ownerId: "runtime-contract" });
  const report = async (name: string) => {
    const reported = await control.report({ scope: DOMAIN_TEST_SCOPE, problemKey: `runtime-${name}`, issueId: `runtime-issue:${name}`,
      report: { reportId: `runtime-report:${name}`, source: { teamRunId: "runtime-team", taskId: `runtime-task:${name}`, memberId: "receiver" },
        facts: ["The receiver repeated work after an incomplete handoff"], evidenceRefs: [`runtime-execution:${name}`] } });
    assert.ok(reported.ok);
    return reported.issue;
  };
  const oldIssue = await report("old"), newIssue = await report("new");
  const port = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control });
  const options = { boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, ports: [port], control,
    enabled: () => true, now: () => DOMAIN_TEST_NOW, rootAllowance, authorizationRef: configuration.authorizationRef };
  const adapter = createCentralRuntimeAgentExecution(options);
  const prepare = (selected = intent(newIssue.issueId), selectedOperation: Extract<CentralLearningOperation, { kind: "dispatch" }> = operation,
    config = configuration) => adapter.prepare({
    scope: DOMAIN_TEST_SCOPE, intent: selected, operation: selectedOperation, configuration: config, signal: domainTestSignal() });

  return { board, provider, control, port, oldIssue, newIssue, options, adapter, prepare };
}

/** Prime a genuine domain checkpoint, not just a reported usage prefix. Only
 * model transport is scripted; plan publication, wait and return are native. */
async function dependencyBoundary(fx: Fixture, h: Awaited<ReturnType<typeof fixture>>, firstOperation = operation) {
  const first = await h.prepare(intent(h.newIssue.issueId), firstOperation), decoded = readRuntimeAgentWork(first, DOMAIN_TEST_SCOPE);
  const result = await h.adapter.execute(first, domainTestSignal());
  assert.equal(result.outcome, "returned", result.publicResult);
  let state = await fx.load();
  const dependency = state.learningDependencies![0]!;

  assert.equal(state.jobs[0]!.state, "waiting_evidence");
  assert.equal(h.provider.requests.length, 1);
  assert.equal(result.wait?.kind, "facts");
  assert.ok(result.wait?.sourceRefs.includes(dependency.dependencyId));
  const updated = await h.control.updateDependency({ dependencyId: dependency.dependencyId, expectedRevision: dependency.revision,
    state: { kind: "ready", resultRef: "runtime-contract:free-return", resultVersion: "1", evidenceRefs: ["runtime-contract:external-ready"] } });

  assert.ok(updated.ok);
  state = await fx.load();

  return { first, decoded, state, grant: state.centralLearningGrants![0]!, root: state.centralLearningBudgets![0]! };
}

test("model-selected newer issue reaches the real worker; advice does not fund and cold recovery never repays", async () => withDomainBoard(async fx => {
  const h = await fixture(fx), selected = intent(h.newIssue.issueId);
  const advice = await h.adapter.consult({ scope: DOMAIN_TEST_SCOPE, subject: selected.subject, allowance: increment, signal: domainTestSignal() });

  assert.equal(advice.kind, "numerical_advice");
  assert.match(advice.text, /not_intent_value/);
  assert.equal((await fx.load()).centralLearningGrants?.length ?? 0, 0);
  assert.equal(h.provider.requests.length, 0);
  const work = await h.prepare();
  const prepared = await fx.load();

  assert.equal(prepared.centralLearningGrants!.length, 1);
  assert.equal(prepared.centralLearningGrants![0]!.issueId, h.newIssue.issueId);
  assert.equal(prepared.learningIssues!.find(row => row.issueId === h.oldIssue.issueId)!.decision.kind, "unreviewed");
  assert.equal(h.provider.requests.length, 0, "prepare does not dispatch a worker");
  assert.deepEqual(await h.prepare(), work, "an unconfirmed controller checkpoint rebuilds the same funded frame");
  assert.deepEqual(await fx.load(), prepared, "rebuilding does not fund again");
  assert.deepEqual(await createCentralRuntimeAgentExecution(h.options).recover(work, domainTestSignal()), { kind: "ready_to_execute" });
  await assert.rejects(h.prepare(selected, { ...operation, purpose: "A changed program under the same operation ID" }), /operation_plan_conflict/);
  const result = await h.adapter.execute(JSON.parse(JSON.stringify(work)), domainTestSignal());

  assert.equal(result.outcome, "returned", result.publicResult);
  assert.match(result.publicResult, /closed_no_result/);
  assert.match(result.publicResult, /goalCompletion.*unknown/);
  assert.equal(h.provider.requests.length, 1);
  const after = await fx.load(), grant = after.centralLearningGrants![0]!;

  assert.deepEqual(centralLearningSpent(grant), { tokens: 1500, calls: 1, steps: 1 });
  const observations = readCentralPursuitObservations(after, DOMAIN_TEST_SCOPE);
  assert.equal(observations.status, "ready");

  if (observations.status === "ready") assert.equal(observations.observations[0]!.outcome, "closed_no_result");

  const cold = createCentralRuntimeAgentExecution(h.options), sequence = after.sequence;
  const recovered = await cold.recover(work, domainTestSignal());
  assert.ok(recovered !== null && "outcome" in recovered);
  assert.equal(recovered.outcome, "returned");
  assert.equal((await cold.execute(work, domainTestSignal())).outcome, "returned");
  assert.equal(h.provider.requests.length, 1);
  assert.equal((await fx.load()).sequence, sequence, "recovery is read-only");
  await assert.rejects(cold.execute({ ...work, operation: { ...work.operation, allowance: { ...increment, maxCalls: 2 } } }, domainTestSignal()), /frame_invalid/);
}));

test("a crash after the original pending fence leaves unknown; neither recovery nor execute blindly dispatches", async () => withDomainBoard(async fx => {
  const h = await fixture(fx), work = await h.prepare(), decoded = readRuntimeAgentWork(work, DOMAIN_TEST_SCOPE);
  const frozen = await readFrozenStage({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE,
    grantId: decoded.input.grantId, stageRef: decoded.input.stageRef });

  assert.equal(frozen.status, "ready");
  if (frozen.status !== "ready") return;

  await recordCentralStageObservation({ boardRoot: fx.boardRoot, enabled: () => true, input: decoded.input, candidate: frozen.value.candidate,
    mode: "initial", observed: { outcome: "pending", resultRefs: [], sourceRefs: [decoded.input.stageRef], reason: "test_crash_before_dispatch" } });
  const before = await fx.load(), cold = createCentralRuntimeAgentExecution(h.options);
  const recovered = await cold.recover(work, domainTestSignal());
  assert.ok(recovered !== null && "outcome" in recovered);
  assert.equal(recovered.outcome, "unknown");
  assert.equal((await cold.execute(work, domainTestSignal())).outcome, "unknown");
  assert.equal(h.provider.requests.length, 0);
  assert.deepEqual(await fx.load(), before);
}));

test("ordinary execution and resolved PA decisions survive autonomous preparation, and an oversized increment cannot fund", async () => withDomainBoard(async fx => {
  const h = await fixture(fx);
  const decided = await h.control.decide({ issueId: h.newIssue.issueId, expectedRevision: h.newIssue.revision,
    decision: "ordinary_execution", reason: "The PA has selected an ordinary repair", sourceRefs: ["runtime-report:new"] });

  assert.ok(decided.ok);
  await assert.rejects(h.prepare(), /pa_decision_preserved/);
  const resolved = await h.control.decide({ issueId: h.oldIssue.issueId, expectedRevision: h.oldIssue.revision,
    decision: "resolved", reason: "The original PA has answered this issue", sourceRefs: ["runtime-report:old"] });

  assert.ok(resolved.ok);
  await assert.rejects(h.prepare(intent(h.oldIssue.issueId)), /pa_decision_preserved/);
  const before = await fx.load();

  await assert.rejects(h.prepare(intent(h.oldIssue.issueId), { ...operation, allowance: { ...increment, maxTokens: rootAllowance.maxTokens + 1 } }), /exceeds_authorization/);
  const after = await fx.load();
  assert.equal(after.centralLearningGrants?.length ?? 0, 0);
  assert.equal(after.learningIssues!.find(row => row.issueId === h.newIssue.issueId)!.decision.kind, "ordinary_execution");
  assert.equal(h.provider.requests.length, 0);
  assert.deepEqual(after, before);
}));

test("continuation adds the actual charged prefix exactly once and retains the independent lifetime ceiling", async () => withDomainBoard(async fx => {
  const h = await fixture(fx, "dependency"), { decoded } = await dependencyBoundary(fx, h);
  const nextOperation = { ...operation, operationId: "runtime-operation:continuation", allowance: { ...increment, maxTokens: 5000 } };
  const second = await h.prepare(intent(h.newIssue.issueId), nextOperation);
  const state = await fx.load(), extended = state.centralLearningGrants![0]!;

  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(extended.grantId, decoded.input.grantId);
  assert.equal(extended.allowance.maxTokens, 6500);
  assert.equal(extended.allowance.maxCalls, 2);
  assert.equal(readRuntimeAgentWork(second, DOMAIN_TEST_SCOPE).input.offer.reserve.tokens, 5000);
  assert.deepEqual(centralLearningSpent(extended), { tokens: 1500, calls: 1, steps: 1 });
  const smallConfiguration = { ...configuration, allowance: { ...rootAllowance, maxTokens: 6000 } };

  await assert.rejects(h.prepare(intent(h.newIssue.issueId), nextOperation, smallConfiguration), /fixed_budget_mismatch/);
  assert.deepEqual(await fx.load(), state);
  assert.equal(h.provider.requests.length, 1);
}));

test("exact saved root identity admits an explicitly raised cumulative limit on the same grant, while old flags and forged identity do not", async () => withDomainBoard(async fx => {
  const h = await fixture(fx, "dependency"), { grant, root } = await dependencyBoundary(fx, h);
  let state = await fx.load();

  await fx.act({ kind: "rebudget", grantId: grant.grantId, expectedSequence: state.sequence,
    limits: { tokens: 20000, calls: 2, steps: 2 }, authorizationRef: configuration.authorizationRef, planRef: "runtime-contract:retain-known-commitment" });
  state = await fx.load();
  await fx.act({ kind: "set_budget_limit", budgetId: root.budgetId, expectedSequence: state.sequence, changeId: "runtime-management:raise",
    limits: { tokens: 110000, calls: 18, steps: 18 }, authorizationRef: "runtime-management:explicit-absolute-limit" });
  const nextOperation = { ...operation, operationId: "runtime-operation:managed-continuation", allowance: rootAllowance };
  const managed = { ...configuration, rootRef: { budgetId: root.budgetId, scope: root.scope,
    openedSequence: root.openedSequence, authorizationRef: root.authorizationRef } };

  state = await fx.load();
  await assert.rejects(h.prepare(intent(h.newIssue.issueId), nextOperation), /fixed_budget_mismatch/);
  await assert.rejects(h.prepare(intent(h.newIssue.issueId), nextOperation, { ...managed,
    rootRef: { ...managed.rootRef, openedSequence: root.openedSequence + 1 } }), /learning_budget_binding/);
  assert.deepEqual(await fx.load(), state);
  const work = await h.prepare(intent(h.newIssue.issueId), nextOperation, managed);
  const after = await fx.load(), continued = after.centralLearningGrants![0]!;

  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(continued.grantId, grant.grantId);
  assert.equal(continued.allowance.maxTokens, 101500);
  assert.equal(continued.allowance.maxCalls, 17);
  assert.deepEqual(centralLearningSpent(continued), { tokens: 1500, calls: 1, steps: 1 });
  assert.equal(readRuntimeAgentWork(work, DOMAIN_TEST_SCOPE).input.offer.reserve.tokens, 100000);
  assert.deepEqual(after.centralLearningBudgets![0]!.limits, { tokens: 110000, calls: 18, steps: 18 });
  assert.equal(h.provider.requests.length, 1);
}));

test("one bounded 64-call operation extends the original native grant to a cumulative 65 without resetting its charged prefix", async () => withDomainBoard(async fx => {
  const h = await fixture(fx, "dependency"), { grant, root } = await dependencyBoundary(fx, h);
  const before = await fx.load();

  await fx.act({ kind: "set_budget_limit", budgetId: root.budgetId, expectedSequence: before.sequence,
    changeId: "runtime-management:cumulative-65", limits: { tokens: 110000, calls: 66, steps: 66 },
    authorizationRef: "runtime-management:explicit-cumulative-limit" });
  const managed = { ...configuration, rootRef: { budgetId: root.budgetId, scope: root.scope,
    openedSequence: root.openedSequence, authorizationRef: root.authorizationRef } };
  const nextOperation = { ...operation, operationId: "runtime-operation:cumulative-65",
    allowance: { ...rootAllowance, maxCalls: 64, maxSteps: 64 } };
  const work = await h.prepare(intent(h.newIssue.issueId), nextOperation, managed);
  const after = await fx.load(), continued = after.centralLearningGrants![0]!;

  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(continued.grantId, grant.grantId);
  assert.equal(continued.jobId, grant.jobId);
  assert.equal(continued.allowance.maxCalls, 65);
  assert.equal(continued.allowance.maxSteps, 65);
  assert.equal(continued.allowance.maxTokens, 101500);
  assert.deepEqual(centralLearningSpent(continued), { tokens: 1500, calls: 1, steps: 1 });
  assert.deepEqual(readRuntimeAgentWork(work, DOMAIN_TEST_SCOPE).input.offer.reserve, { tokens: 100000, calls: 64, steps: 64 });
  const state = await fx.load();

  await assert.rejects(h.prepare(intent(h.newIssue.issueId), { ...nextOperation,
    operationId: "runtime-operation:oversized-65", allowance: { ...nextOperation.allowance, maxCalls: 65 } }, managed), /exceeds_authorization/);
  assert.deepEqual(await fx.load(), state);
  assert.equal(h.provider.requests.length, 1, "the real native checkpoint is the only scripted model request; no 64-call workload runs");
}));

test("a central purpose binds only the domain receiver's real native issue while its central subject remains unchanged", async () => withDomainBoard(async fx => {
  const h = await fixture(fx);

  await assert.rejects(h.prepare(intent(h.newIssue.issueId), { ...operation,
    destination: { plane: "agent", domain: "tool" } }), /destination_mismatch/);
  await assert.rejects(h.prepare(intent(h.newIssue.issueId), { ...operation,
    destination: { plane: "user" } }), /destination_mismatch/);
  assert.equal((await fx.load()).centralLearningGrants?.length ?? 0, 0);
  const selected: CentralLearningIntentDraft = { ...intent(h.newIssue.issueId), subject: { plane: "central", questionRef: "runtime-intent:preserve-handoff" } };
  const directed = { ...operation, destination: { plane: "agent" as const, domain: "collaboration" as const } };
  const received: string[] = [];
  const port = { ...h.port, async acceptResearch(input: { readonly intentRef: string; readonly intent: CentralLearningIntentDraft }) {
    assert.equal(input.intent.subject.plane, "central");
    received.push(input.intentRef);
    // The receiver boundary binds an existing canonical source. This contract
    // does not claim to implement the separate domain receiver's intake logic.
    return { status: "accepted" as const, issueId: h.newIssue.issueId, sourceRefs: ["runtime-report:new"] };
  } };
  const adapter = createCentralRuntimeAgentExecution({ ...h.options, ports: [port] });
  const work = await adapter.prepare({ scope: DOMAIN_TEST_SCOPE, intent: selected, operation: directed, configuration, signal: domainTestSignal() });

  assert.equal(selected.subject.plane, "central");
  assert.deepEqual(received, [selected.intentId]);
  assert.equal(readRuntimeAgentWork(work, DOMAIN_TEST_SCOPE).input.issueId, h.newIssue.issueId);
  assert.equal((await fx.load()).centralLearningGrants![0]!.issueId, h.newIssue.issueId);
  assert.equal(work.intentId, selected.intentId);
  assert.equal(h.provider.requests.length, 0);
}));

test("a source-confirmed free dependency return completes on its original held root without another provider grant or call", async () => withDomainBoard(async fx => {
  const h = await fixture(fx, "dependency"), { root } = await dependencyBoundary(fx, h);
  const state = await fx.load();
  const accountingOwner = { kind: "central_deliberation" as const, ownerId: "runtime-contract:separate-honest-overrun" };

  await fx.act({ kind: "reserve_budget_usage", budgetId: root.budgetId, scope: root.scope, expectedSequence: state.sequence,
    owner: accountingOwner, reservationId: "runtime-accounting:overrun", maxTokens: 1 });
  await fx.act({ kind: "settle_budget_usage", budgetId: root.budgetId, scope: root.scope, owner: accountingOwner,
    reservationId: "runtime-accounting:overrun", usage: { kind: "reported", totalTokens: 2 } });
  assert.equal(centralBudgetProjection(await fx.load(), root.budgetId)!.status, "held");
  const managed = { ...configuration, rootRef: { budgetId: root.budgetId, scope: root.scope,
    openedSequence: root.openedSequence, authorizationRef: root.authorizationRef } };
  const cleanup = await h.prepare(intent(h.newIssue.issueId), { ...operation, operationId: "runtime-operation:free-return" }, managed);

  assert.deepEqual(readRuntimeAgentWork(cleanup, DOMAIN_TEST_SCOPE).input.offer.reserve, { tokens: 0, calls: 0, steps: 0 });
  const result = await h.adapter.execute(cleanup, domainTestSignal());

  assert.equal(result.outcome, "returned", result.publicResult);
  assert.match(result.publicResult, /runtime-contract:free-return/);
  assert.match(result.publicResult, /goalCompletion.*unknown/);
  const after = await fx.load();
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), { tokens: 1500, calls: 1, steps: 1 });
  assert.equal(centralBudgetProjection(after, root.budgetId)!.status, "held", "free cleanup does not erase another owner's cap violation");
  assert.equal(h.provider.requests.length, 1);
  const beforeRecovery = after.sequence, cold = createCentralRuntimeAgentExecution(h.options);
  const recovered = await cold.recover(cleanup, domainTestSignal());
  assert.ok(recovered !== null && "outcome" in recovered);
  assert.equal(recovered.outcome, "returned");
  assert.match(recovered.publicResult, /runtime-contract:free-return/);
  assert.equal((await fx.load()).sequence, beforeRecovery);
}));

test("prepared collaboration context survives ordinary knowledge and fallback changes through real dispatch and cold recovery", async () => withDomainBoard(async fx => {
  const h = await fixture(fx), cap = { ...rootAllowance, maxPromptChars: 80000 };
  const selectedOperation = { ...operation, operationId: "runtime-operation:frozen-context",
    allowance: { ...increment, maxTokens: 50000, maxPromptChars: cap.maxPromptChars } };
  const selected: CentralLearningIntentDraft = { ...intent(h.newIssue.issueId),
    knowledge: [{ statement: "ORIGINAL_KNOWLEDGE: the receiver needs the exact artifact version", conditions: "This original handoff only",
      sourceRefs: ["runtime-report:new"] }], continuation: { kind: "ready", operation: selectedOperation } };
  const store = createCentralRuntimeStore({ boardRoot: fx.boardRoot, enabled: () => true });
  let snapshot = await store.read(DOMAIN_TEST_SCOPE);

  assert.equal((await store.append({ previousRef: snapshot.stateRef, expectedRevision: snapshot.revision,
    state: { ...emptyCentralRuntimeState(DOMAIN_TEST_SCOPE), intents: [selected] }, reason: "Preserve the original purpose and ordinary knowledge",
    sourceRefs: selected.sourceRefs })).status, "written");
  let fallback = { ref: "runtime-fallback:prepared", text: `ORIGINAL_FALLBACK:${"source material ".repeat(2200)}` };
  const reader = () => createCentralRuntimeContextReader({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE,
    enabled: () => true, fallback: async () => fallback });
  const originalOptions = { ...h.options, rootAllowance: cap,
    ports: [createCentralCollaborationExecution({ ...h.options, control: h.control, contextForIssue: reader() })] };
  const adapter = createCentralRuntimeAgentExecution(originalOptions);
  const work = await adapter.prepare({ scope: DOMAIN_TEST_SCOPE, intent: selected, operation: selectedOperation,
    configuration: { ...configuration, allowance: cap }, signal: domainTestSignal() });
  const frozen = (await readRuntimeAgentOriginalWork(JSON.parse(JSON.stringify(work)), DOMAIN_TEST_SCOPE, fx.boardRoot)).input.sourceContext;

  assert.ok(frozen);
  assert.ok(frozen.text.length > 32768);
  assert.ok(JSON.stringify(work).length <= 131072);
  assert.match(frozen.text, /ORIGINAL_KNOWLEDGE/);
  assert.match(frozen.text, /ORIGINAL_FALLBACK/);
  snapshot = await store.read(DOMAIN_TEST_SCOPE);
  assert.equal((await store.append({ previousRef: snapshot.stateRef, expectedRevision: snapshot.revision,
    state: startWork(snapshot.state, work), reason: "Record the real prepared frame as running", sourceRefs: [work.workRef] })).status, "written");
  snapshot = await store.read(DOMAIN_TEST_SCOPE);
  assert.equal((await store.append({ previousRef: snapshot.stateRef, expectedRevision: snapshot.revision,
    state: { ...snapshot.state, intents: snapshot.state.intents.map(row => ({ ...row,
      knowledge: [{ statement: "REVISED_KNOWLEDGE: a later ordinary observation concerns a different receiver",
        conditions: "The later handoff only", sourceRefs: ["runtime-report:later"] }], revisionReason: "Ordinary knowledge update while original work remains running" })) },
    reason: "Retain the original running work while updating public knowledge", sourceRefs: ["runtime-report:later"] })).status, "written");
  fallback = { ref: "runtime-fallback:later", text: "REVISED_FALLBACK: later surrounding material" };
  const live = await reader()(h.newIssue.issueId);
  assert.ok(live);
  assert.match(live.text, /REVISED_KNOWLEDGE/);
  assert.match(live.text, /REVISED_FALLBACK/);
  assert.notEqual(live.ref, frozen.ref);
  const coldWork = (await createCentralRuntimeStore({ boardRoot: fx.boardRoot, enabled: () => true }).read(DOMAIN_TEST_SCOPE)).state.running[0]!;
  const cold = createCentralRuntimeAgentExecution({ ...originalOptions,
    ports: [createCentralCollaborationExecution({ ...h.options, control: h.control, contextForIssue: reader() })] });
  const result = await cold.execute(coldWork, domainTestSignal());

  assert.equal(result.outcome, "returned", result.publicResult);
  assert.equal(h.provider.requests.length, 1);
  const body = JSON.parse(h.provider.requests[0]!.messages.find(row => row.role === "user")!.content);

  assert.deepEqual(body.material.centralContent, frozen, "the real original worker receives the complete prepared context, including fallback");
  const state = await fx.load(), archive = await readFrozenStage({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE,
    grantId: state.centralLearningGrants![0]!.grantId, stageRef: readRuntimeAgentWork(coldWork, DOMAIN_TEST_SCOPE).input.stageRef });

  assert.equal(archive.status, "ready");
  if (archive.status === "ready") assert.deepEqual(archive.value.input.sourceContext, frozen);

  const recovered = await cold.recover(coldWork, domainTestSignal());
  assert.ok(recovered !== null && "outcome" in recovered);
  assert.equal(recovered.outcome, "returned");
  assert.equal((await fx.load()).sequence, state.sequence);
  assert.equal(h.provider.requests.length, 1);
}));
