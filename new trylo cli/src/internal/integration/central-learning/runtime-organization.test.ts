import assert from "node:assert/strict";
import test from "node:test";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createOrganizationFeedbackMaterial, readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { readCentralOrganizationMemory } from "./runtime-organization-memory.js";
import { createOrganizationPublicationCondition, readOrganizationPublicationCondition } from "./organization-publication-material.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { organizationPublicationHeadReadRef, readOrganizationCandidateView, readOrganizationKnowledgeView,
  readOrganizationKnowledgeRevisionLocator } from "./organization-publication-view.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { createOrganizationPublicationResults } from "./organization-publication-results.js";
import { organizationPublicationReturnReadRef } from "./organization-publication-memory.js";

const scope = "workspace:runtime-organization", signal = new AbortController().signal;
const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 2000, maxCalls: 2, maxSteps: 2, maxPromptChars: 4000 } as const;
const intent: CentralLearningIntentDraft = { intentId: "intent:tool", subject: { plane: "agent", domain: "tool", issueId: "issue:tool" },
  goal: "Resolve the original tool contract question", rationale: "The missing premise blocks safe reuse", conditions: ["Same tool family"],
  knowledge: [], residual: ["Contract premise"], commitment: { purpose: "Find the prerequisite before comparing tools",
    assumptions: ["The premise is recoverable"], reconsiderWhen: ["Source cannot be obtained"] }, revisionReason: "Initial commitment",
  sourceRefs: ["source:tool"], continuation: { kind: "ready", operation: { kind: "dispatch", operationId: "operation:next",
    purpose: "Read the missing prerequisite", expectedChange: "Disambiguate the contract", sourceRefs: ["source:tool"], allowance } } };
const previous: OrganizationDecision = { kind: "decision", decisionRef: "decision:prior", purposeRef: "intent:prior",
  context: { purpose: "Learn a tool contract", conditionKeys: ["domain:tool"], known: [], residual: ["Missing prerequisite"] },
  program: { programRef: "program:prior", depth: "Compare before inspecting prerequisites", timing: "now" },
  expectation: { change: "Choose a tool", uncertainties: ["Unknown contract"] }, alternatives: ["Inspect the contract first"],
  issueRefs: ["issue:prior"], stageRefs: ["operation:prior"], sourceRefs: ["source:prior"], experienceUse: null };

async function fixture() {
  let revision = 0;
  const facts: RewardV2Fact[] = [];
  const board = { async read() { return { revision, facts: [...facts] }; }, async append(expected: number, draft: RewardV2Draft) {
    const existing = facts.find(item => item.id === draft.id);
    if (existing !== undefined) return { status: "written" as const, revision, idempotent: true };
    if (expected !== revision) return { status: "stale" as const };
    revision += 1;
    facts.push({ ...draft, sequence: revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const options = { boardRoot: "unused-injected-original-port", scope, enabled: () => true, board };
  const service = createCentralOrganizationService(options);

  assert.equal((await service.freezeDecision(previous, 0)).status, "saved");
  const feedback: OrganizationFeedback = { kind: "feedback", decisionRef: previous.decisionRef, unitRef: "owner:prior-progress",
    supersedes: null, sourceRefs: ["source:prior"], result: { kind: "progress", summary: "Comparison could not settle the unknown premise",
      remaining: ["Read original contract"], resultRefs: ["result:prior"] } };
  const observed = await service.observe(feedback, revision);
  assert.equal(observed.status, "saved");

  if (observed.status !== "saved") throw new Error("seed failed");

  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:premise", supersedes: null,
    statement: "Inspect a blocking premise before spending on comparisons", conditions: "A missing tool contract premise",
    conditionKeys: ["domain:tool"], exceptions: "The premise is already verified", exceptionKeys: ["premise:verified"],
    implication: "Read the prerequisite first", supportFactIds: [observed.factId], counterexampleFactIds: [], state: "proposed" };

  assert.equal((await service.reviseKnowledge(knowledge, revision)).status, "saved");
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: "budget:original",
    configuration: { schemaVersion: 1, configurationRef: "configuration:original", authorizationRef: "authorization:original", allowance },
    boardSequence: revision, resources: { boardSequence: revision, budgetId: "budget:original",
      limits: { tokens: 10000, calls: 10, steps: 10 }, occupied: { tokens: 0, calls: 0, steps: 0 },
      available: { tokens: 10000, calls: 10, steps: 10 }, status: "available", holdReason: null },
    stateRef: "state:prior", state: { schemaVersion: 1, scope, intents: [intent], completed: [],
      running: [], materials: [], consumedSourceRefs: [] }, opportunities: [], materials: [], organization: [],
    operation: { kind: "think", operationId: "operation:think", purpose: "Organize original learning", expectedChange: "Select a research procedure", sourceRefs: ["source:tool"] } };

  return { service, options, request, revision: () => revision, facts: () => facts };
}

test("actual organization material changes the next public program only with a trusted delivery receipt", async () => {
  const f = await fixture(), runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service });
  const organization = await runtime.recall({ scope, state: f.request.state, opportunities: [], signal });
  const material = JSON.parse(organization[0]!.text) as { entries: { factId: string }[] };

  assert.equal(material.entries.length, 1);
  const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent], publicExplanation: "Read the prerequisite first",
    sourceRefs: ["source:tool"], alternatives: ["Compare before reading", "Wait for a business task"],
    organizationUse: { recallRef: organization[0]!.ref, changes: [{ knowledgeFactId: material.entries[0]!.factId, choice: "program",
      before: "Compare tools first", after: "Read the missing premise first", reason: "Same missing-premise condition; verified-premise exception is absent" }] } };

  await runtime.recordDecision!({ request: { ...f.request, organization }, output, decisionRef: "operation:next",
    deliveryRef: "provider-delivery:actual" }, signal);
  const loaded = await f.service.read();
  assert.equal(loaded.status, "ready");
  if (loaded.status !== "ready") return;

  const decision = loaded.projection.decisions.find(item => item.value.decisionRef === "operation:next")!.value;

  assert.equal(decision.experienceUse!.deliveryRef, "provider-delivery:actual");
  assert.equal(decision.experienceUse!.changes[0]!.after, "Read the missing premise first");
  assert.deepEqual(decision.alternatives, output.alternatives);
  const beforeRetry = f.facts().length;
  const resumed = createCentralRuntimeOrganization({ ...f.options, service: f.service });

  await resumed.recordDecision!({ request: { ...f.request, organization }, output, decisionRef: "operation:next",
    deliveryRef: "provider-delivery:actual" }, signal);
  assert.equal(f.facts().length, beforeRetry);
});

test("a prepared request reference cannot claim delivered experience", async () => {
  const f = await fixture(), runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service });
  const organization = await runtime.recall({ scope, state: f.request.state, opportunities: [], signal });

  await runtime.recordDecision!({ request: { ...f.request, organization }, output: { schemaVersion: 1, intents: [intent],
    publicExplanation: "Choose prerequisite", sourceRefs: ["request:only"], organizationUse: { recallRef: organization[0]!.ref, changes: [] } },
    decisionRef: "operation:next" }, signal);
  const loaded = await f.service.read();
  assert.equal(loaded.status, "ready");
  if (loaded.status !== "ready") return;

  assert.equal(loaded.projection.decisions.at(-1)!.value.experienceUse, null);
});

test("a native completion without a frozen organization choice never invents a decision or orphan feedback", async () => {
  const f = await fixture();
  let ownerFeedbackReads = 0;
  const runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service,

    feedback: async () => {
      ownerFeedbackReads += 1;
      return [];
    } });
  const operation = intent.continuation.kind === "ready" ? intent.continuation.operation : undefined;

  assert.ok(operation);
  const completed = { intentId: intent.intentId, operation, outcome: "returned" as const,
    publicResult: "Original native result is retained by the runtime", resultRefs: ["native-result:original"] };
  const original = structuredClone(completed), count = f.facts().length;

  assert.deepEqual(await runtime.recordResult!({ scope, decisionRef: operation.operationId, completed }, signal), []);
  assert.equal(f.facts().length, count);
  assert.equal(ownerFeedbackReads, 0);
  assert.deepEqual(completed, original);
  // A genuine later freeze may receive this same original unit, without
  // redispatching work or treating the prior absence as an implicit choice.
  await runtime.recordDecision!({ request: f.request, output: { schemaVersion: 1, intents: [intent],
    publicExplanation: "Inspect the prerequisite", sourceRefs: ["source:tool"] }, decisionRef: operation.operationId }, signal);
  const published = await runtime.recordResult!({ scope, decisionRef: operation.operationId, completed }, signal);

  assert.equal(published?.length, 1);
  const after = f.facts().length;

  await runtime.recordResult!({ scope, decisionRef: operation.operationId, completed }, signal);
  assert.equal(f.facts().length, after);
});

test("real progress, costs and observed use/outcome return original fact references for the next knowledge update", async () => {
  const f = await fixture();
  const runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service,
    feedback: async input => [
      { kind: "feedback", decisionRef: input.decisionRef, unitRef: "owner:actual-call", supersedes: null, sourceRefs: ["receipt:usage"],
        result: { kind: "cost", usage: { kind: "reported", tokens: 321, calls: 1, steps: 1 } } },
      { kind: "feedback", decisionRef: input.decisionRef, unitRef: "owner:actual-use", supersedes: null, sourceRefs: ["receipt:use"],
        result: { kind: "adoption", state: "used", artifactRefs: ["artifact:actual"], exposureRef: "exposure:actual" } },
      { kind: "feedback", decisionRef: input.decisionRef, unitRef: "owner:actual-outcome", supersedes: null, sourceRefs: ["receipt:outcome"],
        result: { kind: "outcome", state: "observed", summary: "The original task check passed", exposureRef: "exposure:actual", attribution: "source_reported" } },
    ] });
  const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent], publicExplanation: "Read prerequisite", sourceRefs: ["source:tool"] };

  await runtime.recordDecision!({ request: f.request, output, decisionRef: "operation:next" }, signal);
  const operation = intent.continuation.kind === "ready" ? intent.continuation.operation : f.request.operation;
  const completed = { intentId: intent.intentId, operation, outcome: "returned" as const, publicResult: "Original research result",
    resultRefs: ["artifact:actual"] };
  const materials = await runtime.recordResult!({ scope, decisionRef: "operation:next", completed }, signal);

  assert.ok(materials);
  assert.equal(materials.length, 4);
  const cost = materials.map(item => ({ material: item, feedback: readOrganizationFeedbackMaterial(item, scope) }))
    .find(item => item.feedback?.value.result.kind === "cost")!;

  assert.ok(cost.feedback);
  assert.equal(cost.feedback.value.result.kind, "cost");

  if (cost.feedback.value.result.kind !== "cost") return;

  assert.equal(cost.feedback.value.result.usage.kind === "reported" && cost.feedback.value.result.usage.tokens, 321);
  assert.ok(cost.material.ref.startsWith("organization-feedback-material:"));
  assert.ok(cost.feedback.factId.startsWith("organization-record:"));
  assert.ok(cost.material.sourceRefs.includes(cost.feedback.factId));
  assert.deepEqual(createOrganizationFeedbackMaterial(scope, cost.feedback.factId, cost.feedback.value), cost.material);
  assert.equal(readOrganizationFeedbackMaterial({ ...cost.material, sourceRefs: [] }, scope), undefined);
  assert.equal(readOrganizationFeedbackMaterial({ ...cost.material, text: cost.material.text.replace("321", "322") }, scope), undefined);
  assert.equal(readOrganizationFeedbackMaterial(cost.material, `${scope}:other`), undefined);
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:cost", supersedes: null,
    statement: "This prerequisite program used 321 reported tokens in the observed condition", conditions: "Same tool family",
    conditionKeys: ["domain:tool"], exceptions: "Different contract shape", exceptionKeys: ["contract:different"],
    implication: "Consider this cost evidence before selecting depth", supportFactIds: [cost.feedback.factId], counterexampleFactIds: [], state: "proposed" };
  const later = { ...intent, continuation: { kind: "ready" as const, operation: { ...operation, operationId: "operation:later" } } };

  await runtime.recordDecision!({ request: f.request, output: { ...output, intents: [later], organizationKnowledge: [knowledge] }, decisionRef: "operation:later" }, signal);
  const recalled = await runtime.recall({ scope, state: f.request.state, opportunities: [], signal });

  assert.ok(recalled[0]!.text.includes("321 reported tokens"));
  assert.ok(recalled[0]!.text.includes("source_reported") || recalled[0]!.text.includes("reported"));
});

test("multiple ready operations freeze their own purposes before the shared output publishes organization knowledge", async () => {
  const f = await fixture(), runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service });
  const organization = await runtime.recall({ scope, state: f.request.state, opportunities: [], signal });
  const packet = JSON.parse(organization[0]!.text) as { entries: { factId: string }[] };
  const projection = await f.service.read();
  assert.equal(projection.status, "ready");
  if (projection.status !== "ready") return;

  const operation = intent.continuation.kind === "ready" ? intent.continuation.operation : f.request.operation;
  const second = { ...intent, intentId: "intent:second", goal: "Find a complementary counterexample", continuation: { kind: "ready" as const,
    operation: { ...operation, operationId: "operation:second", purpose: "Test the complementary explanation" } } };
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:complement", supersedes: null,
    statement: "A prerequisite and a counterexample can be complementary", conditions: "Missing tool premise", conditionKeys: ["domain:tool"],
    exceptions: "An already decisive source", exceptionKeys: ["source:decisive"], implication: "Preserve the complementary operation",
    supportFactIds: [projection.projection.feedback[0]!.factId], counterexampleFactIds: [], state: "proposed" };
  const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent, second], publicExplanation: "Prepare two complementary computations",
    sourceRefs: ["source:tool"], organizationUse: { recallRef: organization[0]!.ref, changes: [{ knowledgeFactId: packet.entries[0]!.factId,
      choice: "program", before: "Compare first", after: "Read prerequisites first", reason: "Same blocking premise" }] },
    organizationKnowledge: [knowledge] };

  for (const decisionRef of ["operation:next", "operation:second"]) await runtime.recordDecision!({
    request: { ...f.request, organization }, output, decisionRef, deliveryRef: "delivery:two-computations" }, signal);

  const after = await f.service.read();
  assert.equal(after.status, "ready");
  if (after.status !== "ready") return;

  assert.equal(after.projection.decisions.find(row => row.value.decisionRef === "operation:second")!.value.context.purpose, second.goal);
  assert.equal(after.projection.knowledge.filter(row => row.value.knowledgeId === knowledge.knowledgeId).length, 1);
});

test("recall refreshes only related original sources and returns late feedback even without a knowledge hypothesis", async () => {
  const f = await fixture();
  let selected: unknown;
  const runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service,
    refresh: { async refresh(input) { selected = input;
    return { status: "ready", revision: f.revision(), materials: [
      { ref: "organization-record:late-original-feedback", kind: "organization", text: "Source-owned late business feedback", sourceRefs: ["source:late"] },
    ], sourceRefs: ["source:late"], omittedDecisions: 0 }; } } });
  const state = { ...f.request.state, intents: [{ ...intent, sourceRefs: ["source:tool", "organization-record:derived", "organization-recall:derived"] }] };
  const material = await runtime.recall({ scope, state, opportunities: [], signal });

  assert.deepEqual(selected, { issueRefs: ["issue:tool"], sourceRefs: ["source:tool"] });
  assert.ok(material.some(item => item.ref === "organization-record:late-original-feedback"));
  const query = JSON.parse(material[1]!.text).query as { conditionKeys: string[] };

  assert.ok(query.conditionKeys.some(key => key.startsWith("condition:")));
});

test("determined knowledge rejection preserves the original proposal and head while prefix, privacy and unknown writes stay hard", async () => {
  const f = await fixture(), runtime = createCentralRuntimeOrganization({ ...f.options, service: f.service });
  const seeded = await f.service.read();
  assert.equal(seeded.status, "ready");
  if (seeded.status !== "ready") return;

  const head = seeded.projection.knowledge[0]!, feedback = seeded.projection.feedback[0]!;
  const candidate: OrganizationKnowledge = { ...head.value, statement: "Another source-bound formulation still needs an explicit prior head" };
  const waiting: CentralLearningIntentDraft = { ...intent, continuation: { kind: "waiting", wait: { kind: "use_feedback",
    reason: "Await actual owner evidence", sourceRefs: ["source:tool"] } } };
  const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [waiting], publicExplanation: "Wait for real evidence",
    sourceRefs: ["source:tool"], organizationKnowledge: [candidate] };
  const receipt = await createCentralDeliberationReceiptsAtRoot({ ...f.options, budgetId: f.request.budgetId })
    .save({ request: f.request, output }, signal);
  const returned = await runtime.recordDecision!({ request: f.request, output, role: "deliberation",
    decisionRef: f.request.operation.operationId, deliveryRef: receipt.deliveryRef }, signal);

  assert.ok(returned);
  assert.equal(returned.status, "recorded");
  assert.deepEqual(returned.materials, [], "a full valid agenda needs no additional publication material or pointer");
  const recorded = await createOrganizationPublicationResults(f.options).read(f.request.operation.operationId, f.request.budgetId, receipt.deliveryRef, signal);

  assert.ok(recorded);
  assert.equal(recorded.value.entries.length, 1);
  const bundle = await readCentralOrganizationMemory(f.options, organizationPublicationReturnReadRef(recorded.factId, 0), signal);

  assert.ok(bundle);
  assert.deepEqual(await runtime.readPublicationCorrection!({ scope, state: f.request.state, consumedSourceRefs: [] }, signal), [],
    "this fixture's unrelated prior purpose is unbound and cannot wake the current purpose");
  const conditionMaterial = bundle.find(material => readOrganizationPublicationCondition(material, scope) !== undefined)!;
  const condition = readOrganizationPublicationCondition(conditionMaterial, scope)!;

  assert.equal(condition.reason, "organization_knowledge_revision_conflict");
  assert.equal(condition.currentHeadFactId, head.factId);
  assert.equal(readOrganizationPublicationCondition({ ...conditionMaterial, text: "Opaque navigation only" }, scope), undefined);
  assert.deepEqual(createOrganizationPublicationCondition(scope, condition), conditionMaterial);
  const detail = bundle.map(material => readOrganizationPublicationRejection(material, scope)).find(value => value !== undefined)!;

  assert.equal(detail.conditionRef, conditionMaterial.ref);
  assert.equal(detail.deliveryRef, receipt.deliveryRef);
  assert.equal(detail.currentHead?.factId, head.factId);
  assert.equal(detail.candidateIndex, 0);
  assert.ok(bundle.every(material => readOrganizationCandidateView(material, scope) === undefined
    && readOrganizationKnowledgeView(material, scope) === undefined), "rebuildable proposal/head bodies are read only when needed");
  assert.ok(bundle.every(material => readOrganizationFeedbackMaterial(material, scope) === undefined));
  const after = await f.service.read();
  assert.equal(after.status, "ready");
  if (after.status !== "ready") return;

  assert.deepEqual(after.projection.knowledge, seeded.projection.knowledge, "rejection never overwrites or publishes the candidate");
  assert.equal(after.projection.decisions.length, seeded.projection.decisions.length + 1, "the valid computation decision remains committed");
  const count = f.facts().length;

  await runtime.recordDecision!({ request: f.request, output, role: "deliberation", decisionRef: f.request.operation.operationId,
    deliveryRef: receipt.deliveryRef }, signal);
  assert.equal(f.facts().length, count, "replaying the same receipt creates neither publication nor another decision");
  const original = await readCentralOrganizationMemory(f.options, detail.candidateReadRef, signal);

  assert.ok(original);
  assert.deepEqual(readOrganizationCandidateView(original[0]!, scope)?.value, candidate);
  const readOutput: CentralDeliberationOutput = { ...output, organizationKnowledge: [], intents: [{ ...waiting,
    continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:read-original-head", maximumChars: 20000,
      purpose: "Inspect the explicitly identified original head", expectedChange: "Compare the candidate with the prior version",
      sourceRefs: ["source:tool"], refs: [detail.currentHead!.readRef] } } }] };
  const decodedRead = decodeCentralDeliberation(readOutput, { ...f.request, materials: [conditionMaterial] }, []);
  const readOperation = decodedRead.intents[0]!.continuation;

  assert.equal(readOperation.kind, "ready");

  if (readOperation.kind !== "ready" || readOperation.operation.kind !== "read") return;

  const readHead = await readCentralOrganizationMemory(f.options, readOperation.operation.refs[0]!, signal, readOperation.operation.maximumChars);

  assert.ok(readHead);
  assert.equal(readOrganizationKnowledgeView(readHead[0]!, scope)?.factId, head.factId);
  const originalFeedback = createOrganizationFeedbackMaterial(scope, feedback.factId, feedback.value);
  const repairOutput = { ...output, organizationKnowledge: [{ ...candidate, supersedes: head.factId, state: "revised" as const }] };

  assert.deepEqual(decodeCentralDeliberation(repairOutput, { ...f.request, organization: [originalFeedback, ...readHead] }, []), repairOutput);
  assert.throws(() => decodeCentralDeliberation(repairOutput, { ...f.request, organization: [originalFeedback, ...original] }, []),
    /central_deliberation_organization_support_unbound/, "an original candidate does not establish a published head");
  const corrected = await f.service.proposeKnowledge({ ...candidate, supersedes: head.factId, state: "revised" }, f.revision());

  assert.equal(corrected.status, "saved", "only an explicit new candidate may cite and replace the prior head");
  const beforeCold = f.facts().length;

  await createCentralRuntimeOrganization({ ...f.options, service: createCentralOrganizationService(f.options) }).recordDecision!({
    request: f.request, output, role: "deliberation", decisionRef: f.request.operation.operationId, deliveryRef: receipt.deliveryRef }, signal);
  assert.equal(f.facts().length, beforeCold, "the same delivery reuses its first committed rejection instead of rejecting again at today's head");
  assert.deepEqual(await readCentralOrganizationMemory(f.options, organizationPublicationReturnReadRef(recorded.factId, 0), signal), bundle);
  const historical = await readCentralOrganizationMemory(f.options, detail.currentHead!.readRef, signal);

  assert.ok(historical);
  assert.deepEqual(readOrganizationKnowledgeView(historical[0]!, scope)?.value, head.value);
  const fragment = await readCentralOrganizationMemory(f.options, detail.candidateReadRef, signal, 750);

  assert.ok(fragment);
  assert.equal(readOrganizationCandidateView(fragment[0]!, scope), undefined);
  assert.equal(JSON.parse(fragment[0]!.text).role, "organization_publication_fragment_not_read_body");
  const fresh = { ...candidate, knowledgeId: "knowledge:separate", supersedes: null };

  assert.deepEqual(await f.service.proposeKnowledge(fresh, 0), { status: "stale" });
  const secretService = createCentralOrganizationService({ ...f.options, secrets: ["fixture-known-secret"] });

  assert.deepEqual(await secretService.proposeKnowledge({ ...fresh, statement: "fixture-known-secret" }, f.revision()),
    { status: "rejected", reason: "organization_sensitive_content" });
  const unknown = createCentralOrganizationService({ ...f.options, board: { read: f.options.board.read,
    async append() { throw new Error("unknown physical commit outcome"); } } });

  assert.deepEqual(await unknown.proposeKnowledge(fresh, f.revision()), { status: "rejected", reason: "organization_write_unconfirmed" });
  assert.deepEqual(await unknown.proposeKnowledge(fresh, f.revision()), { status: "rejected", reason: "organization_writer_suspended" });
  const revised = await f.service.observe({ ...feedback.value, supersedes: feedback.factId,
    result: { kind: "progress", summary: "The original source corrected its observation", remaining: [], resultRefs: [] } }, f.revision());

  assert.equal(revised.status, "saved");
  if (revised.status !== "saved") return;

  const staleSource = await f.service.proposeKnowledge(fresh, f.revision());
  assert.equal(staleSource.status, "candidate_rejected");

  if (staleSource.status === "candidate_rejected") {
    assert.equal(staleSource.reason, "organization_knowledge_source_not_current");
    assert.deepEqual(staleSource.evidenceRevisions, [{ citedFactId: feedback.factId, effectiveFactId: revised.factId }]);
  }

  const duplicate = buildOrganizationRecord(scope, { ...candidate, statement: "Invalid pre-existing duplicate head" });
  const corrupt = createCentralOrganizationService({ ...f.options, board: {
    async read() { return { revision: f.revision() + 1, facts: [...f.facts(), { ...duplicate, sequence: f.revision() + 1 }] }; },
    async append() { throw new Error("must never append after invalid original prefix"); } } });

  assert.deepEqual(await corrupt.proposeKnowledge(fresh, f.revision() + 1),
    { status: "rejected", reason: "organization_knowledge_revision_conflict" }, "the same reason in the original prefix is a hard failure");
  const large: OrganizationKnowledge = { ...fresh, knowledgeId: "knowledge:large-original", supportFactIds: [revised.factId],
    statement: "s".repeat(4096), conditions: "c".repeat(4096), exceptions: "e".repeat(4096), implication: "i".repeat(4096),
    conditionKeys: Array.from({ length: 32 }, (_, i) => `c${i}:` + "c".repeat(251)),
    exceptionKeys: Array.from({ length: 32 }, (_, i) => `e${i}:` + "e".repeat(251)) };
  const largeSaved = await f.service.proposeKnowledge(large, f.revision());
  assert.equal(largeSaved.status, "saved");

  if (largeSaved.status !== "saved") return;

  const page = await readCentralOrganizationMemory(f.options, organizationPublicationHeadReadRef(largeSaved.factId), signal, 12000);

  assert.ok(page);
  assert.ok(page.reduce((sum, material) => sum + material.text.length, 0) <= 12000);
  const locator = page.find(material => material.ref.startsWith("organization-knowledge-revision-locator:"))!;

  assert.ok(locator);
  assert.equal(readOrganizationKnowledgeView(page[0]!, scope), undefined);
  assert.deepEqual(readOrganizationKnowledgeRevisionLocator(locator, scope, page), { factId: largeSaved.factId, knowledgeId: large.knowledgeId });
  assert.equal(readOrganizationKnowledgeRevisionLocator(locator, scope, [locator]), undefined, "a locator alone never substitutes for an actual original fragment");
  const current = await f.service.read();
  assert.equal(current.status, "ready");
  if (current.status !== "ready") return;

  const actualFeedback = current.projection.feedback.find(row => row.factId === revised.factId)!;
  const largeFeedback = createOrganizationFeedbackMaterial(scope, actualFeedback.factId, actualFeedback.value);
  const pageRepair = { ...output, organizationKnowledge: [{ ...large, supersedes: largeSaved.factId, state: "revised" as const }] };

  assert.deepEqual(decodeCentralDeliberation(pageRepair, { ...f.request, organization: [largeFeedback, ...page] }, []), pageRepair);

  for (const incomplete of [[locator], [page[0]!]]) assert.throws(() => decodeCentralDeliberation(pageRepair,
    { ...f.request, organization: [largeFeedback, ...incomplete] }, []), /central_deliberation_organization_support_unbound/);

  assert.throws(() => decodeCentralDeliberation({ ...pageRepair, organizationKnowledge: [{ ...pageRepair.organizationKnowledge[0]!,
    supportFactIds: [largeSaved.factId] }] }, { ...f.request, organization: [largeFeedback, ...page] }, []),
  /central_deliberation_organization_support_unbound/, "a head locator is no independent feedback support");
  assert.throws(() => decodeCentralDeliberation({ ...pageRepair, organizationUse: { recallRef: locator.ref, changes: [] } },
    { ...f.request, organization: [largeFeedback, ...page] }, []), /central_deliberation_organization_use_unbound/);
  const nextRef = JSON.parse(page[0]!.text).nextRef;

  assert.equal(typeof nextRef, "string");
  const following = await readCentralOrganizationMemory(f.options, nextRef, signal, 12000);

  assert.ok(following);
  assert.ok(JSON.parse(following[0]!.text).start > 0, "the original head can continue through its real page address");
});
