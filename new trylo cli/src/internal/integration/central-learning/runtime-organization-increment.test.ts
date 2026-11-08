import assert from "node:assert/strict";
import test from "node:test";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import type { OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { centralOrganizationDeliberationRef, projectOrganizationRuntimeProgress } from "./organization-feedback-runtime.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";

test("organization increment uses actual no-menu business context and recovers the original delivered query", async () => {
  const scope = "workspace:organization-increment", signal = new AbortController().signal;
  let revision = 0;
  const facts: RewardV2Fact[] = [];
  const board = { async read() { return { revision, facts }; }, async append(expected: number, fact: RewardV2Draft) {
    if (expected !== revision) return { status: "stale" as const };
    revision += 1;
    facts.push({ ...fact, sequence: revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const options = { scope, boardRoot: "unused", enabled: () => true, board };
  const service = createCentralOrganizationService(options), runtime = createCentralRuntimeOrganization({ ...options, service });
  const state = emptyCentralRuntimeState(scope);
  const business = { ref: "source:actual-business", kind: "source" as const,
    text: "A declared schema controls structured document validation", sourceRefs: ["notice:actual-human-input"] };
  const organization = await runtime.recall({ scope, state, opportunities: [], materials: [business], signal });
  const query = JSON.parse(organization[1]!.text).query;

  assert.ok(query.purpose.includes("declared schema"));
  assert.ok(query.sourceRefs.includes(business.ref));
  assert.ok(!query.purpose.includes("Organize the remaining authorized learning purposes"));
  const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 4000 } as const;
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: "budget:original",
    configuration: { schemaVersion: 1, configurationRef: "configuration:original", authorizationRef: "authorization:original", allowance },
    boardSequence: 0, resources: { boardSequence: 0, budgetId: "budget:original", limits: { tokens: 1000, calls: 2, steps: 2 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 1000, calls: 2, steps: 2 }, status: "available", holdReason: null },
    stateRef: initialCentralRuntimeRef(scope), state, opportunities: [], organization,
    materials: [business, { ref: "source:old-context", kind: "source", text: "An older unrelated archived source", sourceRefs: [] }],
    operation: { kind: "think", operationId: "operation:no-menu", purpose: "Select a justified learning purpose",
      expectedChange: "Decide whether this actual source warrants learning", sourceRefs: [business.ref] } };
  const resumed = createCentralRuntimeOrganization({ ...options, service });

  await resumed.recordDecision!({ request, decisionRef: "operation:no-menu", deliveryRef: "provider-delivery:scripted-contract",
    output: { schemaVersion: 1, intents: [], publicExplanation: "Retain the original source and wait for its actual use evidence",
      sourceRefs: [business.ref], organizationUse: { recallRef: organization[0]!.ref, changes: [] } } }, signal);
  const saved = await service.read();
  assert.equal(saved.status, "ready");
  if (saved.status !== "ready") return;

  assert.equal(saved.projection.decisions[0]!.value.experienceUse?.packet.query.purpose, query.purpose);
  const operation = { kind: "read" as const, operationId: "duration-read-original", purpose: "Read the actual original source",
    expectedChange: "Clarify the declared schema", sourceRefs: [business.ref], refs: [business.ref], maximumChars: 2048 };
  const pending: CentralLearningIntentDraft = { intentId: "intent:pending", subject: { plane: "central", questionRef: "intent:pending" },
    goal: "Understand the original declared-schema requirement", rationale: "Actual business source needs inspection", conditions: ["Declared schema"],
    knowledge: [], residual: ["Original source meaning"], commitment: { purpose: "Inspect the actual source", assumptions: [], reconsiderWhen: [] },
    revisionReason: "Retain a pending original read", sourceRefs: [business.ref], continuation: { kind: "ready", operation } };
  const pendingOutput = { schemaVersion: 1 as const, intents: [pending], publicExplanation: "Keep the original pending read", sourceRefs: [business.ref] };

  await resumed.recordDecision!({ request, decisionRef: operation.operationId, deliveryRef: "delivery:first-choice", output: pendingOutput }, signal);
  const frozen = await service.read();
  assert.equal(frozen.status, "ready");
  if (frozen.status !== "ready") return;

  const original = frozen.projection.decisions.find(row => row.value.decisionRef === operation.operationId)!;
  const afterReconsideration = { ...request, stateRef: "state:actual-new-reconsideration",
    operation: { ...request.operation, operationId: "operation:reconsider-original-read" } };

  await resumed.recordDecision!({ request: afterReconsideration, decisionRef: operation.operationId,
    deliveryRef: "delivery:later-reconsideration", output: pendingOutput }, signal);
  const retained = await service.read();
  assert.equal(retained.status, "ready");
  if (retained.status !== "ready") return;

  assert.deepEqual(retained.projection.decisions.find(row => row.value.decisionRef === operation.operationId), original);
  assert.ok(original.value.sourceRefs.includes("delivery:first-choice"));
  assert.ok(!original.value.sourceRefs.includes("delivery:later-reconsideration"));
  await resumed.recordDecision!({ request: afterReconsideration, decisionRef: afterReconsideration.operation.operationId,
    deliveryRef: "delivery:later-reconsideration", output: pendingOutput }, signal);
  const planning = await service.read();
  assert.equal(planning.status, "ready");
  if (planning.status !== "ready") return;

  const actualPlan = planning.projection.decisions.find(row => row.value.decisionRef === centralOrganizationDeliberationRef(scope, afterReconsideration.operation.operationId))!.value;

  assert.equal(actualPlan.context.purpose, afterReconsideration.operation.purpose);
  assert.deepEqual(actualPlan.stageRefs, [operation.operationId]);
  assert.ok(actualPlan.program.depth.includes(operation.operationId));
  assert.ok(actualPlan.sourceRefs.includes("delivery:later-reconsideration"));
  assert.ok(actualPlan.sourceRefs.some(ref => ref.startsWith("central-deliberation:")));
  await assert.rejects(resumed.recordDecision!({ request: afterReconsideration, decisionRef: operation.operationId,
    output: { ...pendingOutput, intents: [{ ...pending, continuation: { kind: "ready", operation: { ...operation, maximumChars: 4096 } } }] } }, signal),
  /organization_decision_choice_conflict/);
  await assert.rejects(resumed.recordDecision!({ request, decisionRef: "operation:wrong", role: "operation_expectation", output: pendingOutput }, signal),
    /organization_expectation_operation_mismatch/);
  const think = { kind: "think" as const, operationId: "duration-compare-premises", purpose: "Compare the actual read premises",
    expectedChange: "Choose whether native research is useful", sourceRefs: [business.ref] };
  const thinking = { ...pending, continuation: { kind: "ready" as const, operation: think } };
  const chosen = { ...pendingOutput, intents: [thinking] };

  await resumed.recordDecision!({ request, output: chosen, decisionRef: think.operationId, role: "operation_expectation", deliveryRef: "delivery:selected-think" }, signal);
  const beforeThink = await service.read();
  assert.equal(beforeThink.status, "ready");
  if (beforeThink.status !== "ready") return;

  const originalThink = beforeThink.projection.decisions.find(row => row.value.decisionRef === think.operationId)!;
  const returnedRequest = { ...request, operation: think };
  const nextOperation = { ...operation, operationId: "operation:after-comparison" };
  const actualOutput = { ...pendingOutput, intents: [{ ...pending, continuation: { kind: "ready" as const, operation: nextOperation } }] };

  await resumed.recordDecision!({ request: returnedRequest, output: actualOutput, decisionRef: think.operationId,
    role: "deliberation", deliveryRef: "delivery:actual-think" }, signal);
  await resumed.recordDecision!({ request: returnedRequest, output: actualOutput, decisionRef: nextOperation.operationId,
    role: "operation_expectation", deliveryRef: "delivery:actual-think" }, signal);
  const afterThink = await service.read();
  assert.equal(afterThink.status, "ready");
  if (afterThink.status !== "ready") return;

  assert.deepEqual(afterThink.projection.decisions.find(row => row.value.decisionRef === think.operationId), originalThink);
  const computationRef = centralOrganizationDeliberationRef(scope, think.operationId);
  const computation = afterThink.projection.decisions.find(row => row.value.decisionRef === computationRef)!.value;

  assert.equal(computation.purposeRef, think.operationId);
  assert.ok(computation.sourceRefs.includes(think.operationId));
  assert.ok(computation.sourceRefs.includes("delivery:actual-think"));
  assert.deepEqual(computation.stageRefs, [nextOperation.operationId]);
  const completed = { intentId: thinking.intentId, operation: think, outcome: "returned" as const,
    publicResult: "Actual comparison returned the next bounded read", resultRefs: ["result:actual-comparison"] };
  const runtimeFact = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...state, completed: [completed] },
    reason: "actual_original_computation_returned", sourceRefs: completed.resultRefs });

  await board.append(revision, runtimeFact);
  const projected = projectOrganizationRuntimeProgress({ ...emptyBoardState(), sequence: revision, rewardV2Facts: facts }, afterThink.projection,
    [think.operationId, computationRef]);

  assert.equal(projected.length, 2);
  assert.ok(projected.every(row => row.unitRef === think.operationId && row.result.kind === "progress"));
  assert.deepEqual(new Set(projected.map(row => row.decisionRef)), new Set([think.operationId, computationRef]));
  const observed = await service.observe(projected.find(row => row.decisionRef === think.operationId)!, revision);

  assert.equal(observed.status, "saved");
  if (observed.status !== "saved") return;

  const oldProgress = projected.find(row => row.decisionRef === think.operationId)!;
  const lateOperation = { ...think, operationId: "operation:late-comparison" };
  const lateRequest = { ...request, operation: lateOperation, boardSequence: observed.revision,
    organization: [...organization, { ref: observed.factId, kind: "organization" as const, text: JSON.stringify(oldProgress), sourceRefs: oldProgress.sourceRefs }] };
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:current-head", supersedes: null,
    statement: "Read the declared schema prerequisite before comparing procedures", conditions: "Declared schema unknown", conditionKeys: [],
    exceptions: "Schema already known", exceptionKeys: [], implication: "Read the prerequisite first",
    supportFactIds: [observed.factId], counterexampleFactIds: [], state: "proposed" };

  assert.equal((await service.reviseKnowledge(knowledge, revision)).status, "saved");
  const staleChoice = { ...pending, continuation: { kind: "ready" as const, operation: { ...operation, operationId: "operation:stale-choice" } } };
  const lateInput = { request: lateRequest, decisionRef: lateOperation.operationId, role: "deliberation" as const, effects: "record_only" as const,
    deliveryRef: "delivery:immutable-late-output", output: { ...pendingOutput, intents: [staleChoice],
      organizationUse: { recallRef: organization[0]!.ref, changes: [] }, organizationKnowledge: [{ ...knowledge, knowledgeId: "knowledge:historical-output" }] } };

  await resumed.recordDecision!(lateInput, signal);
  const late = await service.read();
  assert.equal(late.status, "ready");
  if (late.status !== "ready") return;

  const historical = late.projection.decisions.find(row => row.value.decisionRef === centralOrganizationDeliberationRef(scope, lateOperation.operationId))!.value;

  assert.equal(historical.experienceUse, null);
  assert.ok(historical.context.known.some(row => row.includes("does not assert")));
  assert.ok(historical.sourceRefs.includes(lateInput.deliveryRef));
  assert.equal(late.projection.knowledge.length, 1);
  assert.ok(!late.projection.decisions.some(row => row.value.decisionRef === "operation:stale-choice"));
  const beforeLateRetry = revision;
  await resumed.recordDecision!(lateInput, signal);
  assert.equal(revision, beforeLateRetry);
});
