import assert from "node:assert/strict";
import test from "node:test";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralLearningOperation, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { createCentralJudgmentMaterial, readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { recordOperationResult, validateAgendaTransition } from "../../learning/central/runtime/transitions.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { createCentralChangeView } from "./change-input.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { createCentralJudgmentProvenanceReader } from "./runtime-judgment-provenance.js";
import { centralJudgmentResultMaterial } from "./runtime-judgment.js";

const scope = "workspace:judgment-control";
const thought = (operationId: string): Extract<CentralLearningOperation, { kind: "think" }> => ({
  kind: "think", operationId, purpose: "Reassess the original question", expectedChange: "Choose a useful next commitment",
  sourceRefs: ["source:business"] });
const originalJudgment: CentralRuntimeMaterial = { ref: `central-deliberation-result:${contentHashOf("public decision")}`,
  kind: "knowledge", text: "No independently qualified use has been observed.", sourceRefs: ["source:business"] };

function judgmentView(original = originalJudgment) {
  return centralJudgmentResultMaterial({ scope, operationId: "think:original", resultRef: original.ref, original });
}

function request(materials: readonly CentralRuntimeMaterial[], intents: readonly CentralLearningIntentDraft[] = []): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:judgment-control", boardSequence: 0, stateRef: initialCentralRuntimeRef(scope),
    configuration: { schemaVersion: 1, configurationRef: "configuration:judgment-control", authorizationRef: "authorization:judgment-control",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: 0, budgetId: "budget:judgment-control", limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { ...emptyCentralRuntimeState(scope), intents }, materials, organization: [], opportunities: [], operation: thought("think:current") };
}

function purpose(intentId: string): CentralLearningIntentDraft {
  return { intentId, subject: { plane: "central", questionRef: intentId }, goal: "Distinguish a judgment from an actual use observation",
    rationale: "Preserve the original unresolved question", conditions: [], knowledge: [], residual: ["An actual use remains unobserved"],
    commitment: { purpose: "Keep the original condition explicit", assumptions: [], reconsiderWhen: ["A qualified original use arrives"] },
    revisionReason: "Retain the original conditional question", sourceRefs: [originalJudgment.ref], continuation: { kind: "open" },
    derivation: { relation: "A prior judgment left this question open", whenRelevant: "When independent use is absent",
      parentRefs: [originalJudgment.ref], citations: [{ evidenceRef: originalJudgment.ref, quote: originalJudgment.text }] } };
}

const output = (intents: readonly CentralLearningIntentDraft[]): CentralDeliberationOutput => ({
  schemaVersion: 1, intents, publicExplanation: "Retain the original distinction", sourceRefs: [] });

test("bounded judgment controls preserve original bytes and permit lineage while refusing new business grounding", () => {
  const sourceRefs = Array.from({ length: 256 }, (_, index) => `source:${index}:${"s".repeat(200)}`);
  const aliases = Array.from({ length: 256 }, (_, index) => `alias:${index}:${"a".repeat(200)}`);
  const large: CentralRuntimeMaterial = { ...originalJudgment, text: "x".repeat(32768), sourceRefs };
  const originalBytes = canonicalJson(large), originalHash = contentHashOf(large);
  const compact = createCentralJudgmentMaterial({ scope, operationId: "think:capacity", resultRef: large.ref,
    originalRef: large.ref, originalHash, text: large.text, sourceRefs, aliases });
  const body = readCentralJudgmentMaterial(compact);
  assert.ok(body);
  assert.ok(compact.text.length <= 32768);
  assert.equal(body.originalHash, originalHash);
  assert.equal(body.originalChars, large.text.length);
  assert.ok(body.omittedChars > 0);
  assert.equal(body.text.length + body.omittedChars, large.text.length);
  assert.equal(body.sourceRefs.length + body.sourceRefsOmitted, 256);
  assert.equal(body.aliases.length + body.aliasesOmitted, new Set([large.ref, ...aliases]).size);
  assert.ok(body.sourceRefsOmitted > 0);
  assert.ok(body.aliasesOmitted > 0);
  assert.equal(canonicalJson(large), originalBytes);
  assert.equal(contentHashOf(large), originalHash);

  const view = judgmentView(), materials = [originalJudgment, view], retained = purpose("intent:retained");
  const original = request(materials, [retained]), input = createCentralChangeView(original);

  for (const material of materials) {
    assert.equal(input.exposure.find(row => row.ref === material.ref)?.kind, "control");
    assert.equal(input.dictionary.entries.some(row => row.ref === material.ref && (row.kind === "source" || row.kind === "span")), false);
    const entry = input.dictionary.entries.find(row => row.ref === material.ref && row.kind === "reference");
    assert.ok(entry);
    assert.match(entry.handle, /^e/);
    assert.equal(input.dictionary.citation(entry.handle, material.text), undefined);
    assert.equal(input.dictionary.knowledge(entry.handle), undefined);
    assert.equal(input.dictionary.feedback(entry.handle), undefined);
    assert.equal(input.dictionary.source(entry.handle), material.ref, "a prior judgment remains a legitimate reasoning dependency");
  }

  assert.equal(validateAgendaTransition(original, output([retained])), null, "an already accepted derivation is retained verbatim");
  const withOldKnowledge = { ...retained, knowledge: [{ statement: "A prior conditional judgment", conditions: "Original scope", sourceRefs: [originalJudgment.ref] }] };

  assert.equal(validateAgendaTransition(request(materials, [withOldKnowledge]), output([withOldKnowledge])), null);
  const continued = { ...retained, continuation: { kind: "ready" as const, operation: { ...thought("think:lineage"), sourceRefs: [originalJudgment.ref] } } };

  assert.equal(validateAgendaTransition(original, output([continued])), null, "continuing inference does not require pretending that its premise is new business evidence");
  assert.equal(validateAgendaTransition(original, output([retained, purpose("intent:new-grounding")])), "central_judgment_context_not_business_grounding");
  assert.equal(validateAgendaTransition(original, output([{ ...retained, knowledge: [{ statement: "A new business claim", conditions: "Unverified", sourceRefs: [originalJudgment.ref] }] }])),
    "central_judgment_context_not_business_grounding");
});

test("original thought progress and explicit read wrappers retain judgment provenance without relabeling domain results", () => {
  const facts: RewardV2Fact[] = [];
  let state = emptyCentralRuntimeState(scope), previousRef = initialCentralRuntimeRef(scope);
  const persist = (reason: string) => {
    const fact = { ...buildCentralRuntimeRecord({ previousRef, state, reason, sourceRefs: [] }), sequence: facts.length + 1 };
    facts.push(fact);
    previousRef = fact.id;
    return fact.id;
  };
  const late = recordOperationResult(state, { intentId: "central:agenda", operation: thought("think:late"),
    result: { outcome: "returned", publicResult: "The original thought returned a public decision.", resultRefs: ["delivery:late"] } });

  state = late.state;
  const lateFactRef = persist("central_late_semantic_response_recovered_not_overwriting_new_agenda");
  const lateMaterial = state.materials.find(row => row.ref === late.resultRef);
  assert.ok(lateMaterial);
  const unknown: CentralCompletedOperation = { intentId: "central:agenda", operation: thought("think:pending"), outcome: "unknown",
    publicResult: "The request outcome remains unconfirmed.", resultRefs: [] };

  state = { ...state, completed: [...state.completed, unknown] };
  const unknownFactRef = persist("central_deliberation_issued");
  const failed: CentralCompletedOperation = { ...unknown, outcome: "failed", publicResult: "The original compiler refused the returned action." };

  state = { ...state, completed: state.completed.map(row => row.operation.operationId === unknown.operation.operationId ? failed : row) };
  const failedFactRef = persist("central_semantic_recovery_requires_actual_condition");
  const read: CentralLearningOperation = { kind: "read", operationId: "read:ordinary", purpose: "Read the original contract",
    expectedChange: "Expose its exact condition", sourceRefs: ["source:business"], refs: ["source:business"], maximumChars: 1000 };
  const dispatch: CentralLearningOperation = { kind: "dispatch", operationId: "dispatch:ordinary", purpose: "Run the original research",
    expectedChange: "Return domain evidence", sourceRefs: ["source:business"],
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } };

  for (const operation of [read, dispatch]) state = recordOperationResult(state, { intentId: "central:agenda", operation,
    result: { outcome: "returned", publicResult: `Actual ${operation.kind} result.`, resultRefs: [`result:${operation.operationId}`] } }).state;

  const domainFactRef = persist("central_domain_work_returned");
  const archive = (factRef: string, value: CentralCompletedOperation): CentralRuntimeMaterial => ({
    ref: `central-runtime-archived:${contentHashOf([factRef, value])}`, kind: "work_result",
    text: canonicalJson({ role: "exact_original_runtime_archive_not_new_evidence", factRef, value }), sourceRefs: [factRef, value.operation.operationId] });
  const fragment = (material: CentralRuntimeMaterial): CentralRuntimeMaterial => {
    const text = material.text.slice(0, 24), end = text.length;
    return { ref: `central-runtime-fragment:${contentHashOf([material.ref, 0, text])}`, kind: material.kind,
      text: canonicalJson({ originalRef: material.ref, start: 0, end, totalChars: material.text.length, text,
        nextRef: end < material.text.length ? `central-runtime-page:${end}:${encodeURIComponent(material.ref)}` : null }),
      sourceRefs: [...new Set([material.ref, ...material.sourceRefs])] };
  };
  const page = centralMaterialFromPage({ ref: lateMaterial.ref, originalRef: lateMaterial.ref, originalScope: scope,
    origin: "model_proposal", owner: "board", coordinate: { runId: lateMaterial.ref, sequence: 1 }, sourceHash: contentHashOf(lateMaterial.text),
    start: 0, end: 24, totalChars: lateMaterial.text.length, text: lateMaterial.text.slice(0, 24) });

  state = { ...state, materials: [...state.materials, page] };
  persist("original_read_page_delivered");
  const view = createCentralJudgmentMaterial({ scope, operationId: "think:late", resultRef: late.resultRef,
    originalRef: lateMaterial.ref, originalHash: contentHashOf(lateMaterial), text: lateMaterial.text,
    sourceRefs: lateMaterial.sourceRefs, aliases: [lateMaterial.ref] });

  state = { ...state, materials: [...state.materials, view] };
  persist("original_judgment_view_delivered");
  const before = canonicalJson(facts), reader = createCentralJudgmentProvenanceReader({ facts, scope, boardSequence: facts.length });
  const direct = reader(lateMaterial);
  assert.ok(direct);
  assert.equal(direct.resultRef, late.resultRef);
  assert.equal(direct.completedFactRef, lateFactRef);
  const lateCompleted = state.completed.find(row => row.operation.operationId === "think:late");
  assert.ok(lateCompleted);
  const lateArchive = archive(lateFactRef, lateCompleted);

  for (const material of [fragment(lateMaterial), page, fragment(page), fragment(view), lateArchive, fragment(lateArchive)]) {
    const found = reader(material);
    assert.ok(found);
    assert.equal(found.operationId, "think:late");
    assert.equal(found.resultRef, late.resultRef);
    assert.equal(found.originalRef, material.ref);
    assert.equal(found.originalHash, contentHashOf(material));
    assert.equal(found.text, material.text);
    assert.ok(found.aliases.includes(late.resultRef));
    assert.ok(found.aliases.includes(material.ref));
  }

  for (const [factRef, completed] of [[unknownFactRef, unknown], [failedFactRef, failed]] as const) {
    const original = archive(factRef, completed);

    for (const material of [original, fragment(original)]) {
      const found = reader(material);
      assert.ok(found);
      assert.equal(found.operationId, completed.operation.operationId);
      assert.equal(found.resultRef, `central-operation-result:${contentHashOf(completed)}`);
      assert.equal(found.completedFactRef, factRef);
    }

    assert.equal(state.materials.some(row => row.ref === `central-operation-result:${contentHashOf(completed)}`), false,
      "an issued or failed thought archive need not have a derived result material");
  }

  for (const completed of state.completed.filter(row => row.operation.kind === "read" || row.operation.kind === "dispatch")) {
    const original = state.materials.find(row => row.ref === `central-operation-result:${contentHashOf(completed)}`);
    assert.ok(original);
    assert.equal(reader(original), undefined);
    assert.equal(reader(archive(domainFactRef, completed)), undefined);
    assert.equal(reader(fragment(archive(domainFactRef, completed))), undefined);
  }

  assert.throws(() => reader({ ...lateMaterial, text: `${lateMaterial.text}!` }), /central_judgment_provenance_unconfirmed/);
  const correctFragment = fragment(lateMaterial), body = JSON.parse(correctFragment.text), changed = `X${body.text.slice(1)}`;
  const tampered = { ...correctFragment, ref: `central-runtime-fragment:${contentHashOf([body.originalRef, body.start, changed])}`,
    text: canonicalJson({ ...body, text: changed }) };

  assert.throws(() => reader(tampered), /central_judgment_provenance_unconfirmed/);
  assert.equal(reader({ ref: "source:ordinary-user-json", kind: "source", text: view.text, sourceRefs: [] }), undefined);
  assert.equal(canonicalJson(facts), before, "provenance reads do not change outcomes, materials or accounting facts");
});
