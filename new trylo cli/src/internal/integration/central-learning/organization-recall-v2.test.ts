import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge, OrganizationRecallPacket,
  OrganizationRecallQuery } from "../../learning/central/organization/contracts.js";
import { retrieveLegacyOrganizationExperience, retrieveOrganizationExperienceV1 } from "../../learning/central/organization/retrieval-v1.js";
import type { OrganizationEvidencePage } from "../../learning/central/organization/retrieval-evidence.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralOrganizationService, type OrganizationPublication } from "./organization-service.js";
import { readCentralOrganizationMemory } from "./runtime-organization-memory.js";
import { readOrganizationEvidenceMaterial } from "./organization-evidence-material.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";

test("original writer preserves V1 uses and recalls complete V2 knowledge across exposure growth, granting new feedback citations only after actual evidence reads", async () => {
  const scope = "workspace:organization-recall-v2", signal = new AbortController().signal;
  let revision = 0;
  const facts: RewardV2Fact[] = [];
  // Replace only the original Board port. All production record construction,
  // prefix replay, publication safety, CAS and source codecs still execute.
  const board = { async read() { return { revision, facts: [...facts] }; }, async append(expected: number, draft: RewardV2Draft) {
    const old = facts.find(row => row.id === draft.id);
    if (old !== undefined) { const { sequence: _sequence, ...original } = old;
    assert.deepEqual(original, draft);
      return { status: "written" as const, revision, idempotent: true }; }
    if (expected !== revision) return { status: "stale" as const };
    revision++;
    facts.push({ ...draft, sequence: revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const options = { boardRoot: "unused-injected-original-recall-board", scope, enabled: () => true, board };
  const service = createCentralOrganizationService(options);
  const saved = async (pending: Promise<OrganizationPublication>) => {
    const result = await pending;
    assert.equal(result.status, "saved");
    if (result.status !== "saved") throw new Error("unexpected publication result");
    return result;
  };
  const ready = async () => {
    const result = await service.read();
    assert.equal(result.status, "ready");
    if (result.status !== "ready") throw new Error("unexpected original read result");
    return result;
  };
  const decision = (decisionRef: string, depth: string): OrganizationDecision => ({ kind: "decision", decisionRef,
    purposeRef: `intent:${decisionRef}`, context: { purpose: "Learn when to inspect a receiver contract before a duration handoff",
      conditionKeys: ["handoff"], known: ["Source reports are conditional, not economic validation"], residual: ["The receiver may forbid a unit field"] },
    program: { programRef: `program:${decisionRef}`, depth, timing: "now" },
    expectation: { change: "Choose research depth from exact source observations", uncertainties: ["Causal benefit remains unknown"] },
    alternatives: ["Wait for an exact receiver contract"], issueRefs: ["issue:receiver"], stageRefs: [],
    sourceRefs: ["source:receiver"], experienceUse: null });
  const owner = decision("decision:producer", "Compare the receiver's actual value and unit contract");

  await saved(service.freezeDecision(owner, revision));
  const observe = (unitRef: string, result: OrganizationFeedback["result"], sourceRef: string) => saved(service.observe({
    kind: "feedback", decisionRef: owner.decisionRef, unitRef, supersedes: null, sourceRefs: [sourceRef], result }, revision));
  const support: string[] = [];

  for (let index = 0; index < 5; index++) support.push((await observe(`unit:progress:${index}`, { kind: "progress",
    summary: `Original research observation ${index}: inspect the receiver contract before committing further learning budget`,
    remaining: ["No business benefit is identified"], resultRefs: [`source:research:${index}`] }, `source:research:${index}`)).factId);

  const exposure = "exposure:original", artifact = "artifact:duration-trial";
  const adoption = await observe("unit:adoption:original", { kind: "adoption", state: "used", artifactRefs: [artifact], exposureRef: exposure }, "receipt:original-use");
  const negative = await observe("unit:outcome:negative", { kind: "outcome", state: "observed", exposureRef: exposure,
    attribution: "unknown", summary: "Original source reports not_helped: a numeric-only receiver contradicted the value/unit handoff assumption" }, "receipt:negative");
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:receiver-contract", supersedes: null,
    statement: "Inspect the receiver contract before increasing depth in duration handoff research",
    conditions: "The original source exposes a receiver whose accepted representation is not established", conditionKeys: ["handoff"],
    exceptions: "A numeric-only receiver may reject the unit field; exposure alone never establishes validation", exceptionKeys: ["receiver_numeric_only"],
    implication: "Prefer a bounded exact contract inspection before deeper delegation", supportFactIds: support,
    counterexampleFactIds: [negative.factId], state: "proposed" };
  const initialKnowledge = await saved(service.reviseKnowledge(knowledge, revision));
  const query: OrganizationRecallQuery = { purpose: "Inspect the receiver contract before another duration handoff",
    conditionKeys: ["handoff"], sourceRefs: ["source:research:0"], maximumEntries: 8, maximumCharacters: 24000 };
  const freezeUse = async (id: string, depth: string, packet: OrganizationRecallPacket, before: string) => {
    const value: OrganizationDecision = { ...decision(id, depth), experienceUse: { packet,
      // Trusted local domain delivery coordinate, not a provider receipt or run.
      deliveryRef: `delivery:trusted-local:${id}`, changes: [{ knowledgeFactId: packet.entries[0]!.factId,
        choice: "program", before, after: depth, reason: "Used the supplied conditional hypothesis and retained its original negative observation" }] } };
    await saved(service.freezeDecision(value, revision));
    return value;
  };
  const legacy = retrieveLegacyOrganizationExperience((await ready()).projection, query);

  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.navigation, undefined);
  assert.equal(legacy.entries.length, 1);
  const legacyUse = await freezeUse("decision:legacy-no-navigation", "Legacy bounded inspection", legacy, "Unbounded investigation");
  const purposeV1 = retrieveOrganizationExperienceV1((await ready()).projection, query);

  assert.equal(purposeV1.schemaVersion, 1);
  assert.ok(purposeV1.navigation);
  assert.equal(purposeV1.entries.length, 1);
  const purposeUse = await freezeUse("decision:legacy-purpose", "Legacy purpose-directed inspection", purposeV1, "Unbounded investigation");

  for (let index = 0; index < 70; index++) await observe(`unit:mechanical-adoption:${index}`, { kind: "adoption", state: "used",
    artifactRefs: [artifact], exposureRef: `exposure:mechanical:${index}` }, `receipt:mechanical:${index}`);

  // This independent original unit shares an exposure but does not revise or
  // replace the registered negative counterexample, and claims no validation.
  const uncertain = await observe("unit:outcome:uncertain", { kind: "outcome", state: "unknown", exposureRef: exposure,
    attribution: "unknown", summary: "A separate same-exposure source report remains uncertain; retain the original contradicted report" }, "receipt:uncertain");
  const grown = await ready();

  assert.equal(retrieveOrganizationExperienceV1(grown.projection, query).entries.length, 0,
    "the frozen V1 policy demonstrates the original greater-than-64 evidence exclusion");
  const recalled = await service.prepareRecall(query, signal);
  assert.equal(recalled.status, "ready");

  if (recalled.status !== "ready") throw new Error("V2 recall unavailable");

  const packet = recalled.packet, entry = packet.entries.find(row => row.factId === initialKnowledge.factId)!;

  assert.equal(packet.schemaVersion, 2);
  assert.ok(entry);
  assert.deepEqual(entry.knowledge, knowledge);
  assert.ok(packet.materialJson.length <= 24000);
  assert.ok(entry.evidence.length <= 64);
  assert.deepEqual(entry.knowledge.supportFactIds, support);
  assert.deepEqual(entry.knowledge.counterexampleFactIds, [negative.factId]);

  for (const factId of [...support, negative.factId]) assert.ok(entry.evidence.some(row => row.factId === factId));

  assert.ok(!entry.evidence.some(row => row.factId === uncertain.factId));
  const coverage = entry.evidenceCoverage!;
  assert.ok(coverage);
  const originalUnits = grown.projection.feedback.filter(row => row.value.decisionRef === owner.decisionRef);

  assert.equal(coverage.total, originalUnits.length);
  assert.equal(coverage.delivered, entry.evidence.length);
  assert.equal(coverage.total, coverage.delivered + coverage.unread);
  assert.ok(coverage.unread > 64);
  assert.equal(coverage.citedSupportCount, 5);
  assert.equal(coverage.citedCounterexampleCount, 1);
  assert.equal(coverage.relatedCount, coverage.total - 6);
  assert.ok(coverage.unreadByKind.outcome >= 1);
  assert.equal(Object.values(coverage.unreadByKind).reduce((sum, count) => sum + count, 0), coverage.unread);
  assert.ok(coverage.priorityReadRef, "the unread unknown outcome has a source-index priority address");

  const materialsFor = (actual: OrganizationRecallPacket): CentralRuntimeMaterial[] => {
    const text = canonicalJson({ role: "organization_retrieval_context_not_business_evidence", query: actual.query, recallRef: actual.recallRef });
    return [{ ref: actual.recallRef, kind: "organization", text: actual.materialJson, sourceRefs: [actual.recallRef, ...actual.entries.map(row => row.factId)] },
      { ref: `organization-query:${contentHashOf(text)}`, kind: "organization", text, sourceRefs: [] }];
  };
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 131072 };
  const request = (organization: readonly CentralRuntimeMaterial[], label: string): CentralDeliberationRequest => ({
    schemaVersion: 1, scope, budgetId: "budget:local-recall", configuration: { schemaVersion: 1,
      configurationRef: "configuration:local", authorizationRef: "authorization:local", allowance }, boardSequence: revision,
    resources: { boardSequence: revision, budgetId: "budget:local-recall", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: `state:local:${label}`, state: { schemaVersion: 1, scope, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [], materials: [], organization, operation: { kind: "think", operationId: `operation:local:${label}`,
      purpose: "Choose the next bounded learning means", expectedChange: "Retain the exact negative evidence and inspect unknowns", sourceRefs: [packet.recallRef] } });
  const proposed: OrganizationKnowledge = { ...knowledge, supersedes: initialKnowledge.factId, state: "revised",
    implication: "Inspect the uncertain receiver report before deeper delegation; benefit remains unknown" };
  const output = (candidate: OrganizationKnowledge) => ({ schemaVersion: 1, intents: [], publicExplanation: "A source-bound organizing revision, not a business-quality verdict",
    sourceRefs: [packet.recallRef], organizationKnowledge: [candidate], organizationUse: { recallRef: packet.recallRef,
      changes: [{ knowledgeFactId: entry.factId, choice: "program", before: "Deep delegation", after: "Exact receiver inspection", reason: "Retain the original counterexample" }] } });
  const visible = materialsFor(packet);

  assert.equal(decodeCentralDeliberation(output(proposed), request(visible, "full-packet"), []).organizationKnowledge?.[0]?.supersedes, initialKnowledge.factId);
  const withUnreadSupport = { ...proposed, supportFactIds: [...support, uncertain.factId] };
  const directoryText = canonicalJson({ role: "organization_evidence_directory_not_read_body", readRef: coverage.readRef,
    factIds: [uncertain.factId], evidenceCoverage: coverage });
  const directory: CentralRuntimeMaterial = { ref: `directory:${contentHashOf(directoryText)}`, kind: "organization", text: directoryText, sourceRefs: [uncertain.factId] };

  for (const organization of [visible, [...visible, directory]]) {
    assert.throws(() => decodeCentralDeliberation(output(withUnreadSupport), request(organization, "unread-support"), []), /organization_support_unbound/);
    assert.throws(() => decodeCentralDeliberation(output({ ...proposed, counterexampleFactIds: [negative.factId, uncertain.factId] }),
      request(organization, "unread-counter"), []), /organization_support_unbound/);
  }

  if (coverage.priorityReadRef === null) throw new Error("missing unread outcome priority address");

  const waitingRead: CentralLearningIntentDraft = { intentId: "intent:priority-evidence", subject: { plane: "central", questionRef: "intent:priority-evidence" },
    goal: "Inspect the original unread receiver outcome", rationale: "The delivered coverage identifies an unread outcome rather than a validated gain",
    conditions: ["The receiver outcome remains unknown"], knowledge: [], residual: ["Read its original source body"],
    commitment: { purpose: "Choose the next bounded evidence read", assumptions: ["A registered address is not a delivered body"], reconsiderWhen: ["The actual evidence page arrives"] },
    revisionReason: "Retain the existing evidence inspection purpose", sourceRefs: [packet.recallRef],
    continuation: { kind: "waiting", wait: { kind: "facts", reason: "Await an exact unread evidence address", sourceRefs: [packet.recallRef] } } };
  const selectedRead: CentralLearningIntentDraft = { ...waitingRead, revisionReason: "The actual coverage supplies the priority evidence address",
    continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:priority-evidence-read",
      purpose: "Read the original unknown outcome before changing the research program", expectedChange: "Replace an unread reference with an actual source body",
      sourceRefs: [packet.recallRef], refs: [coverage.priorityReadRef], maximumChars: 24000 } } };
  const priorityRequest = request(visible, "priority-selection");

  assert.deepEqual(decodeCentralDeliberation({ ...output(proposed), intents: [selectedRead] },
    { ...priorityRequest, state: { ...priorityRequest.state, intents: [waitingRead] } }, []).intents[0]?.continuation, selectedRead.continuation,
  "the actual decoder accepts a ready/read operation using the advertised priorityReadRef");
  const priorityMaterials = await readCentralOrganizationMemory(options, coverage.priorityReadRef, signal, 24000);

  assert.ok(priorityMaterials);
  const priorityPages = (priorityMaterials ?? []).map(material => readOrganizationEvidenceMaterial(material, scope));

  assert.equal(priorityPages.length, 1);
  assert.ok(priorityPages[0]);
  assert.ok(priorityPages[0]?.items.some(row => row.factId === uncertain.factId && row.value.result.kind === "outcome"
    && row.value.result.state === "unknown"), "the first actual priority page contains the unread original unknown outcome");
  assert.ok(decodeCentralDeliberation(output(withUnreadSupport), request([...visible, ...(priorityMaterials ?? [])], "priority-body"), [])
    .organizationKnowledge?.[0]?.supportFactIds.includes(uncertain.factId));

  const pages: OrganizationEvidencePage[] = [], pageMaterials: CentralRuntimeMaterial[] = [], visited = new Set<string>();
  let next: string | null = coverage.readRef;

  while (next !== null) {
    assert.ok(!visited.has(next));
    visited.add(next);
    const actual = await readCentralOrganizationMemory(options, next, signal, 24000);
    assert.ok(actual);
    let following: string | null = null;

    for (const material of actual ?? []) {
      const page = readOrganizationEvidenceMaterial(material, scope);
      assert.ok(page);
      if (page === undefined) throw new Error("actual reader returned no strict evidence page");
      assert.ok(material.text.length <= 24000);
      assert.ok(page.items.length <= 64);
      assert.equal(page.asOfSequence, coverage.asOfSequence);
      pages.push(page);
      pageMaterials.push(material);
      following = page.nextReadRef;
    }

    next = following;
  }

  assert.ok(pages.length >= 2);
  const readItems = pages.flatMap(page => page.items);

  assert.equal(new Set(readItems.map(row => row.factId)).size, coverage.total);
  const originalCounter = readItems.find(row => row.factId === negative.factId)!;

  assert.ok(originalCounter.roles.includes("registered_counterexample"));
  assert.deepEqual(originalCounter.citedFactIds, [negative.factId]);
  assert.equal(originalCounter.value.unitRef, "unit:outcome:negative");
  assert.deepEqual(originalCounter.value.result,
    { kind: "outcome", state: "observed", exposureRef: exposure, attribution: "unknown",
      summary: "Original source reports not_helped: a numeric-only receiver contradicted the value/unit handoff assumption" });
  const readUncertain = readItems.find(row => row.factId === uncertain.factId)!;

  assert.ok(readUncertain.roles.includes("same_decision_related_not_causal"));
  assert.ok(!readUncertain.roles.includes("registered_counterexample"));
  assert.equal(readUncertain.value.unitRef, "unit:outcome:uncertain");
  const readAdoption = readItems.find(row => row.factId === adoption.factId)!;

  assert.ok(readAdoption.roles.includes("exact_exposure_context"));
  assert.ok(!readAdoption.roles.includes("registered_support"));
  const decoded = decodeCentralDeliberation(output(withUnreadSupport), request([...visible, ...pageMaterials], "read-evidence"), []);

  assert.ok(decoded.organizationKnowledge?.[0]?.supportFactIds.includes(uncertain.factId));
  assert.deepEqual(decoded.organizationKnowledge?.[0]?.counterexampleFactIds, [negative.factId]);
  const firstUse = await freezeUse("decision:v2-exact-inspection", "Inspect the exact receiver contract before further delegation", packet, "Deep delegation");
  const revised = await saved(service.reviseKnowledge(decoded.organizationKnowledge![0]!, revision));
  const secondQuery = { ...query, purpose: "Choose a shallower learning investment while receiver applicability remains uncertain", sourceRefs: ["receipt:negative"] };
  const second = await service.prepareRecall(secondQuery, signal);
  assert.equal(second.status, "ready");

  if (second.status !== "ready") throw new Error("second V2 query unavailable");

  assert.equal(second.packet.entries[0]?.factId, revised.factId);
  const secondUse = await freezeUse("decision:v2-budget-depth", "Defer deep delegation until the exact receiver uncertainty is resolved", second.packet, firstUse.program.depth);

  assert.notEqual(firstUse.program.programRef, secondUse.program.programRef);
  assert.notEqual(firstUse.program.depth, secondUse.program.depth);

  const cold = await createCentralOrganizationService(options).read();
  assert.equal(cold.status, "ready");

  if (cold.status !== "ready") throw new Error("cold original prefix replay failed");

  for (const original of [legacyUse, purposeUse, firstUse, secondUse]) {
    assert.deepEqual(cold.projection.decisions.find(row => row.value.decisionRef === original.decisionRef)?.value, original);
  }

  assert.equal(cold.projection.feedback.find(row => row.factId === negative.factId)?.value.unitRef, "unit:outcome:negative");
  assert.equal(cold.projection.knowledge.find(row => row.factId === revised.factId)?.value.counterexampleFactIds[0], negative.factId);
});
