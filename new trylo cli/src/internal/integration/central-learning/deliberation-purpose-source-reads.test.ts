import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralPurposeSourceReads } from "./deliberation-purpose-source-reads.js";
import { readCentralPurposeMemory } from "./runtime-purpose-memory.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { createCentralChangeView } from "./change-input.js";
import { CENTRAL_CHANGE_INPUT_VERSION, type CentralChangeInput } from "./change-input-contract.js";
import type { CentralInputPresentedMaterial } from "./change-input-render.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { centralDeliberationReservation, decodeCentralDeliberation } from "./deliberation-prompt.js";
import { CENTRAL_ACTION_JSON_FORMAT, encodeCentralDeliberation } from "./deliberation-encoding.js";
import { buildCentralDeliberationWireEvidence, isCentralDeliberationWireEvidence } from "./deliberation-wire-evidence.js";
import { activePurposeAgendaVersion, createActivePurposeOriginal, readActivePurposeDelivery } from "./active-purpose-delivery.js";

const scope = "scope:purpose-source-reads", V4 = "central-learning-change-input-v4", V5 = "central-learning-change-input-v5";
const refs = { top: "source:purpose-top", shared: "source:purpose-shared", knowledge: "source:purpose-knowledge",
  parent: "source:purpose-parent", citation: "source:purpose-citation", prose: "source:quoted-json-is-not-a-read" };
const expectedReads = [refs.top, refs.shared, refs.knowledge, refs.parent, refs.citation];

function fixture() {
  const original: CentralLearningIntentDraft = { intentId: "purpose:source-reads-original",
    subject: { plane: "user", ledgerRef: "ledger:original", questionRef: "question:original" },
    goal: "Inspect the original report's applicable conditions", rationale: "Retain its observed boundary and unresolved question",
    conditions: ["Original task family only"], sourceRefs: [refs.top, refs.shared],
    knowledge: [{ statement: `The original observation remains conditional. ${canonicalJson({ readRef: refs.prose, sourceRefs: [refs.prose] })}`,
      conditions: "The quoted JSON is prose, not host navigation", sourceRefs: [refs.knowledge, refs.shared] }],
    derivation: { relation: "The original report motivated this user question", whenRelevant: "When the same report needs review",
      parentRefs: [refs.parent, refs.shared], citations: [{ evidenceRef: refs.citation, quote: "An exact retained report sentence." }] },
    residual: ["The original source bodies must be read before a new claim"],
    commitment: { purpose: "Review the original boundary", assumptions: [], reconsiderWhen: [] },
    revisionReason: "The original investment stopped", continuation: { kind: "ended", goalState: "open", reason: "Await discriminating evidence" } };
  const empty = emptyCentralRuntimeState(scope);
  const first = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...empty, intents: [original] },
    reason: "Retain the original ended purpose", sourceRefs: original.sourceRefs }), sequence: 1 };
  const compacted = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: empty,
    reason: "Compact the original ended purpose", sourceRefs: [] }), sequence: 2 };
  const facts = [first, compacted], cursor = readCentralRuntimeRecords(facts, scope, 2);
  const archive = { facts, scope, boardSequence: 2 };
  const recordRef = `central-runtime-purpose-record:${contentHashOf([original.intentId, first.id])}`;
  const body = readCentralPurposeMemory(archive, recordRef);
  assert.ok(body);
  const request = (materials: readonly CentralRuntimeMaterial[] = [body]): CentralDeliberationRequest => ({
    schemaVersion: 1, scope, budgetId: "budget:purpose-source-reads", boardSequence: cursor.revision,
    stateRef: cursor.stateRef, state: cursor.state, materials, organization: [], opportunities: [],
    configuration: { schemaVersion: 1, configurationRef: "configuration:purpose-source-reads", authorizationRef: "authorization:original",
      generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 }, thoughtMaxTokens: 20000,
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 40000 } },
    resources: { boardSequence: cursor.revision, budgetId: "budget:purpose-source-reads", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    operation: { kind: "think", operationId: "operation:inspect-purpose-sources", purpose: "Review the complete original purpose",
      expectedChange: "Choose an original source read without asserting a new fact", sourceRefs: [] } });

  return { original, empty, first, compacted, facts, archive, cursor, body, request };
}

function readHandle(input: CentralChangeInput, ref: string): string {
  const entry = input.dictionary.entries.find(row => row.kind === "read" && row.ref === ref);
  assert.ok(entry, `Missing read capability for ${ref}`);
  return entry.handle;
}

function renderedReads(input: CentralChangeInput, materialRef: string): readonly string[] {
  const entry = input.dictionary.entries.find(row => row.kind === "source" && row.ref === materialRef);
  assert.ok(entry);
  assert.ok(Array.isArray(input.view.materials));
  const row = input.view.materials.find(value => value !== null && typeof value === "object" && !Array.isArray(value) && value.handle === entry.handle);

  assert.ok(row !== null && typeof row === "object" && !Array.isArray(row));
  assert.ok(Array.isArray(row.reads));

  return row.reads.map((read: CentralInputPresentedMaterial["reads"][number]) => {
    assert.ok(read !== null && typeof read === "object" && !Array.isArray(read) && typeof read.address === "string");
    return read.address;
  });
}

function noInheritedReads(request: CentralDeliberationRequest): void {
  assert.equal(centralPurposeSourceReads(request).size, 0);
  const input = createCentralChangeView(request, V5);
  for (const ref of expectedReads) assert.ok(!input.dictionary.entries.some(row => row.kind === "read" && row.ref === ref));
}

test("current owned continuation dependencies remain readable when their original notice left the context, without changing v6", () => {
  const f = fixture(), dependency = "source:original-owned-continuation";
  const continuations: readonly CentralLearningIntentDraft["continuation"][] = [
    { kind: "waiting", wait: { kind: "use_feedback", reason: "Read the original use feedback before judging benefit", sourceRefs: [dependency] } },
    { kind: "ready", operation: { kind: "think", operationId: "think:owned-dependency", purpose: "Revisit an original prerequisite",
      expectedChange: "Choose an original read", sourceRefs: [dependency] } },
  ];

  for (const continuation of continuations) {
    const live = { ...f.original, continuation, revisionReason: "Keep the actual unresolved dependency" };
    const request = { ...f.request([]), state: { ...f.empty, intents: [live] } }, before = canonicalJson(request);
    const frozen = createCentralChangeView(request, "central-learning-change-input-v6");

    assert.equal(frozen.dictionary.entries.some(row => row.kind === "read" && row.ref === dependency), false,
      "The original v6 projection must not inherit a new dependency capability");
    const current = createCentralChangeView(request), handle = readHandle(current, dependency);

    assert.equal(current.dictionary.source(handle), undefined);
    assert.equal(current.dictionary.citation(handle, "Original feedback"), undefined);
    assert.deepEqual(current.exposure, [], "A host-owned dependency address is not a delivered body");
    const decision = compileCentralLearningChange({ checkpoint: current.view.checkpoint, changes: [], explanation: "Inspect the owned dependency",
      inspect: { purpose: "Read the original unresolved feedback", expectedChange: "Recover its body or record actual unavailability",
        refs: [handle], maximumChars: 4096 } }, request, current.dictionary);

    assert.deepEqual(decision.agendaRead?.refs, [dependency]);
    assert.equal(canonicalJson(request), before);
  }
});

test("v5 purpose source locations remain available in current input without admitting bodies, and the current proof replays", () => {
  const f = fixture(), request = f.request(), before = canonicalJson(request);

  assert.deepEqual(centralPurposeSourceReads(request).get(f.body.ref), expectedReads);
  const inOrganization = { ...request, materials: [], organization: [f.body] };

  assert.deepEqual(centralPurposeSourceReads(inOrganization).get(f.body.ref), expectedReads);
  const current = createCentralChangeView(request), legacy = createCentralChangeView(request, V4);

  assert.deepEqual(renderedReads(createCentralChangeView(request, V5), f.body.ref), [...expectedReads, f.body.ref]);
  const handles = expectedReads.map(ref => readHandle(current, ref));

  assert.deepEqual(renderedReads(current, f.body.ref), [...expectedReads, f.body.ref]);
  assert.deepEqual(current.exposure.find(row => row.ref === f.body.ref)?.readRefs, [...expectedReads, f.body.ref]);

  for (const [index, ref] of expectedReads.entries()) {
    assert.equal(current.dictionary.read(handles[index]!), ref);
    assert.equal(current.dictionary.source(handles[index]!), undefined);
    assert.equal(current.dictionary.citation(handles[index]!, f.original.derivation!.citations[0]!.quote), undefined);
    assert.ok(!current.dictionary.entries.some(row => (row.kind === "source" || row.kind === "span") && row.ref === ref));
    assert.ok(!current.exposure.some(row => row.ref === ref), "A read address does not claim the source body was delivered");
    assert.ok(!legacy.dictionary.entries.some(row => row.kind === "read" && row.ref === ref), "Frozen input v4 grants none of the new locations");
  }

  assert.ok(!current.dictionary.entries.some(row => row.kind === "read" && row.ref === refs.prose), "Do not parse original knowledge prose as navigation");
  const why = "Read original purpose sources before drawing a new conclusion";
  const inspection = { purpose: "Inspect original source bodies", expectedChange: "Recover an original body or retain an accurate unknown",
    refs: handles, maximumChars: 4096 };
  const output = compileCentralLearningChange({ checkpoint: current.view.checkpoint, changes: [], explanation: why, inspect: inspection },
    request, current.dictionary, CENTRAL_CHANGE_INPUT_VERSION);

  assert.deepEqual(output.agendaRead?.refs, expectedReads);
  assert.deepEqual(decodeCentralDeliberation(output, request, [], CENTRAL_CHANGE_INPUT_VERSION), output);
  assert.throws(() => decodeCentralDeliberation(output, request, [], V4), /central_deliberation_read_unbound/);

  const rawChange = { action: "read", checkpoint: current.view.checkpoint, why, ...inspection };
  const encoding = encodeCentralDeliberation(request, CENTRAL_ACTION_JSON_FORMAT, [], CENTRAL_CHANGE_INPUT_VERSION);
  const funding = { role: "user" as const, content: canonicalJson({ role: "host_original_root_after_this_computation_reservation",
    budgetId: request.budgetId, limits: request.resources.limits, occupied: { tokens: 10000, calls: 1, steps: 1 },
    available: { tokens: 22000, calls: 3, steps: 3 }, status: "available", holdReason: null,
    thisComputation: { reservationId: centralDeliberationReservation(request), maxTokens: 10000, calls: 1, steps: 1 },
    interpretation: "current_root_resources_not_new_authorization_or_value_prediction" }) };
  const wire = { ...encoding.wire, messages: [...encoding.messages, funding], maxOutputTokens: 8192 };
  const proof = buildCentralDeliberationWireEvidence({ request, output, rawChange, format: CENTRAL_ACTION_JSON_FORMAT, wire });
  assert.ok(proof);
  assert.equal(proof.inputVersion, CENTRAL_CHANGE_INPUT_VERSION);
  assert.equal(isCentralDeliberationWireEvidence(proof, request, output), true);
  assert.equal(isCentralDeliberationWireEvidence({ ...proof, inputVersion: V4 }, request, output), false,
    "Changing only the version marker cannot preserve a decision that uses v5-only read locations");
  assert.equal(canonicalJson(request), before);
  assert.deepEqual(request.state.intents, [], "Advertising sources does not resume the archived purpose");
});

test("purpose source reads require a complete original in this delivery rather than state, a current purpose or ordinary JSON", () => {
  const f = fixture(), request = f.request();

  noInheritedReads({ ...request, materials: [], state: { ...request.state, materials: [f.body] } });
  assert.equal(centralPurposeSourceReads({ ...request, state: { ...request.state, intents: [f.original] } }).size, 0,
    "A current intent never acquires an archived-original claim; normal visible reads have their own boundary");
  const ordinary: CentralRuntimeMaterial = { ref: "source:ordinary-json", kind: "source", sourceRefs: [],
    text: canonicalJson({ note: JSON.parse(f.body.text), readRef: refs.prose, sourceRefs: expectedReads }) };

  noInheritedReads(f.request([ordinary]));
  const directory = readCentralPurposeMemory(f.archive, "central-runtime-purpose-catalog:0");
  assert.ok(directory);
  noInheritedReads(f.request([directory]));

  for (const end of [32, f.body.text.length]) {
    const page = centralMaterialFromPage({ ref: f.body.ref, originalRef: f.body.ref, originalScope: scope,
      owner: "board", origin: "execution_result", coordinate: { runId: f.body.ref, sequence: 1 }, sourceHash: contentHashOf(f.body.text),
      start: 0, end, totalChars: f.body.text.length, text: f.body.text.slice(0, end) });
    noInheritedReads(f.request([page]));
  }
});

test("conflicting original claims and malformed owner envelopes confer no inherited source reads", () => {
  const f = fixture();
  const revised: CentralLearningIntentDraft = { ...f.original, revisionReason: "A later original revision retained a different source",
    sourceRefs: ["source:later-original"] };
  const later = { ...buildCentralRuntimeRecord({ previousRef: f.compacted.id, state: { ...f.cursor.state, intents: [revised] },
    reason: "Original owner revised the ended purpose", sourceRefs: revised.sourceRefs }), sequence: 3 };
  const compacted = { ...buildCentralRuntimeRecord({ previousRef: later.id, state: f.empty,
    reason: "Compact the later original version", sourceRefs: [] }), sequence: 4 };
  const facts = [...f.facts, later, compacted], latest = readCentralRuntimeRecords(facts, scope, 4);
  const ref = `central-runtime-purpose-record:${contentHashOf([revised.intentId, later.id])}`;
  const body = readCentralPurposeMemory({ facts, scope, boardSequence: 4 }, ref);
  assert.ok(body);
  const conflicting = { ...f.request([f.body, body]), boardSequence: latest.revision, stateRef: latest.stateRef, state: latest.state,
    resources: { ...f.request().resources, boardSequence: latest.revision } };

  noInheritedReads(conflicting);
  const malformed: readonly CentralRuntimeMaterial[] = [
    { ...f.body, ref: "material:unowned-original-body" },
    { ...f.body, ref: `central-runtime-purpose-record:${contentHashOf("different original locator")}` },
    { ...f.body, kind: "source" },
    { ...f.body, sourceRefs: [f.original.intentId] },
    { ...f.body, text: ` ${f.body.text}` },
  ];

  for (const material of malformed) noInheritedReads(f.request([material]));
});

test("input v5 normal visible purpose sources remain readable without source bodies, while active navigation requires complete originals", () => {
  const f = fixture();
  const live: CentralLearningIntentDraft = { ...f.original, revisionReason: "Continue reviewing the original source boundary",
    continuation: { kind: "ready", operation: { kind: "think", operationId: "operation:live-purpose-next",
      purpose: "Assess the original unresolved boundary", expectedChange: "Choose a useful next investigation", sourceRefs: [] } } };
  const liveFact = { ...buildCentralRuntimeRecord({ previousRef: f.compacted.id, state: { ...f.cursor.state, intents: [live] },
    reason: "Retain the normal live purpose", sourceRefs: live.sourceRefs }), sequence: 3 };
  const cursor = readCentralRuntimeRecords([...f.facts, liveFact], scope, 3);
  const normal: CentralDeliberationRequest = { ...f.request([]), boardSequence: cursor.revision, stateRef: cursor.stateRef, state: cursor.state,
    resources: { ...f.request().resources, boardSequence: cursor.revision } };
  const before = canonicalJson(normal), current = createCentralChangeView(normal, V5), legacy = createCentralChangeView(normal, V4);
  // This first assertion proves the missing normal-path bridge on unmodified R1.
  const handles = expectedReads.map(ref => readHandle(current, ref));

  assert.equal(centralPurposeSourceReads(normal).size, 0, "The original archived helper does not own live purposes");
  assert.deepEqual(current.exposure, [], "The source bodies are genuinely absent");
  assert.ok(Array.isArray(current.view.agenda));
  const currentIntent = current.view.agenda[0];

  assert.ok(currentIntent !== null && typeof currentIntent === "object" && !Array.isArray(currentIntent));
  const sourceReads = expectedReads.map((address, index) => {
    const source = current.dictionary.entries.find(row => row.kind === "reference" && row.ref === address);
    assert.ok(source);
    assert.equal(current.dictionary.source(source.handle), address);
    return { sourceRef: source.handle, handle: handles[index]!, address };
  });

  assert.deepEqual(currentIntent.sourceReads, sourceReads);
  assert.ok(Array.isArray(legacy.view.agenda));
  const oldIntent = legacy.view.agenda[0];

  assert.ok(oldIntent !== null && typeof oldIntent === "object" && !Array.isArray(oldIntent));
  assert.equal(Object.hasOwn(oldIntent, "sourceReads"), false);

  for (const [index, ref] of expectedReads.entries()) {
    assert.ok(!legacy.dictionary.entries.some(row => row.kind === "read" && row.ref === ref));
    assert.equal(current.dictionary.read(handles[index]!), ref);
    assert.equal(current.dictionary.source(handles[index]!), undefined);
    assert.equal(current.dictionary.citation(handles[index]!, "An exact retained report sentence."), undefined);
    assert.ok(!current.dictionary.entries.some(row => (row.kind === "source" || row.kind === "span") && row.ref === ref));
  }

  assert.ok(!current.dictionary.entries.some(row => row.kind === "read" && row.ref === refs.prose));
  const output = compileCentralLearningChange({ checkpoint: current.view.checkpoint, changes: [],
    explanation: "Read original source bodies without asserting their unavailable contents", inspect: {
      purpose: "Read the visible purpose's original sources", expectedChange: "Obtain a body or preserve the original unknown",
      refs: handles, maximumChars: 4096 } }, normal, current.dictionary, V5);

  assert.deepEqual(output.agendaRead?.refs, expectedReads);
  assert.deepEqual(decodeCentralDeliberation(output, normal, [], V5), output);
  assert.deepEqual(output.intents[0]?.knowledge, live.knowledge);

  const navigation: CentralDeliberationRequest = { ...normal, activePurposeDelivery: { version: "active-purpose-navigation-v2",
    agendaVersion: activePurposeAgendaVersion(normal.state.intents), maximumEntries: 1 } };
  const hidden = createCentralChangeView(navigation, V5);

  assert.deepEqual(readActivePurposeDelivery(navigation).visibleIntents, []);

  for (const ref of expectedReads) assert.ok(!hidden.dictionary.entries.some(row => row.kind === "read" && row.ref === ref));

  const body = createActivePurposeOriginal(scope, live), complete = { ...navigation, materials: [body] };
  const opened = createCentralChangeView(complete, V5);

  assert.deepEqual(readActivePurposeDelivery(complete).visibleIntents, [live]);
  assert.deepEqual(renderedReads(opened, body.ref), [...expectedReads, body.ref]);
  const fragment = (start: number, end: number): CentralRuntimeMaterial => {
    const text = body.text.slice(start, end);
    return { ref: `central-runtime-fragment:${contentHashOf([body.ref, start, text])}`, kind: "work_result", sourceRefs: [body.ref],
      text: canonicalJson({ originalRef: body.ref, start, end, totalChars: body.text.length, text,
        nextRef: end === body.text.length ? null : `central-runtime-page:${end}:${encodeURIComponent(body.ref)}` }) };
  };
  const middle = Math.floor(body.text.length / 2), first = fragment(0, middle), last = fragment(middle, body.text.length);
  const partial = { ...navigation, materials: [first] }, partialInput = createCentralChangeView(partial, V5);

  assert.deepEqual(readActivePurposeDelivery(partial).visibleIntents, []);

  for (const ref of expectedReads) assert.ok(!partialInput.dictionary.entries.some(row => row.kind === "read" && row.ref === ref));

  const assembled = { ...navigation, materials: [first, last] }, assembledInput = createCentralChangeView(assembled, V5);

  assert.deepEqual(readActivePurposeDelivery(assembled).visibleIntents, [live]);
  assert.deepEqual(renderedReads(assembledInput, last.ref), [...expectedReads, last.ref]);
  assert.ok(assembledInput.exposure.find(row => row.ref === first.ref)?.readRefs.every(ref => !expectedReads.includes(ref)));
  assert.equal(canonicalJson(normal), before, "Projection preserves the live intent, original knowledge and source references");
});
