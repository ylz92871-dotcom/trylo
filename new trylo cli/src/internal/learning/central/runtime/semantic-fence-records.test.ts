import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { testScratchPath } from "../../../testing/scratch.js";
import type { RewardV2Fact } from "../../reward/v2-facts.js";
import { packCentralDeliberationContext } from "../../../integration/central-learning/deliberation-context.js";
import { centralMaterialFromPage } from "../../../integration/central-learning/deliberation-material.js";
import { createCentralRuntimeSource } from "../../../integration/central-learning/runtime-source.js";
import type { LearningIssue } from "../../control/coordination-contract.js";
import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { emptyBoardState } from "../../control/state.js";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralLearningRuntimeState, CentralRuntimeMaterial } from "./contracts.js";
import { buildCentralRuntimeRecord, centralOperationSignature, emptyCentralRuntimeState, initialCentralRuntimeRef,
  lookupCentralRuntimeRecord, readCentralRuntimeRecords } from "./records.js";
import { validateAgendaTransition } from "./transitions.js";

test("semantic source fences survive compaction and only a new complete agenda or the matching returned receipt releases them", () => {
  const scope = "scope:semantic-fence-replay", empty = emptyCentralRuntimeState(scope), facts: RewardV2Fact[] = [];
  let previousRef = initialCentralRuntimeRef(scope);
  const append = (state: CentralLearningRuntimeState, reason: string) => {
    const fact: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef, state, reason, sourceRefs: [] }), sequence: facts.length + 1 };
    facts.push(fact);
    previousRef = fact.id;
    return readCentralRuntimeRecords(facts, scope, fact.sequence);
  };
  const completed = (operationId: string, outcome: CentralCompletedOperation["outcome"], sourceRefs: readonly string[]): CentralCompletedOperation => ({
    intentId: "intent:original-semantic-purpose", operation: { kind: "think", operationId,
      purpose: "Reconsider the original source condition", expectedChange: "A grounded complete agenda", sourceRefs },
    outcome, publicResult: `Original ${outcome} receipt`, resultRefs: [`receipt:${operationId}:${outcome}`] });
  const expectPending = (read: ReturnType<typeof readCentralRuntimeRecords>, refs: readonly string[], message: string) => {
    assert.deepEqual(new Set(read.history.pendingSemanticSourceRefs ?? []), new Set(refs), message);
  };
  const a = completed("operation:old-a", "unknown", ["source:a", "source:shared"]);
  const b = completed("operation:old-b", "failed", ["source:b", "source:shared"]);
  const oldLate = completed("operation:old-late", "unknown", ["source:old-late"]);
  const material: CentralRuntimeMaterial = { ref: "material:original-delivery", kind: "source",
    text: "The original material was delivered before its uncertain semantic receipt.", sourceRefs: ["source:a"] };
  const first = append({ ...empty, completed: [a, b, oldLate], materials: [material], consumedSourceRefs: ["source:already-confirmed"] },
    "central_deliberation_unknown");
  const compacted = append(empty, "compact_already_archived_materials_and_receipts");

  assert.deepEqual(compacted.state.completed, []);
  assert.deepEqual(compacted.state.materials, []);
  expectPending(compacted, ["source:a", "source:shared", "source:b", "source:old-late"],
    "discarding current receipts and material must not make uncertain sources rediscoverable");
  assert.deepEqual(compacted.history.consumedSourceRefs, ["source:already-confirmed"], "an uncertainty fence is not proof of source consumption");
  assert.deepEqual(lookupCentralRuntimeRecord(facts, scope, compacted.revision, { kind: "material", ref: material.ref }),
    { status: "found", factRef: first.stateRef, value: material });

  const returnedA: CentralCompletedOperation = { ...a, outcome: "returned", publicResult: "The original response is now confirmed",
    resultRefs: ["receipt:old-a:returned"] };
  const recoveredA = append({ ...empty, completed: [returnedA] }, "late_semantic_response_recovered_not_overwriting_new_agenda");

  expectPending(recoveredA, ["source:b", "source:shared", "source:old-late"],
    "a matching return clears its own source fence while another attempt still fences a shared source");

  append({ ...empty, completed: [returnedA, b, oldLate] }, "central_deliberation_returned");
  const carried = append({ ...empty, completed: [b, oldLate] }, "bookkeeping_carries_original_unknown_and_failed_receipts");

  expectPending(carried, [], "a newly committed complete agenda supersedes old fences and carried receipts cannot recreate them");
  const failedOldLate: CentralCompletedOperation = { ...oldLate, outcome: "failed", publicResult: "The old uncertain attempt finally failed",
    resultRefs: ["receipt:old-late:failed"] };
  const oldFailure = append({ ...empty, completed: [b, failedOldLate] }, "old_semantic_attempt_failed_after_new_agenda");

  expectPending(oldFailure, [], "an old attempt changing from unknown to failed cannot re-fence a newer complete agenda");

  const newFailure = completed("operation:new-failed", "failed", ["source:new-failed", "source:shared"]);
  const newUnknown = completed("operation:new-unknown", "unknown", ["source:new-unknown", "source:shared"]);
  const newer = append({ ...empty, completed: [b, failedOldLate, newFailure, newUnknown] }, "new_semantic_attempts_failed_or_unknown");

  expectPending(newer, ["source:new-failed", "source:new-unknown", "source:shared"], "new attempts after the agenda establish their own fences");
  const unrelatedRecovery = append({ ...empty, completed: [returnedA, newFailure, newUnknown] },
    "late_semantic_response_recovered_not_overwriting_new_agenda");

  expectPending(unrelatedRecovery, ["source:new-failed", "source:new-unknown", "source:shared"],
    "recovering an older response without applying its agenda must not clear newer failures");
  const returnedNew: CentralCompletedOperation = { ...newUnknown, outcome: "returned", publicResult: "This exact response returned",
    resultRefs: ["receipt:new-unknown:returned"] };
  const matchingRecovery = append({ ...empty, completed: [newFailure, returnedNew] },
    "late_semantic_response_recovered_not_overwriting_new_agenda");

  expectPending(matchingRecovery, ["source:new-failed", "source:shared"], "a late response clears only its matching operation");
  const final = append(empty, "compact_remaining_semantic_receipts");

  expectPending(final, ["source:new-failed", "source:shared"], "the remaining new failure still survives another workset compaction");

  for (const original of [a, b, oldLate]) {
    assert.deepEqual(lookupCentralRuntimeRecord(facts, scope, final.revision, { kind: "completed", operationId: original.operation.operationId,
      factRef: first.stateRef }), { status: "found", factRef: first.stateRef, value: original }, "fence changes preserve original receipt bodies and outcomes");
    assert.equal(final.history.operations.find(row => row.operationId === original.operation.operationId)?.signature,
      centralOperationSignature(original.operation), "neither compaction nor recovery changes an original operation identity or meaning");
  }
});

test("a body delivered once under organization grounds a central purpose while unread navigation only permits a source read", async () => {
  const scope = "scope:canonical-grounding", quote = "A real later correction identifies the missing boundary condition.";
  const body: CentralRuntimeMaterial = { ref: "material:actual-correction", kind: "feedback", text: quote, sourceRefs: ["fact:actual-correction"] };
  const unread: CentralRuntimeMaterial = { ref: "material:unread-original", kind: "source", text: "This original body has not been delivered.", sourceRefs: [] };
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: "budget:canonical-grounding",
    configuration: { schemaVersion: 1, configurationRef: "configuration:canonical-grounding", authorizationRef: "user:original-authorization",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 2000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } },
    boardSequence: 0, resources: { boardSequence: 0, budgetId: "budget:canonical-grounding", limits: { tokens: 2000, calls: 2, steps: 2 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 2000, calls: 2, steps: 2 }, status: "available", holdReason: null },
    stateRef: initialCentralRuntimeRef(scope), state: { ...emptyCentralRuntimeState(scope), materials: [body] },
    opportunities: [], materials: [body, unread], organization: [body], operation: { kind: "think", operationId: "operation:canonical-grounding",
      purpose: "Compare an actual correction and an unread source location", expectedChange: "Choose a grounded next investigation", sourceRefs: [body.ref] } };
  const delivered = packCentralDeliberationContext(request, candidate => !candidate.materials.some(row => row.ref === unread.ref));

  assert.deepEqual(delivered.state.materials, []);
  assert.equal(delivered.materials.some(row => row.ref === body.ref), false);
  assert.deepEqual(delivered.organization, [body], "canonical body-once packing keeps this actual correction only under organization");
  const navigation = delivered.materials.find(row => row.sourceRefs.includes(unread.ref));
  assert.ok(navigation);
  assert.equal(JSON.parse(navigation.text).role, "central_source_body_not_delivered");
  const intent: CentralLearningIntentDraft = { intentId: "purpose:derived-from-correction",
    subject: { plane: "central", questionRef: "purpose:derived-from-correction" }, goal: "Resolve the newly identified condition",
    rationale: "The actual later correction exposes a reusable unanswered condition", conditions: ["The corrected original task family"],
    knowledge: [], residual: ["The corrected boundary still needs its original source"],
    commitment: { purpose: "Read evidence that can resolve the corrected boundary", assumptions: ["The correction applies to this task family"],
      reconsiderWhen: ["The exact original source has been read"] }, revisionReason: "Derive a purpose from the delivered correction",
    sourceRefs: [body.ref], derivation: { relation: "The actual correction exposes a still unanswered boundary",
      whenRelevant: "When the corrected task condition recurs", parentRefs: [body.ref], citations: [{ evidenceRef: body.ref, quote }] },
    continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:read-unread-original",
      purpose: "Read the original source behind the correction", expectedChange: "Recover the still unread boundary evidence",
      sourceRefs: [navigation.ref, unread.ref], refs: [unread.ref], maximumChars: 1000 } } };
  const output = (value: CentralLearningIntentDraft): CentralDeliberationOutput => ({ schemaVersion: 1, intents: [value],
    publicExplanation: "The delivered correction grounds the purpose; navigation supplies the next read address", sourceRefs: [body.ref, navigation.ref] });

  assert.equal(validateAgendaTransition(delivered, output(intent)), null,
    "a real organization body grounds the new purpose while an unread original remains a legal next read address");
  const falselyGrounded: CentralLearningIntentDraft = { ...intent, derivation: { relation: "Treat the source location as a body",
    whenRelevant: "While the original is still unread", parentRefs: [navigation.ref],
    citations: [{ evidenceRef: navigation.ref, quote: "central_source_body_not_delivered" }] } };

  assert.equal(validateAgendaTransition(delivered, output(falselyGrounded)), "central_derived_intent_citation_unread_or_not_unique",
    "even an exact unique quotation from navigation metadata is not evidence that its original body was delivered");

  const problem = "The original report describes an untested retry boundary.";
  const issue: LearningIssue = { schemaVersion: 1, issueId: "issue:catalog-report", scope, problemKey: problem, revision: 1,
    createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", decision: { kind: "unreviewed" },
    reports: [{ reportId: "report:catalog-original", source: { subsystem: "tool", taskId: "task:catalog-original", versionId: "version:catalog-original" },
      facts: ["The source has not yet been read by this deliberation"], hypotheses: [], evidenceRefs: [] }] };
  const board = { ...emptyBoardState(), learningIssues: [issue] };
  const source = createCentralRuntimeSource({ boardRoot: mkdtempSync(testScratchPath("central-semantic-fence-board-")), scope, enabled: () => true, ports: [],
    board: { async load() { return { ok: true, state: board, generation: 1 }; } } });
  const snapshot = await source.snapshot(scope, new AbortController().signal);
  const catalog = snapshot.materials.find(row => JSON.parse(row.text).role === "original_report_catalog_not_read_body");
  assert.ok(catalog);
  assert.equal(catalog.text.indexOf(problem), catalog.text.lastIndexOf(problem));
  assert.ok(catalog.text.includes(problem), "the actual original report catalog exposes a unique problem string without its report body");
  const catalogOnly: CentralDeliberationRequest = { ...delivered, state: emptyCentralRuntimeState(scope),
    materials: [catalog], organization: [], opportunities: [], operation: { ...delivered.operation, sourceRefs: [catalog.ref] } };
  const catalogIntent: CentralLearningIntentDraft = { ...intent, sourceRefs: [catalog.ref], derivation: {
    relation: "Treat a catalog problem as newly read evidence", whenRelevant: "Before reading the original report", parentRefs: [catalog.ref],
    citations: [{ evidenceRef: catalog.ref, quote: problem }] }, continuation: { kind: "ready", operation: { kind: "read",
      operationId: "operation:read-catalog-report", purpose: "Read the original report", expectedChange: "Recover actual source evidence",
      sourceRefs: [catalog.ref], refs: [JSON.parse(catalog.text).entries[0].readRef], maximumChars: 1000 } } };
  const catalogOutput: CentralDeliberationOutput = { ...output(catalogIntent), sourceRefs: [catalog.ref] };

  assert.equal(validateAgendaTransition(catalogOnly, catalogOutput), "central_derived_intent_citation_unread_or_not_unique",
    "a unique problem string from the sole actual report catalog cannot ground a new central purpose");
  assert.equal(validateAgendaTransition({ ...catalogOnly, state: { ...catalogOnly.state, intents: [intent] } }, catalogOutput),
    "central_derived_intent_citation_unread_or_not_unique", "an existing central purpose cannot switch its grounding to a newly quoted catalog");

  const relationshipText = canonicalJson({ role: "organization_feedback_relationship_catalog_not_read_body",
    entries: [{ factRef: "fact:related-feedback", problem, readRef: "organization-record:original-feedback" }] });
  const relationship: CentralRuntimeMaterial = { ref: `organization-feedback-relations:${contentHashOf(relationshipText)}`,
    kind: "feedback", text: relationshipText, sourceRefs: ["fact:related-feedback"] };
  const relationshipIntent: CentralLearningIntentDraft = { ...catalogIntent, sourceRefs: [relationship.ref], derivation: {
    relation: "Treat a feedback relationship as its unread body", whenRelevant: "Before reading the original feedback",
    parentRefs: [relationship.ref], citations: [{ evidenceRef: relationship.ref, quote: problem }] }, continuation: { kind: "ready", operation: {
      kind: "read", operationId: "operation:read-related-feedback", purpose: "Read the original related feedback",
      expectedChange: "Recover the original body behind the relationship", sourceRefs: [relationship.ref],
      refs: ["organization-record:original-feedback"], maximumChars: 1000 } } };

  assert.equal(validateAgendaTransition({ ...catalogOnly, materials: [relationship] }, {
    ...output(relationshipIntent), sourceRefs: [relationship.ref] }), "central_derived_intent_citation_unread_or_not_unique",
  "organization feedback relationships are navigation and cannot ground a body quotation");
  const relationFragmentText = relationshipText.slice(0, relationshipText.indexOf(problem) + problem.length);
  const relationFragmentBody = canonicalJson({ originalRef: relationship.ref, start: 0, end: relationFragmentText.length,
    totalChars: relationshipText.length, text: relationFragmentText,
    nextRef: `central-runtime-page:${relationFragmentText.length}:${encodeURIComponent(relationship.ref)}` });
  const relationFragment: CentralRuntimeMaterial = { ref: `central-runtime-fragment:${contentHashOf([relationship.ref, 0, relationFragmentText])}`,
    kind: "feedback", text: relationFragmentBody, sourceRefs: [relationship.ref] };

  assert.ok(relationshipIntent.derivation);
  const fragmentedIntent: CentralLearningIntentDraft = { ...relationshipIntent, sourceRefs: [relationFragment.ref], derivation: {
    ...relationshipIntent.derivation, parentRefs: [relationFragment.ref], citations: [{ evidenceRef: relationFragment.ref, quote: problem }] },
    continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:read-related-feedback-fragment",
      purpose: "Read the original related feedback", expectedChange: "Recover its actual body", sourceRefs: [relationFragment.ref],
      refs: ["organization-record:original-feedback"], maximumChars: 1000 } } };

  assert.equal(validateAgendaTransition({ ...catalogOnly, materials: [relationFragment] }, {
    ...output(fragmentedIntent), sourceRefs: [relationFragment.ref] }), "central_derived_intent_citation_unread_or_not_unique",
  "a fragment of a feedback relationship catalog remains unread navigation");

  for (const role of ["organization_feedback_not_delivered_capacity", "organization_recall_not_delivered_capacity"]) {
    const text = canonicalJson({ role, readRef: "organization-record:original-feedback", minimumCharacters: 40000, explanation: problem });
    const capacity: CentralRuntimeMaterial = { ref: `organization-capacity:${contentHashOf(text)}`, kind: "feedback", text, sourceRefs: [] };
    const capacityIntent: CentralLearningIntentDraft = { ...relationshipIntent, sourceRefs: [capacity.ref], derivation: {
      ...relationshipIntent.derivation, parentRefs: [capacity.ref], citations: [{ evidenceRef: capacity.ref, quote: problem }] },
      continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:read-capacity-original",
        purpose: "Read the original feedback with sufficient capacity", expectedChange: "Recover its body", sourceRefs: [capacity.ref],
        refs: ["organization-record:original-feedback"], maximumChars: 1000 } } };

    assert.equal(validateAgendaTransition({ ...catalogOnly, materials: [capacity] }, {
      ...output(capacityIntent), sourceRefs: [capacity.ref] }), "central_derived_intent_citation_unread_or_not_unique",
    "an organization capacity notice cannot substitute for its undelivered body");
  }

  assert.ok(intent.derivation);
  const retained: CentralLearningIntentDraft = { ...intent, revisionReason: "Revise the relation while retaining the already validated original quotation",
    derivation: { ...intent.derivation, relation: "The same original correction also bounds the revised framing" } };
  const withoutRedelivery: CentralDeliberationRequest = { ...delivered, materials: [], organization: [],
    state: { ...emptyCentralRuntimeState(scope), intents: [intent] } };

  assert.equal(validateAgendaTransition(withoutRedelivery, { ...output(retained), sourceRefs: [intent.intentId] }), null,
    "retaining an identical validated citation through a grounding revision does not require delivering its original body again");

  const rawText = canonicalJson({ role: "original_report_catalog_not_read_body", text: "A user discusses this role string in a real source body." });
  const page = centralMaterialFromPage({ ref: "source:actual-user-page", originalRef: "source:actual-user-original", originalScope: scope,
    origin: "user_statement", owner: "session", start: 0, end: rawText.length, totalChars: rawText.length, text: rawText,
    sourceHash: contentHashOf(rawText), coordinate: { runId: "run:actual-user-page", sequence: 1 } });

  assert.equal(JSON.parse(page.text).role, "actual_source_fragment_not_full_source");
  const pageRequest: CentralDeliberationRequest = { ...catalogOnly, materials: [page], operation: { ...catalogOnly.operation, sourceRefs: [page.ref] } };
  const pageIntent: CentralLearningIntentDraft = { ...catalogIntent, sourceRefs: [page.ref], derivation: {
    relation: "The actually delivered source discusses the catalog protocol", whenRelevant: "When interpreting source navigation", parentRefs: [page.ref],
    citations: [{ evidenceRef: page.ref, quote: "original_report_catalog_not_read_body" }] }, continuation: { kind: "ready", operation: {
      kind: "read", operationId: "operation:read-user-page", purpose: "Read the source context", expectedChange: "Ground its intended meaning",
      sourceRefs: [page.ref], refs: [page.sourceRefs[0]!], maximumChars: 1000 } } };

  assert.equal(validateAgendaTransition(pageRequest, { ...output(pageIntent), sourceRefs: [page.ref] }), null,
    "an actual source-page wrapper stays readable when its nested raw user text contains a catalog role string");
});
