import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { deliveredArchivedIntents, identifyDeliveredArchivedIntentClaims } from "./archived-intents.js";
import { validateAgendaTransition, validateAgendaTransitionBeforeHistory } from "./transitions.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "./records.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "./contracts.js";
import { readCentralPurposeMemory } from "../../../integration/central-learning/runtime-purpose-memory.js";
import { centralMaterialFromPage } from "../../../integration/central-learning/deliberation-material.js";
import { createCentralChangeView } from "../../../integration/central-learning/change-input.js";
import { compileCentralLearningChange } from "../../../integration/central-learning/change-compile.js";
import { centralLearningChangeSchema } from "../../../integration/central-learning/change-schema.js";

const scope = "scope:archived-intent-contract", currentRef = "source:new-condition";

function fixture(goalState: "open" | "withdrawn" = "open") {
  const original: CentralLearningIntentDraft = { intentId: "central-purpose:original", subject: { plane: "central", questionRef: "central-purpose:original" },
    goal: "Resolve the original condition", rationale: "The old source left a specific unknown", conditions: ["The original task family"],
    knowledge: [{ statement: "The original supported result", conditions: "Original scope only", sourceRefs: ["source:original"] }],
    residual: ["The original condition remains open"], commitment: { purpose: "Resolve the original unknown", assumptions: ["Original source still applies"],
      reconsiderWhen: ["A new discriminating source arrives"] }, revisionReason: "The first investment ended", sourceRefs: ["source:original"],
    continuation: { kind: "ended", goalState, reason: goalState === "open" ? "Original resources stopped before answering" : "The owner withdrew this purpose" } };
  const initial = emptyCentralRuntimeState(scope);
  const first = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...initial, intents: [original] },
    reason: "Retain the original ended purpose", sourceRefs: ["source:original"] }), sequence: 1 };
  const compacted = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: initial, reason: "Compact an already archived ended purpose", sourceRefs: [] }), sequence: 2 };
  const facts = [first, compacted], cursor = readCentralRuntimeRecords(facts, scope, 2);
  const next: CentralLearningIntentDraft = { ...original, revisionReason: "The newly delivered original evidence makes a bounded continuation worthwhile",
    continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:grounded-continuation", purpose: "Read the changed original condition",
      expectedChange: "Resolve the original residual with new evidence", sourceRefs: [currentRef], refs: [currentRef], maximumChars: 1000 } } };
  const request = (material: CentralRuntimeMaterial): CentralDeliberationRequest => ({ schemaVersion: 1, scope, budgetId: "budget:original",
    configuration: { schemaVersion: 1, configurationRef: "configuration:original", authorizationRef: "user:original", allowance: {
      schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 4, maxSteps: 4, maxPromptChars: 10000 } },
    boardSequence: cursor.revision, resources: { boardSequence: cursor.revision, budgetId: "budget:original", limits: { tokens: 1000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 1000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: cursor.stateRef, state: cursor.state, opportunities: [], materials: [material,
      { ref: currentRef, kind: "source", text: "New original evidence reveals the previously missing condition", sourceRefs: [] }], organization: [],
    operation: { kind: "think", operationId: "operation:review-archived-purpose", purpose: "Review the exact original purpose against new evidence",
      expectedChange: "Decide whether to continue that purpose", sourceRefs: [currentRef] } });
  const exact = (value = original, role = "exact_original_runtime_archive_not_new_evidence"): CentralRuntimeMaterial => ({
    ref: role === "exact_original_ended_learning_purpose_not_new_evidence"
      ? `central-runtime-purpose-record:${contentHashOf([value.intentId, first.id])}`
      : `central-runtime-archived:${contentHashOf([first.id, value])}`,
    kind: "work_result", text: canonicalJson({ role, factRef: first.id, value }),
    sourceRefs: role === "exact_original_ended_learning_purpose_not_new_evidence" ? [value.intentId, first.id] : [first.id, value.intentId] });
  const output = (value = next): CentralDeliberationOutput => ({ schemaVersion: 1, intents: [value], publicExplanation: "Reconsider the original purpose",
    sourceRefs: [currentRef] });

  return { original, next, first, compacted, facts, cursor, request, exact, output };
}

test("an archived open-purpose navigation excerpt cannot authorize reusing its original intent identity", () => {
  const f = fixture();
  const navigation: CentralRuntimeMaterial = { ref: "material:archive-navigation", kind: "knowledge", text: canonicalJson({
    role: "related_ended_intent_catalog_not_read_body", entries: [{ intentId: f.original.intentId, factRef: f.first.id,
      subject: f.original.subject, goalState: "open", goal: f.original.goal }] }), sourceRefs: [f.first.id, f.original.intentId] };
  const request = f.request(navigation);

  assert.equal(deliveredArchivedIntents(request, f.cursor.history).size, 0);
  assert.equal(validateAgendaTransition(request, f.output(), f.cursor.history), "central_archived_intent_original_read_required");
});

test("an exact original archive body plus an explicit revision permits the original open-purpose identity to continue", () => {
  const f = fixture();
  for (const role of ["exact_original_runtime_archive_not_new_evidence", "exact_original_ended_learning_purpose_not_new_evidence"]) {
    const request = f.request(f.exact(f.original, role));
    assert.deepEqual(deliveredArchivedIntents(request, f.cursor.history).get(f.original.intentId), f.original);
    assert.equal(validateAgendaTransition(request, f.output(), f.cursor.history), null);
    assert.equal(validateAgendaTransition(request, f.output({ ...f.next, revisionReason: "" }), f.cursor.history), "central_intent_revision_reason_required");
  }
});

test("archived subject identity and an explicit withdrawal cannot be rewritten by a later model continuation", () => {
  const open = fixture(), request = open.request(open.exact());
  const wrongSubject: CentralLearningIntentDraft = { ...open.next, subject: { plane: "agent", domain: "tool", issueId: "issue:unrelated" } };

  assert.equal(validateAgendaTransition(request, open.output(wrongSubject), open.cursor.history), "central_intent_subject_changed");
  const substituted = open.request(open.exact({ ...open.original, subject: wrongSubject.subject }));

  assert.equal(deliveredArchivedIntents(substituted, open.cursor.history).size, 0, "a different subject under the old fact locator is not an original archive delivery");
  const withdrawn = fixture("withdrawn"), withdrawnRequest = withdrawn.request(withdrawn.exact());

  assert.equal(validateAgendaTransition(withdrawnRequest, withdrawn.output(), withdrawn.cursor.history), "central_withdrawn_intent_requires_new_authorized_purpose");
});

test("a pending operation keeps its exact meaning under the same ID or explicitly rejects purpose and source changes", () => {
  const f = fixture(), pending = f.next;
  assert.equal(pending.continuation.kind, "ready");

  if (pending.continuation.kind !== "ready") return;

  const operation = pending.continuation.operation;
  const request = { ...f.request(f.exact()), state: { ...f.cursor.state, intents: [pending] } };
  const retained: CentralLearningIntentDraft = { ...pending, continuation: { kind: "ready", operation: { ...operation, sourceRefs: [...operation.sourceRefs] } } };

  assert.equal(validateAgendaTransition(request, f.output(retained), f.cursor.history), null, "preserving the same pending proposal remains legal");

  for (const changed of [{ ...operation, purpose: "Study a different research question" }, { ...operation, sourceRefs: [currentRef, "source:original"] }]) {
    assert.equal(changed.operationId, operation.operationId);
    const revised: CentralLearningIntentDraft = { ...pending, revisionReason: "This revision reason does not authorize mutating an existing operation identity",
      continuation: { kind: "ready", operation: changed } };
    assert.equal(validateAgendaTransition(request, f.output(revised), f.cursor.history), "central_pending_operation_identity_changed");
  }
});

test("a delivered original purpose claim permits preliminary continuation while true history rejects substitution or later withdrawal", () => {
  const f = fixture(), archive = { facts: f.facts, scope, boardSequence: 2 };
  const ref = `central-runtime-purpose-record:${contentHashOf([f.original.intentId, f.first.id])}`;
  const body = readCentralPurposeMemory(archive, ref);
  assert.ok(body);
  const request = f.request(body), before = canonicalJson(request), output = f.output();

  assert.deepEqual(request.state.intents, [], "the original open purpose genuinely left the compact workset");
  assert.deepEqual(identifyDeliveredArchivedIntentClaims(request).get(f.original.intentId), {
    materialRef: ref, factRef: f.first.id, intentHash: contentHashOf(f.original), intent: f.original });
  assert.equal(validateAgendaTransitionBeforeHistory(request, output), null);
  assert.equal(validateAgendaTransition(request, output, f.cursor.history), null);
  assert.equal(output.intents[0]?.intentId, f.original.intentId);
  assert.equal(canonicalJson(request), before, "preliminary recognition does not add the archive to the live agenda");
  const input = createCentralChangeView(request), dictionary = input.dictionary;
  const target = dictionary.entries.find(row => row.kind === "intent" && row.ref === f.original.intentId);
  const source = dictionary.entries.find(row => row.kind === "source" && row.ref === currentRef);
  const read = dictionary.entries.find(row => row.kind === "read" && row.ref === currentRef);

  assert.ok(target);
  assert.ok(source);
  assert.ok(read);
  assert.ok(JSON.stringify(centralLearningChangeSchema(request, dictionary)).includes('"revise"'),
    "the actual C16 schema advertises revision when the complete delivered archive supplies its exact handle");
  const compiled = compileCentralLearningChange({ checkpoint: input.view.checkpoint, explanation: "Continue the same original open question",
    changes: [{ kind: "revise", target: target.handle, why: "New original evidence justifies another bounded investment", set: {
      next: { kind: "read", purpose: "Inspect the changed original condition", expectedChange: "Resolve the old residual",
        sources: [source.handle], refs: [read.handle], maximumChars: 1000 } } }] }, request, dictionary);

  assert.equal(compiled.intents[0]?.intentId, f.original.intentId);
  assert.equal(compiled.intents[0]?.continuation.kind, "ready");
  assert.equal(validateAgendaTransitionBeforeHistory(request, compiled), null);
  assert.equal(validateAgendaTransition(request, compiled, f.cursor.history), null);
  assert.deepEqual(compileCentralLearningChange({ checkpoint: input.view.checkpoint, changes: [], explanation: "Keep the original investment ended" }, request, dictionary).intents, [],
    "merely delivering an archive never inserts it into the current agenda");
  const inOrganization = { ...request, materials: request.materials.filter(row => row.ref !== body.ref), organization: [body] };

  assert.equal(identifyDeliveredArchivedIntentClaims(inOrganization).size, 1);
  assert.equal(validateAgendaTransition(inOrganization, output, f.cursor.history), null);
  const generic = f.exact(), query = `central-runtime-archive:${encodeURIComponent(canonicalJson({ kind: "ended_intent", intentId: f.original.intentId, factRef: f.first.id }))}`;

  assert.equal(identifyDeliveredArchivedIntentClaims(f.request({ ...generic, sourceRefs: [f.first.id, query] })).size, 1);

  for (const value of [{ ...f.original, goal: "A substituted original goal under the same locator" },
    { ...f.original, sourceRefs: [currentRef] }]) {
    const substituted = f.request(f.exact(value, "exact_original_ended_learning_purpose_not_new_evidence"));
    assert.equal(substituted.materials[0]?.ref, ref);
    assert.equal(identifyDeliveredArchivedIntentClaims(substituted).size, 1, "structure alone cannot authenticate original intent bytes");
    assert.equal(deliveredArchivedIntents(substituted, f.cursor.history).size, 0, "only the original writer's full-body hash can authenticate the claim");
    assert.equal(validateAgendaTransitionBeforeHistory(substituted, output), null);
    assert.notEqual(validateAgendaTransition(substituted, output, f.cursor.history), null, "the true original head hash must reject substituted bytes");
  }

  const directory = readCentralPurposeMemory(archive, "central-runtime-purpose-catalog:0");
  assert.ok(directory);
  const partial = centralMaterialFromPage({ ref: body.ref, originalRef: body.ref, originalScope: scope, owner: "board", origin: "execution_result",
    coordinate: { runId: body.ref, sequence: 0 }, sourceHash: contentHashOf(body.text), start: 0, end: 32, totalChars: body.text.length, text: body.text.slice(0, 32) });

  for (const material of [directory, partial, { ...body, ref: "material:unowned-exact-body" }, { ...body, kind: "source" as const },
    { ...body, text: ` ${body.text}` }]) {
    const unread = f.request(material);
    assert.equal(identifyDeliveredArchivedIntentClaims(unread).size, 0);
    assert.notEqual(validateAgendaTransitionBeforeHistory(unread, output), null);
    assert.notEqual(validateAgendaTransition(unread, output, f.cursor.history), null);
  }

  const stateOnly = { ...request, materials: request.materials.filter(row => row.ref !== body.ref), state: { ...request.state, materials: [body] } };

  assert.equal(identifyDeliveredArchivedIntentClaims(stateOnly).size, 0);
  assert.notEqual(validateAgendaTransition(stateOnly, output, f.cursor.history), null);
  const foreign = { ...request, scope: "scope:another", state: { ...request.state, scope: "scope:another" } };

  assert.notEqual(validateAgendaTransition(foreign, output, f.cursor.history), null);

  const withdrawn: CentralLearningIntentDraft = { ...f.original, revisionReason: "The owner subsequently withdrew this original purpose",
    continuation: { kind: "ended", goalState: "withdrawn", reason: "No renewed authority to continue" } };
  const ended = { ...buildCentralRuntimeRecord({ previousRef: f.compacted.id, state: { ...f.cursor.state, intents: [withdrawn] },
    reason: "Original owner withdrawal", sourceRefs: [] }), sequence: 3 };
  const compact = { ...buildCentralRuntimeRecord({ previousRef: ended.id, state: emptyCentralRuntimeState(scope),
    reason: "Compact the already archived withdrawal", sourceRefs: [] }), sequence: 4 };
  const facts = [...f.facts, ended, compact], latest = readCentralRuntimeRecords(facts, scope, 4);

  assert.deepEqual(readCentralPurposeMemory({ facts, scope, boardSequence: 4 }, ref), body, "old exact bytes remain readable after withdrawal");
  const stale = { ...request, boardSequence: 4, stateRef: latest.stateRef, state: latest.state, resources: { ...request.resources, boardSequence: 4 } };

  assert.equal(validateAgendaTransitionBeforeHistory(stale, output), null, "preliminary claims do not invent a current history verdict");
  assert.notEqual(validateAgendaTransition(stale, output, latest.history), null, "the latest original withdrawal wins over old open-body delivery");
  const oldReceipt = { ...request, state: { ...request.state, intents: [f.original] } };

  assert.notEqual(validateAgendaTransition(oldReceipt, output, latest.history), null,
    "an older receipt carrying the once-live open purpose cannot bypass the latest writer withdrawal");
});
