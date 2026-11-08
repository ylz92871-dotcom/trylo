import assert from "node:assert/strict";
import test from "node:test";
import type { OrganizationDecision, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isContentDataSafe } from "../learning-content/content-confidentiality.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { createCentralOrganizationService, isOrganizationRecordContentSafe, type OrganizationPublication } from "./organization-service.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { deliveredOrganizationRecallPacket } from "./runtime-organization-memory.js";
import { buildCentralOrganizationRecallQuery } from "./runtime-organization-query.js";

test("actual recall projects complete source text before excerpting and freezes safe experience use without weakening original publication guards", async () => {
  const scope = "C:\\PrivateWorkspace\\Case", outsidePath = "D:\\UnrelatedWorkspace\\private-receiver.txt";
  const knownSecret = `fixture-private-value-${"q7R2".repeat(28)}`, secrets = [knownSecret];
  const signal = new AbortController().signal, sourceRef = "source:receiver-contract";
  let revision = 0;
  const facts: RewardV2Fact[] = [];
  // Only the original Board port is injected: replay, safety, publication and
  // runtime decision construction all use the production implementations.
  const board = { async read() { return { revision, facts: [...facts] }; }, async append(expected: number, draft: RewardV2Draft) {
    const previous = facts.find(row => row.id === draft.id);
    if (previous !== undefined) { const { sequence: _sequence, ...original } = previous;
    assert.deepEqual(original, draft);
      return { status: "written" as const, revision, idempotent: true }; }
    if (expected !== revision) return { status: "stale" as const };
    revision++;
    facts.push({ ...draft, sequence: revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const options = { boardRoot: "unused-injected-organization-query-board", scope, secrets, enabled: () => true, board };
  const service = createCentralOrganizationService(options), runtime = createCentralRuntimeOrganization({ ...options, service });
  const saved = async (pending: Promise<OrganizationPublication>) => {
    const result = await pending;
    if (result.status !== "saved") throw new Error("original publication was not saved");
    return result;
  };
  const prior: OrganizationDecision = { kind: "decision", decisionRef: "decision:receiver-prior", purposeRef: "intent:receiver-prior",
    context: { purpose: "Choose when to inspect the receiver contract", conditionKeys: ["plane:central"], known: [], residual: [] },
    program: { programRef: "program:receiver-prior", depth: "Delegate before inspecting the receiver contract", timing: "now" },
    expectation: { change: "Find a conditional learning procedure", uncertainties: ["Receiver applicability is unknown"] },
    alternatives: ["Inspect the receiver contract first"], issueRefs: [], stageRefs: [], sourceRefs: [sourceRef], experienceUse: null };

  await saved(service.freezeDecision(prior, revision));
  const observation = await saved(service.observe({ kind: "feedback", decisionRef: prior.decisionRef,
    unitRef: "unit:receiver-contract", supersedes: null, sourceRefs: [sourceRef], result: { kind: "progress",
      summary: "The original receiver contract is a prerequisite for selecting research depth", remaining: ["Business benefit remains unknown"],
      resultRefs: [sourceRef] } }, revision));
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:receiver-contract", supersedes: null,
    statement: "Inspect the actual receiver contract before investing in a duration handoff procedure",
    conditions: "The receiver representation is not yet established", conditionKeys: ["plane:central"],
    exceptions: "An already verified receiver needs no repeated inspection", exceptionKeys: ["receiver:verified"],
    implication: "Choose a bounded original contract read before deeper delegation", supportFactIds: [observation.factId],
    counterexampleFactIds: [], state: "proposed" };
  const published = await saved(service.reviseKnowledge(knowledge, revision));

  const businessText = `Receiver contract accepts numeric duration only. Inspect ${scope}\\contracts\\receiver.json before adding a unit field.`;
  const page = { ref: sourceRef, originalRef: sourceRef, originalScope: scope, owner: "board" as const,
    origin: "model_proposal" as const, coordinate: { runId: "run:receiver-contract", sequence: 7 },
    sourceHash: contentHashOf(businessText), start: 0, end: businessText.length, totalChars: businessText.length, text: businessText };
  const originalPage = centralMaterialFromPage(page);
  // The complete known secret crosses the old 900-character excerpt boundary.
  // Full projection removes it before excerpting and brings the following real
  // semantic marker into the delivered excerpt; truncating first cannot do that.
  const boundaryText = `Receiver contract outside report ${outsidePath}. `.padEnd(850, "x")
    + knownSecret + " POST_SECRET_RECEIVER_CONTRACT numeric-only condition remains unknown.";

  assert.ok(boundaryText.indexOf("POST_SECRET_RECEIVER_CONTRACT") > 900);
  const boundaryMaterial: CentralRuntimeMaterial = { ref: "source:receiver-private-report", kind: "source",
    sourceRefs: ["receipt:receiver-private-report"], text: boundaryText };
  const materials = [originalPage, boundaryMaterial], originalBytes = canonicalJson(materials), originalHash = contentHashOf(materials);
  const active: CentralLearningIntentDraft = { intentId: "intent:receiver", subject: { plane: "central", questionRef: "intent:receiver" },
    goal: `Learn when receiver contract inspection helps at ${scope}\\contracts\\receiver.json; private report ${outsidePath}; ${knownSecret}`,
    rationale: "The exact receiver contract controls applicability", conditions: ["Receiver representation is unknown"], knowledge: [],
    residual: ["Inspect the numeric-only receiver"], commitment: { purpose: "Choose a bounded contract inspection",
      assumptions: ["Source reports are conditional"], reconsiderWhen: ["The original receiver contract arrives"] },
    revisionReason: "Original open purpose", sourceRefs: [sourceRef], continuation: { kind: "waiting",
      wait: { kind: "facts", sourceRefs: [sourceRef], reason: "Await an original receiver contract" } } };
  const state = { schemaVersion: 1 as const, scope, intents: [active], completed: [], running: [], materials: [], consumedSourceRefs: [] };
  const opportunities = [{ subject: active.subject, sourceRef: "opportunity:receiver-contract",
    description: `Inspect receiver contract evidence from ${outsidePath} with private value ${knownSecret}`, constraints: [] }];
  const input = { scope, state, opportunities, materials, signal };
  const query = buildCentralOrganizationRecallQuery(input, options);

  for (const raw of [scope, JSON.stringify(scope).slice(1, -1), outsidePath, JSON.stringify(outsidePath).slice(1, -1), knownSecret,
    knownSecret.slice(0, 48)]) assert.ok(!query.purpose.includes(raw));

  assert.ok(query.purpose.includes("<workspace>"));
  assert.ok(query.purpose.includes("receiver contract"));
  assert.ok(query.purpose.includes("POST_SECRET_RECEIVER_CONTRACT"));

  for (const ref of [originalPage.ref, sourceRef, boundaryMaterial.ref, "receipt:receiver-private-report", "opportunity:receiver-contract"]) {
    assert.ok(query.sourceRefs.includes(ref));
  }

  assert.equal(isContentDataSafe(query, options, secrets), true);

  // This synthetic already-built raw packet represents the prior unsafe query.
  // Neither runtime recall nor publication may silently rewrite its bytes/ref.
  const historical = await service.prepareRecall({ ...query, purpose: [active.goal, opportunities[0]!.description,
    originalPage.text, boundaryText].join("\n") }, signal);
  if (historical.status !== "ready") throw new Error("original raw packet unavailable");

  const historicalBytes = canonicalJson(historical.packet), historicalRef = historical.packet.recallRef;
  const organization = await runtime.recall(input);
  const queryMaterial = organization.find(material => material.ref.startsWith("organization-query:"))!;
  const actualQuery = JSON.parse(queryMaterial.text) as { query: typeof query };

  assert.deepEqual(actualQuery.query, query);
  const recallMaterial = organization.find(material => material.ref.startsWith("organization-recall:"))!;
  const packet = deliveredOrganizationRecallPacket(recallMaterial, scope, organization);

  assert.ok(packet);

  if (packet === undefined) throw new Error("actual delivered packet unavailable");

  assert.equal(packet.schemaVersion, 2);
  assert.equal(packet.scope, scope);
  assert.deepEqual(packet.query, query);
  assert.notEqual(packet.recallRef, historicalRef);
  assert.deepEqual(packet.entries[0]!.knowledge, knowledge);
  assert.equal(packet.entries[0]!.factId, published.factId);
  assert.ok(packet.materialJson.length <= 24000);
  assert.deepEqual(packet.entries[0]!.knowledge.supportFactIds, [observation.factId]);
  assert.ok(packet.entries[0]!.evidence.some(row => row.factId === observation.factId));
  assert.equal(canonicalJson(historical.packet), historicalBytes);
  assert.equal(canonicalJson(materials), originalBytes);
  assert.equal(contentHashOf(materials), originalHash);
  assert.equal(JSON.parse(originalPage.text).originalScope, scope);
  assert.equal(page.sourceHash, contentHashOf(businessText));

  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 131072 };
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: "budget:query-privacy",
    configuration: { schemaVersion: 1, configurationRef: "configuration:query-privacy", authorizationRef: "authorization:query-privacy", allowance },
    boardSequence: revision, resources: { boardSequence: revision, budgetId: "budget:query-privacy",
      limits: { tokens: 100000, calls: 16, steps: 16 }, occupied: { tokens: 0, calls: 0, steps: 0 },
      available: { tokens: 100000, calls: 16, steps: 16 }, status: "available", holdReason: null },
    stateRef: "state:query-privacy", state, opportunities, materials, organization,
    operation: { kind: "think", operationId: "operation:query-privacy-think", purpose: "Choose a bounded receiver contract inspection",
      expectedChange: "Narrow the learning program to the original receiver conditions", sourceRefs: [sourceRef] } };
  const selected: CentralLearningIntentDraft = { ...active, goal: "Learn when actual receiver contract inspection should precede deeper delegation",
    revisionReason: "The delivered conditional organization hypothesis favors an exact receiver read", continuation: { kind: "ready",
      operation: { kind: "read", operationId: "operation:query-privacy-read", purpose: "Inspect the numeric-only receiver contract",
        expectedChange: "Resolve the receiver condition before another research investment", sourceRefs: [sourceRef], refs: [sourceRef], maximumChars: 6000 } } };
  const proposed: CentralDeliberationOutput = { schemaVersion: 1, intents: [selected], publicExplanation: "Inspect the original receiver contract first",
    sourceRefs: [sourceRef, packet.recallRef], alternatives: ["Delegate before verifying the receiver condition"],
    organizationUse: { recallRef: packet.recallRef, changes: [{ knowledgeFactId: published.factId, choice: "program",
      before: "Delegate before contract inspection", after: "Read the exact receiver contract first",
      reason: "The supplied hypothesis applies while the receiver representation remains unknown" }] } };
  const output = decodeCentralDeliberation(proposed, request, secrets);

  assert.deepEqual(output.organizationUse, proposed.organizationUse);
  // A trusted local domain delivery coordinate exercises the real freeze/use
  // seam. This fixture makes no provider, HTTP, driver or journey claim.
  const deliveryRef = "delivery:trusted-local:query-privacy";

  await runtime.recordDecision!({ request, output, decisionRef: request.operation.operationId, role: "deliberation", deliveryRef }, signal);
  await runtime.recordDecision!({ request, output, decisionRef: "operation:query-privacy-read", role: "operation_expectation", deliveryRef }, signal);
  const loaded = await createCentralOrganizationService(options).read();
  if (loaded.status !== "ready") throw new Error("original frozen prefix unavailable");

  const frozen = loaded.projection.decisions.filter(row => row.value.experienceUse?.deliveryRef === deliveryRef);

  assert.equal(frozen.length, 2);

  for (const row of frozen) {
    assert.equal(isOrganizationRecordContentSafe(row.value, options, secrets), true);
    assert.deepEqual(row.value.experienceUse!.packet, packet);
    assert.deepEqual(row.value.experienceUse!.changes, proposed.organizationUse!.changes);
  }

  const beforeRejected = facts.length, base = frozen.find(row => row.value.decisionRef === "operation:query-privacy-read")!.value;
  const oldUse: OrganizationDecision = { ...base, decisionRef: "decision:old-raw-query", experienceUse: {
    ...base.experienceUse!, packet: historical.packet } };

  assert.equal(isOrganizationRecordContentSafe(oldUse, options, secrets), false);
  assert.deepEqual(await service.freezeDecision(oldUse, revision), { status: "rejected", reason: "organization_sensitive_content" });
  assert.equal(canonicalJson(historical.packet), historicalBytes);
  assert.equal(historical.packet.recallRef, historicalRef);
  assert.throws(() => decodeCentralDeliberation({ ...proposed, publicExplanation: knownSecret }, request, secrets), /central_deliberation_sensitive_output/);
  const sensitiveOperation = { ...request.operation, operationId: "operation:sensitive-new-output" };

  await assert.rejects(runtime.recordDecision!({ request: { ...request, operation: sensitiveOperation },
    output: { ...output, publicExplanation: outsidePath }, decisionRef: sensitiveOperation.operationId, role: "deliberation", deliveryRef }, signal),
  /organization_sensitive_content/);
  assert.deepEqual(await service.reviseKnowledge({ ...knowledge, knowledgeId: "knowledge:sensitive-new-output",
    statement: `Sensitive original content ${outsidePath} ${knownSecret}` }, revision), { status: "rejected", reason: "organization_sensitive_content" });
  assert.deepEqual(await service.freezeDecision({ ...prior, decisionRef: "decision:sensitive-source-ref", sourceRefs: [outsidePath] }, revision),
    { status: "rejected", reason: "organization_sensitive_content" });
  assert.equal(facts.length, beforeRejected);
  assert.equal(canonicalJson(materials), originalBytes);
  assert.equal(contentHashOf(materials), originalHash);
});
