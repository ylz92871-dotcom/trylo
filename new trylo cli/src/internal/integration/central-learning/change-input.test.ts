import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import type { OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { createCentralChangeView, CENTRAL_CHANGE_INPUT_VERSION, type CentralChangeInput } from "./change-input.js";
import type { CentralInputKind } from "./deliberation-input-dictionary.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { createOrganizationKnowledgeView } from "./organization-publication-view.js";
import { readCentralPurposeMemory } from "./runtime-purpose-memory.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";

const scope = "workspace:change-input", originalRef = "source:original";
const prose = "Keep source:original literally inside this original body; the receiver requires its declared unit.";
const original: CentralRuntimeMaterial = { ref: originalRef, kind: "source", text: prose, sourceRefs: ["receipt:original"] };

function request(materials: readonly CentralRuntimeMaterial[] = [original]): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:change-input", boardSequence: 7, stateRef: "state:change-input",
    configuration: { schemaVersion: 1, configurationRef: "configuration:change-input", authorizationRef: "authorization:change-input",
      thoughtMaxTokens: 12000, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20000,
        maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 } },
    resources: { boardSequence: 7, budgetId: "budget:change-input", limits: { tokens: 24000, calls: 4, steps: 4 },
      occupied: { tokens: 4000, calls: 2, steps: 2 }, available: { tokens: 20000, calls: 2, steps: 2 },
      status: "held", holdReason: "original_reservation_requires_inspection" },
    state: { schemaVersion: 1, scope, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    materials, organization: [], opportunities: [], operation: { kind: "think", operationId: "operation:change-input",
      purpose: "Compare the actual receiver conditions.", expectedChange: "Retain the original premise and unresolved boundary.", sourceRefs: materials.map(row => row.ref) } };
}

function handle(input: CentralChangeInput, kind: CentralInputKind, ref: string): string {
  const row = input.dictionary.entries.find(entry => entry.kind === kind && entry.ref === ref);
  assert.ok(row, `missing ${kind} capability for ${ref}`);
  return row.handle;
}

function strings(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

function fragment(text: string, runId = "session:original-fragment"): CentralRuntimeMaterial {
  return centralMaterialFromPage({ ref: "source:read-receiver", originalRef: "source:receiver", originalScope: scope,
    origin: "execution_result", coordinate: { runId, sequence: 9 }, sourceHash: contentHashOf(text),
    start: 0, end: text.length, totalChars: text.length, text, owner: "session" });
}

test("change input delivers an exact original body once without replacing identifiers inside its prose", () => {
  const input = request(), before = structuredClone(input);
  const repeated = { ...input, organization: [structuredClone(original)], state: { ...input.state, materials: [structuredClone(original)] } };
  const rendered = createCentralChangeView(repeated);

  assert.equal(rendered.version, CENTRAL_CHANGE_INPUT_VERSION);
  assert.equal(strings(rendered.view).filter(value => value === prose).length, 1);
  const message = rendered.messages[0];
  assert.ok(message);
  assert.equal(message.role, "user");
  assert.equal(typeof message.content, "string");
  const delivered: unknown = JSON.parse(message.content as string);

  assert.deepEqual(delivered, rendered.view);
  assert.equal(strings(delivered).filter(value => value === prose).length, 1);
  assert.deepEqual(input, before, "rendering must not rewrite the source request");
  assert.deepEqual(rendered.exposure.filter(row => row.ref === originalRef), [{ ref: originalRef, kind: "body",
    textHash: contentHashOf(prose), readRefs: [originalRef] }]);
  assert.equal(rendered.dictionary.source(handle(rendered, "source", originalRef)), originalRef);
  const conflict = { ...input, organization: [{ ...original, text: "A different body cannot borrow the original identity." }] };

  assert.throws(() => createCentralChangeView(conflict), /central_deliberation_material_identity_conflict/);
});

test("typed public source handles bind owned original bodies and completed operations without granting unseen sources or quotation evidence", () => {
  const base = request([]), completed = { intentId: "central:agenda", operation: { kind: "read" as const,
    operationId: "operation:completed-original", purpose: "Read the original condition", expectedChange: "Observe its actual body",
    sourceRefs: ["evidence:completed-original"], refs: ["address:completed-original"], maximumChars: 2048 },
    outcome: "returned" as const, resultRefs: ["result:completed-original"], publicResult: "The original read returned." };
  const input = { ...base, state: { ...base.state, materials: [original], completed: [completed] } };
  const rendered = createCentralChangeView(input);
  const refs = [original.ref, ...original.sourceRefs, completed.operation.operationId, ...completed.operation.sourceRefs,
    ...completed.operation.refs, completed.intentId, ...completed.resultRefs, input.scope, input.configuration.configurationRef,
    input.configuration.authorizationRef];
  for (const ref of refs) {
    const entry = rendered.dictionary.entries.find(row => row.ref === ref && ["source", "reference", "operation"].includes(row.kind));
    assert.ok(entry, `the renderer must actually advertise ${ref}`);
    const output = compileCentralLearningChange({ checkpoint: rendered.view.checkpoint, changes: [], sources: [entry.handle],
      explanation: "Retain the actually delivered identity without claiming independent benefit." }, input, rendered.dictionary);
    assert.deepEqual(decodeCentralDeliberation(output, input, []).sourceRefs, [ref]);
    assert.throws(() => decodeCentralDeliberation({ ...output, sourceRefs: ["source:never-delivered"] }, input, []),
      /central_deliberation_source_unbound/);
  }
  assert.equal(rendered.dictionary.citation(handle(rendered, "operation", completed.operation.operationId), "The original read returned."), undefined,
    "a known operation identity is not original quotation evidence");
});

test("previous returned source reads remain reopenable after an intervening purpose read without becoming evidence", () => {
  const original = request([]), catalog = "central-business-catalog:previous", pending = "source:unconfirmed", thought = "result:old-thought";
  const read = { intentId: "central:agenda", operation: { kind: "read" as const, operationId: "read:previous-business",
    purpose: "Inspect the actual business handback", expectedChange: "Locate its original feedback", refs: [catalog], sourceRefs: [], maximumChars: 4000 },
    outcome: "returned" as const, resultRefs: [catalog], publicResult: "The original directory returned" };
  const input: CentralDeliberationRequest = { ...original, state: { ...original.state, completed: [read,
    { ...read, operation: { ...read.operation, operationId: "read:unconfirmed" }, outcome: "unknown", resultRefs: [pending] },
    { ...read, operation: { kind: "think", operationId: "think:previous", purpose: "Inspect an uncertainty",
      expectedChange: "Choose the next step", sourceRefs: [] }, resultRefs: [thought] }] } };
  const rendered = createCentralChangeView(input);
  const address = rendered.dictionary.entries.find(row => row.kind === "read" && row.ref === catalog);

  assert.ok(address, "the model must be able to reopen an actual prior read after its body leaves the current delivery");
  assert.equal(rendered.dictionary.read(address.handle), catalog);
  assert.equal(rendered.dictionary.citation(address.handle, "The original directory returned"), undefined);
  assert.ok(!rendered.dictionary.entries.some(row => row.kind === "read" && [pending, thought].includes(row.ref)));
  assert.deepEqual(rendered.exposure, [], "history is a read location, not an exposure of the original body");
  const view = JSON.stringify(rendered.view.completed);

  assert.ok(view.includes('"resultReads"') && view.includes(address.handle) && view.includes(catalog));
  const frozen = createCentralChangeView(input, "central-learning-change-input-v5");

  assert.ok(!frozen.dictionary.entries.some(row => row.kind === "read" && row.ref === catalog));
  assert.ok(!JSON.stringify(frozen.view.completed).includes('"resultReads"'), "v5 receipts keep their original read menu");
});

test("navigation and control remain readable locations rather than quotation evidence, and capability kinds stay distinct", () => {
  const nextRef = "source:unread-contract", preview = "A directory preview is not a returned receiver contract.";
  const navigationText = canonicalJson({ role: "original_domain_feedback_catalog_not_read_body", readRef: nextRef, preview });
  const navigation: CentralRuntimeMaterial = { ref: `central-runtime-domain-catalog:${contentHashOf(navigationText)}`, kind: "source", sourceRefs: [],
    text: navigationText };
  const control: CentralRuntimeMaterial = { ref: "central-semantic-attempt:one", kind: "work_result", sourceRefs: [],
    text: canonicalJson({ type: "original_semantic_attempt", operationId: "operation:prior", issuedAt: "2026-11-05T00:00:00Z" }) };
  const rendered = createCentralChangeView(request([original, navigation, control]));
  const source = handle(rendered, "source", originalRef), read = handle(rendered, "read", originalRef);

  assert.notEqual(source, read);
  assert.equal(rendered.dictionary.read(source), undefined);
  assert.equal(rendered.dictionary.source(read), undefined);
  assert.equal(rendered.dictionary.citation(read, prose), undefined);
  assert.equal(rendered.dictionary.citation(source), undefined, "a direct source citation still requires its explicit quote");
  assert.deepEqual(rendered.dictionary.citation(source, prose), { evidenceRef: originalRef, quote: prose });
  const advertised = handle(rendered, "read", nextRef);

  assert.equal(rendered.dictionary.read(advertised), nextRef);
  assert.equal(rendered.dictionary.source(advertised), undefined);
  assert.equal(rendered.dictionary.citation(advertised, preview), undefined);

  for (const row of [navigation, control]) {
    const location = handle(rendered, "reference", row.ref);
    assert.equal(rendered.dictionary.citation(location, preview), undefined);
    assert.equal(rendered.dictionary.citation(location), undefined);
    assert.ok(!rendered.dictionary.entries.some(entry => entry.kind === "span" && entry.ref === row.ref));
    assert.notEqual(rendered.exposure.find(entry => entry.ref === row.ref)?.kind, "body");
  }

  assert.ok(!rendered.exposure.some(row => row.ref === nextRef), "advertising an address does not expose its unseen body");
});

test("only an authenticated actual fragment with one literal occurrence receives an optional default quotation", () => {
  const quote = "Receiver numeric_seconds requires exactly one numeric field.", actual = fragment(quote);
  const repeated = fragment("Repeated exact fragment", "Repeated exact fragment");
  const escaped = fragment('The actual receiver says "numeric_seconds".\nPreserve this newline.');
  const forged = { ...actual, text: actual.text.replace("execution_result", "user_statement") };
  const rendered = createCentralChangeView(request([original, actual, repeated, escaped]));
  const span = handle(rendered, "span", actual.ref);

  assert.deepEqual(rendered.dictionary.citation(span), { evidenceRef: actual.ref, quote });
  assert.deepEqual(rendered.dictionary.citation(span, "numeric_seconds"), { evidenceRef: actual.ref, quote: "numeric_seconds" });
  assert.equal(rendered.dictionary.citation(handle(rendered, "source", actual.ref)), undefined);
  assert.equal(rendered.dictionary.citation(span, "The receiver accepts any invented field."), undefined);

  for (const row of [original, repeated, escaped]) {
    assert.ok(!rendered.dictionary.entries.some(entry => entry.kind === "span" && entry.ref === row.ref));
    assert.equal(rendered.dictionary.citation(handle(rendered, "source", row.ref)), undefined);
  }

  const untrusted = createCentralChangeView(request([forged]));

  assert.ok(!untrusted.dictionary.entries.some(entry => entry.kind === "span"));
  assert.equal(untrusted.dictionary.citation(handle(untrusted, "reference", forged.ref), quote), undefined,
    "a stale source-page identity cannot authenticate edited transport metadata");
});

test("unknown handles and mismatched checkpoint bindings are rejected when short handles are reused", () => {
  const actual = fragment("A unique observed boundary."), input = request([actual]), rendered = createCentralChangeView(input);
  const span = handle(rendered, "span", actual.ref), read = handle(rendered, "read", actual.ref);

  assert.doesNotThrow(() => rendered.dictionary.assertRequest(structuredClone(input)));

  for (const unknown of ["b-unknown", actual.ref]) {
    assert.equal(rendered.dictionary.source(unknown), undefined);
    assert.equal(rendered.dictionary.read(unknown), undefined);
    assert.equal(rendered.dictionary.citation(unknown, "A unique observed boundary."), undefined);
  }

  const changed = { ...input, boardSequence: input.boardSequence + 1, stateRef: "state:changed" };

  assert.throws(() => rendered.dictionary.assertRequest(changed), /central_input_checkpoint_mismatch/);
  const next = createCentralChangeView(changed);
  assert.notEqual(next.checkpoint, rendered.checkpoint);
  assert.equal(next.dictionary.read(read), actual.ref, "short handles belong to their current checkpoint and may reuse a spelling");
  assert.equal(next.dictionary.citation(span)?.evidenceRef, actual.ref);
  assert.throws(() => next.dictionary.assertRequest(input), /central_input_checkpoint_mismatch/);
  assert.throws(() => compileCentralLearningChange({ checkpoint: rendered.view.checkpoint, changes: [], explanation: "Read the current source",
    inspect: { purpose: "Inspect the current source", expectedChange: "Observe its actual boundary", refs: [read], maximumChars: 2048 } },
  changed, next.dictionary), (error: unknown) => error instanceof CentralDeliberationError
    && error.semanticRejection?.cause === "checkpoint_mismatch");
  Object.assign(input.materials[0]!, { text: "The original request was mutated after binding." });
  assert.throws(() => rendered.dictionary.assertRequest(input), /central_input_checkpoint_mismatch/);
});

test("existing purposes, exact resource limits and the PA ordinary-work constraint survive the public projection", () => {
  const constraint: CentralRuntimeMaterial = { ref: "central-runtime-constraint:current", kind: "source", sourceRefs: [],
    text: canonicalJson({ role: "PA_current_constraint_not_business_evidence", issueId: "issue:ordinary",
      decision: { kind: "ordinary_execution", reason: "The original task stays ordinary; a comparison is still only a hypothesis.",
        sourceRefs: [originalRef], revision: 2, decidedAt: "2026-11-05T00:00:00Z" } }) };
  const input = request([original, constraint]);
  const intent = { intentId: "intent:existing", subject: { plane: "central" as const, questionRef: "question:existing" },
    goal: "Learn when the original unit must survive.", rationale: "The goal remains unresolved after the first actual use.",
    conditions: ["The receiver declares value and unit."], knowledge: [{ statement: "The original request has a declared unit.",
      conditions: "This receiver contract only.", sourceRefs: [originalRef] }], residual: ["A numeric-only receiver may require conversion."],
    commitment: { purpose: "Keep the boundary question open.", assumptions: ["A receiver contract is available."],
      reconsiderWhen: ["A real contrary interface is read."] }, revisionReason: "Retain the existing public commitment.", sourceRefs: [originalRef],
    continuation: { kind: "waiting" as const, wait: { kind: "facts" as const, reason: "Wait for an actual contrary receiver.", sourceRefs: [originalRef] } } };
  const queued = { kind: "read" as const, operationId: "operation:queued-original", purpose: "Read the original receiver.",
    expectedChange: "Expose its body without inventing a purpose.", sourceRefs: [originalRef],
    refs: ['session-address:{"journalSequence":105,"sessionId":"real-case-a"}'], maximumChars: 2048 };
  const ready = { ...input, state: { ...input.state, intents: [intent], agendaRead: queued }, opportunities: [{ subject: { plane: "agent" as const,
    domain: "workflow" as const, issueId: "issue:ordinary" }, sourceRef: "opportunity:original", description: "The original handoff remains ordinary work.",
    constraints: ["Do not recast PA ordinary work as a research grant."] }] };
  const rendered = createCentralChangeView(ready), resources = rendered.view.resources;

  assert.ok(resources !== null && typeof resources === "object" && !Array.isArray(resources));
  const resourceObject = resources as Readonly<Record<string, unknown>>;

  assert.deepEqual(resourceObject.limits, ready.resources.limits);
  assert.deepEqual(resourceObject.occupied, ready.resources.occupied);
  assert.deepEqual(resourceObject.available, ready.resources.available);
  assert.equal(resourceObject.status, ready.resources.status);
  assert.equal(resourceObject.holdReason, ready.resources.holdReason);
  assert.deepEqual(rendered.dictionary.intent(handle(rendered, "intent", intent.intentId)), intent);

  for (const text of [intent.goal, intent.rationale, intent.residual[0], intent.commitment.purpose, intent.continuation.wait.reason,
    ready.opportunities[0]!.constraints[0], constraint.text]) assert.ok(strings(rendered.view).includes(text!));

  assert.equal(rendered.dictionary.citation(handle(rendered, "reference", constraint.ref), "ordinary_execution"), undefined);
  assert.equal(strings(rendered.view).filter(value => value === constraint.text).length, 1);
  assert.ok(strings(rendered.view.pendingRead).includes(queued.refs[0]!));
  assert.ok(strings(rendered.view.pendingRead).includes("Original queued read, not a learning purpose or a delivered body. Do not issue it again."));
  assert.equal(rendered.dictionary.intent(handle(rendered, "operation", queued.operationId)), undefined);
});

test("each original organization body exposes its own usable fact capability without promoting an unpaired locator", () => {
  const feedback = ["value and unit", "numeric seconds"].map((condition, index) => {
    const value: OrganizationFeedback = { kind: "feedback", decisionRef: `decision:receiver:${index}`,
      unitRef: `source:receiver:${index}`, supersedes: null, sourceRefs: [`source:receiver:${index}`],
      result: { kind: "correction", statement: `The actual receiver requires ${condition}.`, conditions: `Receiver ${index} only.` } };
    const factId = buildOrganizationRecord(scope, value).id;
    return { factId, material: createOrganizationFeedbackMaterial(scope, factId, value) };
  });
  const knowledge = feedback.map((source, index) => {
    const value: OrganizationKnowledge = { kind: "knowledge", knowledgeId: `knowledge:receiver:${index}`, supersedes: null,
      statement: `Check receiver ${index}'s declared representation before transferring the value.`, conditions: `Receiver ${index} only.`,
      conditionKeys: [`receiver:${index}`], exceptions: "A different receiver needs its own contract.", exceptionKeys: [],
      implication: "Read the receiver contract before choosing the representation.", supportFactIds: [source.factId],
      counterexampleFactIds: [], state: "proposed" };
    const factId = buildOrganizationRecord(scope, value).id;

    return { factId, value, material: createOrganizationKnowledgeView(scope, { factId, sequence: index + 1, value }) };
  });
  const unseen: OrganizationKnowledge = { ...knowledge[0]!.value, knowledgeId: "knowledge:unread-receiver",
    statement: "This head was not supplied to the model." };
  const unseenFact = buildOrganizationRecord(scope, unseen).id;
  const unseenView = createOrganizationKnowledgeView(scope, { factId: unseenFact, sequence: 3, value: unseen });
  const locatorText = canonicalJson({ role: "organization_knowledge_revision_locator_not_read_body", factId: unseenFact,
    knowledgeId: unseen.knowledgeId, bodyHash: contentHashOf(unseenView.text), originalRef: unseenView.ref,
    fragmentRef: "organization-publication-fragment:unread", fragmentHash: contentHashOf("unread fragment"),
    pageReadRef: "source:unread-knowledge-page" });
  const locator: CentralRuntimeMaterial = { ref: `organization-knowledge-revision-locator:${contentHashOf({ scope, text: locatorText })}`,
    kind: "organization", text: locatorText, sourceRefs: [unseenFact] };
  const rendered = createCentralChangeView({ ...request(), organization: [
    ...feedback.map(row => row.material), ...knowledge.map(row => row.material), locator] });
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const rows = rendered.view.materials;
  assert.ok(Array.isArray(rows));
  const capabilities = (material: CentralRuntimeMaterial) => {
    const row = rows.map(record).find(value => value.text === material.text);
    assert.ok(row, "the actual body must be present");
    assert.ok(Array.isArray(row.reads));
    for (const value of row.reads) { const read = record(value);
    assert.equal(typeof read.handle, "string");
      assert.equal(rendered.dictionary.read(read.handle as string), read.address); }
    assert.ok(Array.isArray(row.capabilities));
    return row.capabilities.map(record);
  };

  for (const source of feedback) {
    const offered = capabilities(source.material).filter(row => row.kind === "feedback");
    assert.equal(offered.length, 1);
    assert.equal(offered[0]!.factId, source.factId);
    const offeredHandle = offered[0]!.handle;
    assert.equal(typeof offeredHandle, "string");
    assert.equal(rendered.dictionary.feedback(offeredHandle as string), source.factId);
    assert.equal(rendered.dictionary.knowledge(offeredHandle as string), undefined);
  }

  for (const source of knowledge) {
    const offered = capabilities(source.material).filter(row => row.kind === "knowledge");
    assert.equal(offered.length, 1);
    assert.equal(offered[0]!.factId, source.factId);
    assert.equal(offered[0]!.knowledgeId, source.value.knowledgeId);
    const offeredHandle = offered[0]!.handle;
    assert.equal(typeof offeredHandle, "string");
    assert.deepEqual(rendered.dictionary.knowledge(offeredHandle as string), { factId: source.factId, knowledge: source.value });
    assert.equal(rendered.dictionary.feedback(offeredHandle as string), undefined);
  }

  assert.deepEqual(capabilities(locator), [], "an unpaired locator offers no full knowledge or feedback identity");
  assert.ok(!rendered.dictionary.entries.some(row => row.kind === "organization_revision" && row.ref === unseenFact));
  assert.equal(rendered.dictionary.knowledge(handle(rendered, "reference", unseenFact)), undefined);
});

test("an exact archived open purpose offers its original intent capability while navigation, withdrawal and stale bodies cannot replace live state", () => {
  const originalIntent: CentralLearningIntentDraft = { intentId: "intent:archived-open",
    subject: { plane: "central", questionRef: "question:archived-open" }, goal: "Resolve the original receiver boundary.",
    rationale: "The original source left one condition unanswered.", conditions: ["The receiver declares a representation."],
    knowledge: [{ statement: "The original receiver used value and unit.", conditions: "That receiver only.", sourceRefs: [originalRef] }],
    residual: ["Would a numeric-only receiver require a different transfer?"], commitment: { purpose: "Resolve this original boundary.",
      assumptions: ["A contrary real contract may be read."], reconsiderWhen: ["An actual contrary contract arrives."] },
    revisionReason: "This investment stopped with its original question open.", sourceRefs: [originalRef],
    continuation: { kind: "ended", goalState: "open", reason: "The original allowance ended before the goal was answered." } };
  const withdrawn: CentralLearningIntentDraft = { ...originalIntent, intentId: "intent:archived-withdrawn",
    subject: { plane: "central", questionRef: "question:archived-withdrawn" },
    continuation: { kind: "ended", goalState: "withdrawn", reason: "The owner withdrew this purpose." } };
  const initial = emptyCentralRuntimeState(scope);
  const first = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...initial, intents: [originalIntent, withdrawn] }, reason: "Original ended purpose bodies", sourceRefs: [originalRef] }), sequence: 1 };
  const compacted = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: initial,
    reason: "Compact the original ended purposes", sourceRefs: [] }), sequence: 2 };
  const archive = { facts: [first, compacted], scope, boardSequence: 2 };
  const navigation = readCentralPurposeMemory(archive, "central-runtime-purpose-catalog:0");
  assert.ok(navigation);
  const catalog: unknown = JSON.parse(navigation.text);
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const entries = record(catalog).entries;
  assert.ok(Array.isArray(entries));
  const exact = (intentId: string) => {
    const entry = entries.map(record).find(row => row.intentId === intentId);
    assert.ok(entry);
    assert.equal(typeof entry.readRef, "string");
    const material = readCentralPurposeMemory(archive, entry.readRef as string);
    assert.ok(material);
    return material;
  };
  const body = exact(originalIntent.intentId), withdrawnBody = exact(withdrawn.intentId);
  const links = (rendered: CentralChangeInput, material: CentralRuntimeMaterial) => {
    const materials = rendered.view.materials;
    assert.ok(Array.isArray(materials));
    const row = materials.map(record).find(value => value.text === material.text);
    assert.ok(row);
    return Array.isArray(row.intents) ? row.intents.map(record) : [];
  };
  const rendered = createCentralChangeView(request([body]));
  const offered = links(rendered, body);

  assert.equal(offered.length, 1, "the actually delivered open archive must advertise its usable original intent beside that body");
  assert.equal(offered[0]!.intentId, originalIntent.intentId);
  assert.equal(offered[0]!.authority, "delivered_archive");
  const archivedHandle = offered[0]!.handle;
  assert.equal(typeof archivedHandle, "string");
  assert.deepEqual(rendered.dictionary.intent(archivedHandle as string), originalIntent);

  for (const material of [navigation, withdrawnBody]) {
    const unavailable = createCentralChangeView(request([material]));
    assert.deepEqual(links(unavailable, material), []);
    assert.ok(!unavailable.dictionary.entries.some(row => row.kind === "intent"));
  }

  const live: CentralLearningIntentDraft = { ...originalIntent, goal: "Retain the now revised live receiver boundary.",
    revisionReason: "A new actual contract revised the original public purpose.",
    continuation: { kind: "waiting", wait: { kind: "facts", reason: "Wait for the next real observation.", sourceRefs: [originalRef] } } };
  const input = request([body]), current = createCentralChangeView({ ...input, state: { ...input.state, intents: [live] } });
  const currentLinks = links(current, body);
  assert.equal(currentLinks.length, 1);
  assert.equal(currentLinks[0]!.intentId, live.intentId);
  assert.equal(currentLinks[0]!.authority, "current_live_state");
  const currentHandle = currentLinks[0]!.handle;
  assert.equal(typeof currentHandle, "string");
  assert.deepEqual(current.dictionary.intent(currentHandle as string), live, "a delivered stale archive cannot overwrite the current same-ID intent");
});
