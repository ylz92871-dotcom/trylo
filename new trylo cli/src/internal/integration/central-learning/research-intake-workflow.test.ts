import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../learning/control/hash.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { createCentralRuntimeContextReader } from "./runtime-context.js";
import { groundCentralResearch } from "./research-intake-common.js";
import { acceptCentralWorkflowResearch } from "./research-intake-workflow.js";
import { createCentralWorkflowExecution } from "./workflow.js";
import { createWorkflowImprovementModel } from "../../learning/agent/subsystems/workflow/adapters/improvement-model.js";
import { createFileWorkflowImprovementRuntime } from "../../learning/agent/subsystems/workflow/adapters/improvement-composition.js";
import { workflowImprovementsFromBoard } from "../../learning/agent/subsystems/workflow/adapters/improvement-board.js";
import { searchImprovementFixture } from "../../learning/agent/subsystems/workflow/testing/improvement-fixtures.js";
import { record } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainProvider, domainTestSignal, successfulDomainResponse, withDomainBoard } from "./testing/domain-funding.test.js";

test("new central purpose without a native issue reaches workflow research, publication and an actual later compatible handoff", async () => withDomainBoard(async fx => {
  const scope = DOMAIN_TEST_SCOPE, workspaceId = "workspace:prospective-process", allowance = {
    schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 24000 };
  const material: CentralRuntimeMaterial = { ref: "original:successful-tasks", kind: "source",
    text: "Two resolved tasks retained complete source evidence by confirming the current owner before scoped searches.", sourceRefs: ["journal:original-successes"] };
  const operation = { kind: "dispatch" as const, operationId: "research:workflow", purpose: "Develop a conditional process", expectedChange: "A procedure with premise checks",
    sourceRefs: [material.ref], allowance, destination: { plane: "agent" as const, domain: "workflow" as const } };
  const intent: CentralLearningIntentDraft = { intentId: "intent:prospective-owner", subject: { plane: "central", questionRef: "intent:prospective-owner" },
    goal: "When should a new source search reuse a previously located owner?", rationale: "Successful old tasks may support a reusable process without reopening them",
    conditions: [], knowledge: [{ statement: "Confirming owner preceded complete searches", conditions: "Only the cited cases", sourceRefs: [material.ref] }],
    residual: ["Account for a moved owner"], commitment: { purpose: "Propose a falsifiable reuse procedure", assumptions: [], reconsiderWhen: ["Owner may have moved"] },
    revisionReason: "New grounded purpose", sourceRefs: [material.ref], continuation: { kind: "ready", operation },
    derivation: { relation: "Generalize successful practice", whenRelevant: "A future source search", parentRefs: [material.ref],
      citations: [{ evidenceRef: material.ref, quote: "confirming the current owner before scoped searches" }] } };
  const store = createCentralRuntimeStore({ boardRoot: fx.boardRoot, enabled: () => true });
  const original = await fx.load();

  assert.equal(original.learningIssues?.length ?? 0, 0);
  assert.equal((await store.append({ expectedRevision: original.sequence, previousRef: initialCentralRuntimeRef(scope),
    state: { ...emptyCentralRuntimeState(scope), intents: [intent], materials: [material], consumedSourceRefs: [material.ref] },
    reason: "A new purpose formed from actual read source", sourceRefs: [material.ref] })).status, "written");
  const sample = searchImprovementFixture().proposal;
  const proposal = { ...sample, diagnosis: { ...sample.diagnosis, supportingRefs: [material.ref] },
    procedure: { ...sample.procedure, requiredConditions: {} }, changes: sample.changes.map(change => ({ ...change, evidenceRefs: [material.ref] })) };
  let calls = 0;
  const transport = domainProvider(() => successfulDomainResponse(++calls === 1
    ? { kind: "read_material", evidenceRefs: [material.ref] } : { kind: "propose", proposal }));
  const options = { boardRoot: fx.boardRoot, scope: workspaceId, centralScope: scope, budgetId: "prospective-original-owner",
    sessionId: "next-business-session", allowance: allowance.maxTokens, now: () => Date.parse(DOMAIN_TEST_NOW), enabled: () => true,
    research: true, publicData: () => true, warn: () => {},
    readEvidence: async () => ({ ok: true as const, value: { evidence: [], receipts: [], watermark: 0, executionId: "next-business-session/next-turn" } }),
    newModel: (maxPromptChars: number) => createWorkflowImprovementModel({ provider: transport.provider.fork!(), model: "scripted-native-research", maxPromptChars }) };
  const workflow = createCentralWorkflowExecution({ ...options, contextForIssue: createCentralRuntimeContextReader({ boardRoot: fx.boardRoot, scope, enabled: () => true }) });
  const request = await groundCentralResearch({ boardRoot: fx.boardRoot, scope, enabled: () => true }, "workflow", { intentRef: intent.intentId, intent, operation }, domainTestSignal());
  const received = await acceptCentralWorkflowResearch({ boardRoot: fx.boardRoot, scope, workspaceId, enabled: () => true, workflow }, request, domainTestSignal());

  assert.ok(received.status === "accepted", JSON.stringify(received));
  const prepared = await workflow.prepare({ issueId: received.issueId, authorizedAllowance: allowance }, domainTestSignal());
  const funded = await fx.fund(prepared), dispatched = await workflow.dispatch(funded, domainTestSignal());

  assert.equal(dispatched.ok, true, canonicalJson(dispatched));
  assert.equal(transport.requests.length, 2);
  const prompt = canonicalJson(transport.requests[1]!.messages);

  assert.ok(prompt.includes(intent.goal));
  assert.ok(prompt.includes(intent.knowledge[0]!.statement));
  assert.ok(prompt.includes(intent.residual[0]!));
  const observation = await workflow.observe(funded, domainTestSignal());
  assert.equal(observation.outcome, "qualified");
  const state = await fx.load(), view = workflowImprovementsFromBoard(state, workspaceId, scope);
  assert.ok(view.ok);
  assert.equal(view.value.versions.length, 1);
  const candidate = view.value.versions[0]!;

  assert.equal(candidate.artifact.opportunity.trigger, "central_research");
  assert.equal(state.activations.length, 0);
  assert.equal(view.value.feedback.length, 0, "research cannot fabricate business effects");
  const runtime = createFileWorkflowImprovementRuntime({ ...options, newModel: () => options.newModel(24000) });

  try {
    const inventory = await runtime.context("inventory", {});
    assert.ok(inventory.ok && record(inventory.value));
    assert.ok(canonicalJson(inventory.value).includes("proposed_not_observed_business_task"));
    const wrong = await runtime.context("wrong-use", { task: { ...candidate.artifact.opportunity.task,
      taskFamily: { ...candidate.artifact.opportunity.task.taskFamily, id: "unrelated-current-operation" } }, boundary: "next phase" });

    assert.ok(wrong.ok && record(wrong.value));
    assert.equal(wrong.value.status, "not_applicable");
    const adopted = await runtime.context("real-compatible-handoff", { task: candidate.artifact.opportunity.task,
      boundary: "Before a current owner-confirming source search", versionId: candidate.versionId });

    assert.ok(adopted.ok && record(adopted.value));
    assert.equal(adopted.value.status, "frozen");
    const after = workflowImprovementsFromBoard(await fx.load(), workspaceId, scope);
    assert.ok(after.ok);
    assert.equal(after.value.uses.length, 1);
    assert.equal(after.value.uses[0]!.use.versionId, candidate.versionId);
    assert.equal(after.value.feedback.length, 0, "an actual fielding receipt still does not prove business benefit");
  } finally { await runtime.close(); }
}));
