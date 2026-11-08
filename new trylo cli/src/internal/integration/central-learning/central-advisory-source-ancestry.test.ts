import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { CENTRAL_AGENT_CAPABILITY_ROLE } from "../../learning/central/runtime/material-role.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { RewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { collectCentralAdvisoryAccessSourceInventory, collectCentralAdvisoryAccessSourceRefs,
  readCentralAdvisorySourceFailure } from "./central-advisory-source-ancestry.js";
import { readCentralAdvisoryAccessSourceInventory } from "./central-advisory-source-access.js";
import { buildCentralAdvisoryRecord, centralAdvisoryId, centralAdvisoryKnowledgeHash, readCentralAdvisory } from "./central-advisory-records.js";
import { CENTRAL_ADVISORY_TYPE } from "./central-advisory-contracts.js";
import { createUserPeerStatusMaterial } from "../user-learning/central-status-navigation.js";
import { centralRuntimeEnvironmentCondition } from "./runtime-environment-condition.js";
import type { OrganizationKnowledge, OrganizationDecision, OrganizationFeedback } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord, readOrganizationRecords } from "../../learning/central/organization/records.js";
import { retrieveOrganizationExperience } from "../../learning/central/organization/retrieval.js";
import { organizationRecallNavigationMaterial } from "./runtime-organization-memory.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createOriginalOrganizationDecisionMaterial } from "./organization-decision-material.js";
import { createCentralAdvisoryOrganizationAncestry } from "./central-advisory-organization-ancestry.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { sessionContentAddress } from "../learning-content/sources/session-address.js";

test("advisory ancestry retains omitted author inputs and archived body sources without prefix permission", async () => {
  const scope = "project:advisory-ancestry", budgetId = "budget:advisory-ancestry";
  const empty = emptyCentralRuntimeState(scope);
  const first: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...empty, materials: [{ ref: "source:archived", kind: "source", text: "Original source body.",
      sourceRefs: ["source:original-private-leaf"] }] }, reason: "Original body observed", sourceRefs: [] }), sequence: 1 };
  const state = { ...empty, materials: [{ ref: "source:state-body", kind: "source" as const, text: "Actual retained authoring body.",
    sourceRefs: ["source:state-body-parent"] }] };
  const second: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: first.id, state,
    reason: "Working set compacted", sourceRefs: [] }), sequence: 2 };
  const facts: RewardV2Fact[] = [first, second];
  const board: RewardV2BoardPort = {
    read: async () => ({ revision: facts.at(-1)!.sequence, facts: [...facts] }),

    append: async (expectedRevision, draft) => {
      const revision = facts.at(-1)!.sequence;
      if (revision !== expectedRevision) return { status: "stale" };
      facts.push({ ...draft, sequence: revision + 1 });
      return { status: "written", revision: revision + 1, idempotent: false };
    },
  };
  const capabilityText = canonicalJson({ schemaVersion: 1, role: CENTRAL_AGENT_CAPABILITY_ROLE,
    interpretation: "Host research capability menu.", input: "Original sources only.", context: "No access grant.",
    capabilities: [], boundary: "Original owners retain permission." });
  const capabilityRef = `central-agent-research-capabilities:${contentHashOf(capabilityText)}`;
  const peer = createUserPeerStatusMaterial({ ledgerRef: "user-ledger_0123456789abcdef", questionRef: "user-question_0123456789abcdef",
    sourcePrefixRef: `user-source:${"a".repeat(64)}`, hasEvidence: true, policyRefs: [] });
  const environment = centralRuntimeEnvironmentCondition([], []);
  const knowledge = { statement: "A conditional public observation.", conditions: "Only under the observed condition.", sourceRefs: ["source:public"] };
  const supportDecision: OrganizationDecision = { kind: "decision", decisionRef: "decision:original-support", purposeRef: "source:public",
    context: { purpose: "Record the original observed condition.", conditionKeys: ["observed"], known: [], residual: [] },
    program: { programRef: "program:original-support", depth: "bounded", timing: "now" },
    expectation: { change: "Retain the actual source observation", uncertainties: [] }, alternatives: [], issueRefs: [], stageRefs: [],
    sourceRefs: ["source:public"], experienceUse: null };

  assert.equal((await board.append(facts.at(-1)!.sequence, buildOrganizationRecord(scope, supportDecision))).status, "written");
  const supportFeedback: OrganizationFeedback = { kind: "feedback", decisionRef: supportDecision.decisionRef, unitRef: "source:public",
    supersedes: null, sourceRefs: ["source:public"], result: { kind: "correction", statement: "The original condition was observed.", conditions: knowledge.conditions } };
  const supportFact = buildOrganizationRecord(scope, supportFeedback);

  assert.equal((await board.append(facts.at(-1)!.sequence, supportFact)).status, "written");
  const organizationKnowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "organization:conditional", supersedes: null,
    statement: "Compare the original observed condition.", conditions: knowledge.conditions, conditionKeys: ["observed"],
    exceptions: "A later counterexample can change this hypothesis.", exceptionKeys: [], implication: "Check the original condition before reuse.",
    supportFactIds: [supportFact.id], counterexampleFactIds: [], state: "proposed" };
  const intent: CentralLearningIntentDraft = { intentId: "intent:advisory", subject: { plane: "central", questionRef: "question:advisory" },
    goal: "Understand the observed condition", rationale: "Original material changed", conditions: [], knowledge: [knowledge], residual: [],
    commitment: { purpose: "Retain the conditional observation", assumptions: [], reconsiderWhen: [] }, revisionReason: "Original result returned",
    sourceRefs: ["source:public"], derivation: { relation: "Earlier original observation", whenRelevant: "Under the same condition",
      parentRefs: ["source:archived"], citations: [{ evidenceRef: "source:citation", quote: "Original observation" }] },
    continuation: { kind: "open" } };
  const requestSequence = facts.at(-1)!.sequence;
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId, boardSequence: requestSequence,
    configuration: { schemaVersion: 1, configurationRef: "configuration:advisory", authorizationRef: "authorization:advisory",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: requestSequence, budgetId, limits: { tokens: 100000, calls: 4, steps: 4 }, occupied: { tokens: 0, calls: 0, steps: 0 },
      available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: second.id, state, opportunities: [], organization: [{ ref: "source:organization-body", kind: "organization",
      text: "Actual supplied organization body.", sourceRefs: ["source:organization-body-parent"] },
      createOrganizationFeedbackMaterial(scope, supportFact.id, supportFeedback)],
    materials: [centralMaterialFromPage({ ref: sessionContentAddress({ sessionId: "source-session", journalSequence: 7 }),
      originalRef: "session-content:original-business-body", originalScope: scope, origin: "user_statement", owner: "session",
      coordinate: { runId: "source-session", sequence: 7 }, sourceHash: contentHashOf("Original receiver."),
      start: 0, end: "Original receiver.".length, totalChars: "Original receiver.".length, text: "Original receiver." }),
      { ref: "source:public", kind: "source", text: "Original public observation.", sourceRefs: [] },
      { ref: "source:omitted-by-model", kind: "source", text: "Another actual authoring input.", sourceRefs: ["unknown:private-session"] },
      { ref: "ordinary:quoted-control-role", kind: "source", text: canonicalJson({ role: "central_active_purpose_navigation" }),
        sourceRefs: ["unknown:quoted-role-leaf"] },
      { ref: capabilityRef, kind: "source", text: capabilityText, sourceRefs: [] }, peer, environment],
    operation: { kind: "think", operationId: "operation:advisory", purpose: "Understand the condition", expectedChange: "A conditional observation",
      sourceRefs: ["source:operation-input"] } };
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: "unused-in-memory-board", scope, budgetId, enabled: () => true, board });
  const handoff = { kind: "publish" as const, intentId: intent.intentId, knowledgeHash: centralAdvisoryKnowledgeHash(knowledge),
    whenRelevant: knowledge.conditions, uncertainty: "No independent later-use benefit is known." };
  const delivery = await receipts.save({ request, output: { schemaVersion: 1, intents: [intent], publicExplanation: "Conditional observation retained.",
    sourceRefs: ["source:decision-support"], knowledgeHandoffs: [handoff], organizationKnowledge: [organizationKnowledge] } });
  const resultRef = `central-deliberation-result:${contentHashOf(delivery.output)}`;
  const applied = buildCentralRuntimeRecord({ previousRef: second.id, state: { ...state, intents: [intent], completed: [{
    intentId: "central:agenda", operation: request.operation, outcome: "returned", resultRefs: [resultRef],
    publicResult: delivery.output.publicExplanation }] }, reason: "central_deliberation_returned", sourceRefs: delivery.output.sourceRefs,
    opportunityConsideration: { operationId: request.operation.operationId, deliveryRef: delivery.deliveryRef, resultRef, sourceRefs: [] } });

  assert.equal((await board.append(facts.at(-1)!.sequence, applied)).status, "written");
  const appliedSequence = facts.at(-1)!.sequence;
  const organizationFact = buildOrganizationRecord(scope, organizationKnowledge);

  assert.equal((await board.append(facts.at(-1)!.sequence, organizationFact)).status, "written");
  const original = { ...emptyBoardState(), sequence: facts.at(-1)!.sequence, rewardV2Facts: facts };
  const input = { intent, knowledge, delivery }, result = collectCentralAdvisoryAccessSourceInventory(original, scope, input);

  assert.throws(() => collectCentralAdvisoryAccessSourceInventory({ ...emptyBoardState(), sequence: appliedSequence - 1,
    rewardV2Facts: facts.filter(fact => fact.sequence < appliedSequence) }, scope, input),
  error => readCentralAdvisorySourceFailure(error)?.reason === "central_advisory_source_author_unavailable");

  for (const ref of ["source:original-private-leaf", "unknown:private-session", "unknown:quoted-role-leaf", "source:citation",
    "source:operation-input", "source:decision-support", "source:state-body-parent", "source:organization-body-parent",
    capabilityRef, delivery.deliveryRef]) assert.ok(result.sourceRefs.includes(ref), ref);

  assert.ok(result.controlRefs.includes(capabilityRef));
  assert.ok(result.controlRefs.includes(delivery.deliveryRef));
  assert.ok(result.controlRefs.includes(peer.ref));
  assert.ok(!result.sourceRefs.includes(peer.sourceRefs[0]!));
  assert.ok(result.controlRefs.includes(environment.ref));
  assert.ok(!result.controlRefs.includes("ordinary:quoted-control-role"));
  assert.ok(!result.controlRefs.includes("unknown:private-session"));
  const businessAddress = sessionContentAddress({ sessionId: "source-session", journalSequence: 7 });

  assert.ok(result.sourceRefs.includes(businessAddress));
  assert.ok(!result.controlRefs.includes(businessAddress),
    "a source-page wrapper cannot exempt its real session address from the owner access check");
  assert.deepEqual(collectCentralAdvisoryAccessSourceRefs(original, scope, input), result.sourceRefs);
  assert.equal(new Set(result.sourceRefs).size, result.sourceRefs.length);
  assert.throws(() => collectCentralAdvisoryAccessSourceRefs(original, scope, { ...input,
    delivery: { ...delivery, output: { ...delivery.output, sourceRefs: [] } } }), /central_advisory_source_delivery_unconfirmed/);
  const publication = buildCentralAdvisoryRecord({ schemaVersion: 1, type: CENTRAL_ADVISORY_TYPE, kind: "publish", scope, budgetId,
    advisoryId: centralAdvisoryId(scope, intent.intentId, handoff.knowledgeHash), intentId: intent.intentId,
    purposeHeadRef: applied.id, purposeConditions: intent.conditions, knowledgeHash: handoff.knowledgeHash, ...knowledge,
    whenRelevant: handoff.whenRelevant, uncertainty: handoff.uncertainty, accessSourceRefs: result.sourceRefs,
    decisionRef: request.operation.operationId, deliveryRef: delivery.deliveryRef, appliedStateRef: applied.id,
    appliedSequence, previousPublicationRef: null });

  assert.equal((await board.append(facts.at(-1)!.sequence, publication)).status, "written");
  const publishedBoard = { ...emptyBoardState(), sequence: facts.at(-1)!.sequence, rewardV2Facts: facts };
  const view = readCentralAdvisory(publishedBoard, scope, { ref: centralAdvisoryId(scope, intent.intentId, handoff.knowledgeHash), version: publication.id });

  assert.ok(view);
  assert.deepEqual(readCentralAdvisoryAccessSourceInventory(publishedBoard, scope, view), result);
  const ended = { ...intent, continuation: { kind: "ended" as const, goalState: "open" as const, reason: "No further research is selected." } };
  const endedFact = buildCentralRuntimeRecord({ previousRef: applied.id, state: { ...state, intents: [ended] },
    reason: "Original purpose retained as ended", sourceRefs: ended.sourceRefs });

  assert.equal((await board.append(facts.at(-1)!.sequence, endedFact)).status, "written");
  const compact = buildCentralRuntimeRecord({ previousRef: endedFact.id, state, reason: "Ended purpose compacted", sourceRefs: [] });

  assert.equal((await board.append(facts.at(-1)!.sequence, compact)).status, "written");
  const organizationDecision: OrganizationDecision = { kind: "decision", decisionRef: request.operation.operationId, purposeRef: request.operation.operationId,
    context: { purpose: "Inspect the actual publication feedback.", conditionKeys: ["observed"], known: [], residual: [] },
    program: { programRef: "program:original", depth: "bounded", timing: "now" }, expectation: { change: "Retain the original correction", uncertainties: [] },
    alternatives: [], issueRefs: [], stageRefs: [], sourceRefs: [publication.id], experienceUse: null };

  assert.equal((await board.append(facts.at(-1)!.sequence, buildOrganizationRecord(scope, organizationDecision))).status, "written");
  const organizationFeedback: OrganizationFeedback = { kind: "feedback", decisionRef: organizationDecision.decisionRef,
    unitRef: request.operation.operationId, supersedes: null, sourceRefs: [publication.id],
    result: { kind: "correction", statement: "The original publication retains its uncertainty.", conditions: "Only under the observed condition." } };
  const feedbackFact = buildOrganizationRecord(scope, organizationFeedback);

  assert.equal((await board.append(facts.at(-1)!.sequence, feedbackFact)).status, "written");
  const packet = retrieveOrganizationExperience(readOrganizationRecords(facts, scope, facts.at(-1)!.sequence), {
    purpose: "Compare the observed condition", conditionKeys: ["observed"], sourceRefs: [], maximumEntries: 8, maximumCharacters: 24000 });
  const queryText = canonicalJson({ role: "organization_retrieval_context_not_business_evidence", query: packet.query, recallRef: packet.recallRef });
  const organizationInput = [{ ref: packet.recallRef, kind: "organization" as const, text: packet.materialJson,
    sourceRefs: [packet.recallRef, ...packet.entries.map(entry => entry.factId)] },
    { ref: `organization-query:${contentHashOf(queryText)}`, kind: "organization" as const, text: queryText, sourceRefs: packet.query.sourceRefs },
    organizationRecallNavigationMaterial(), createOrganizationFeedbackMaterial(scope, feedbackFact.id, organizationFeedback),
    createOriginalOrganizationDecisionMaterial(readOrganizationRecords(facts, scope, facts.at(-1)!.sequence).decisions[0]!)];
  const archivedBody = { ref: `central-runtime-purpose-record:${contentHashOf([ended.intentId, endedFact.id])}`, kind: "work_result" as const,
    sourceRefs: [ended.intentId, endedFact.id], text: canonicalJson({ role: "exact_original_ended_learning_purpose_not_new_evidence",
      factRef: endedFact.id, value: ended }) };
  const archivedRequest = { ...request, boardSequence: facts.at(-1)!.sequence, stateRef: compact.id, state,
    resources: { ...request.resources, boardSequence: facts.at(-1)!.sequence }, organization: organizationInput,
    materials: [request.materials[0]!, archivedBody, peer, environment],
    operation: { ...request.operation, operationId: "operation:publish-archived" } };
  const archivedDelivery = await receipts.save({ request: archivedRequest,
    output: { ...delivery.output, intents: [], publicExplanation: "Explicitly publish the delivered original archived knowledge." } });
  const archivedBoard = { ...emptyBoardState(), sequence: facts.at(-1)!.sequence, rewardV2Facts: facts };
  const originalDecision = organizationInput.at(-1)!;
  const ancestry = createCentralAdvisoryOrganizationAncestry(archivedBoard, scope);

  assert.ok(ancestry.isOriginalDecisionMaterial(originalDecision, archivedBoard.sequence));
  assert.equal(ancestry.isOriginalDecisionMaterial(originalDecision, 0), false);
  assert.equal(ancestry.isOriginalDecisionMaterial({ ...originalDecision, text: originalDecision.text + " " }, archivedBoard.sequence), false);
  const archivedInventory = collectCentralAdvisoryAccessSourceInventory(archivedBoard, scope,
    { intent: ended, knowledge, delivery: archivedDelivery });

  assert.ok(archivedInventory.controlRefs.includes(archivedBody.ref));
  assert.ok(archivedInventory.controlRefs.includes(packet.recallRef));
  assert.ok(archivedInventory.controlRefs.includes(organizationInput[1]!.ref));
  assert.ok(archivedInventory.controlRefs.includes(organizationFact.id));
  assert.ok(archivedInventory.controlRefs.includes(feedbackFact.id));
  assert.ok(archivedInventory.controlRefs.includes(publication.id), "real publication feedback follows the original native authority edge");
  assert.ok(archivedInventory.sourceRefs.includes("unknown:private-session"), "a later public-only publishing request cannot erase its creator's private input");
  assert.throws(() => collectCentralAdvisoryAccessSourceInventory(archivedBoard, scope,
    { intent: { ...ended, goal: "Substituted caller body" }, knowledge, delivery: archivedDelivery }), /central_advisory_source_delivery_unconfirmed/);
});
