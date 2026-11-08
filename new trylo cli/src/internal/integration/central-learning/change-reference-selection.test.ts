import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationFeedback, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralChangeView, type CentralChangeInput } from "./change-input.js";
import { C18_CENTRAL_CHANGE_INPUT_VERSION, LEGACY_CENTRAL_CHANGE_INPUT_VERSION,
  PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { CentralInputDictionaryError, createCentralInputDictionary, resolveCentralInputHandle, type CentralInputKind } from "./deliberation-input-dictionary.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { centralMaterialNavigation } from "./deliberation-navigation.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { CENTRAL_REFERENCE_SELECTION_CONTRACT_REF, createCentralReferenceSelectionCapability,
  isCentralChangeReferenceRejection, readCentralReferenceSelectionCapability,
  type CentralChangeReferenceCategory, type CentralChangeReferenceRejection } from "./change-reference-contract.js";

const SCOPE = "workspace:c19-reference-selection", ORIGINAL = "source:c19-original", UNREAD = "source:c19-unread";
const QUOTE = "The receiver preserves the source unit until it explicitly requests a conversion.";
const SOURCE_KINDS: readonly CentralInputKind[] = ["source", "reference", "span", "intent", "operation", "opportunity",
  "organization_recall", "organization_feedback", "organization_revision", "organization_knowledge"];

function request(scope = SCOPE): CentralDeliberationRequest {
  const body = centralMaterialFromPage({ ref: ORIGINAL, originalRef: ORIGINAL, originalScope: scope,
    origin: "user_statement", owner: "session", coordinate: { runId: "session:c19-original", sequence: 2 },
    start: 0, end: QUOTE.length, totalChars: QUOTE.length, text: QUOTE, sourceHash: contentHashOf(QUOTE) });
  const unread: CentralRuntimeMaterial = { ref: UNREAD, kind: "source", text: "Another original remains unread.", sourceRefs: [] };
  const navigation = centralMaterialNavigation(unread, { priority: 5, navigationOnly: false, companionRefs: [] });
  const feedback: OrganizationFeedback = { kind: "feedback", decisionRef: "decision:c19-original", unitRef: "unit:c19-original",
    supersedes: null, sourceRefs: [body.ref], result: { kind: "progress", summary: "An original receiver condition was inspected.",
      remaining: [], resultRefs: [body.ref] } };
  const feedbackId = buildOrganizationRecord(scope, feedback).id;
  const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "knowledge:c19-original", supersedes: null,
    statement: "Inspect the actual receiver condition before choosing a comparison.", conditions: "A unit-bearing handoff.",
    conditionKeys: ["condition:source-unit"], exceptions: "Unseen receiver contracts remain uncertain.", exceptionKeys: [],
    implication: "Read the source before choosing the next inquiry.", supportFactIds: [feedbackId], counterexampleFactIds: [], state: "proposed" };
  const knowledgeId = buildOrganizationRecord(scope, knowledge).id;
  const recall: CentralRuntimeMaterial = { ref: "organization:c19-recall", kind: "organization", sourceRefs: [body.ref],
    text: canonicalJson({ role: "organization_hypotheses_not_business_evidence", entries: [{ factId: knowledgeId, knowledge,
      evidence: [{ factId: feedbackId, sequence: 1, value: feedback }] }] }) };
  const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
    maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 };
  const subject = { plane: "agent" as const, domain: "workflow" as const, issueId: "issue:c19-original" };

  return { schemaVersion: 1, scope, budgetId: "budget:c19-reference", stateRef: "state:c19-reference", boardSequence: 0,
    configuration: { schemaVersion: 1, configurationRef: "configuration:c19-reference", authorizationRef: "authorization:c19-reference", allowance },
    resources: { boardSequence: 0, budgetId: "budget:c19-reference", limits: { tokens: 32000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 32000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, completed: [], running: [], materials: [], consumedSourceRefs: [], intents: [{
      intentId: "intent:c19-original", subject, goal: "Keep the original receiver uncertainty visible.", rationale: "The original purpose is unfinished.",
      conditions: [], knowledge: [], residual: ["A later receiver may request a conversion"],
      commitment: { purpose: "Await a real receiver change", assumptions: [], reconsiderWhen: ["A different receiver contract arrives"] },
      revisionReason: "Retain the original commitment", sourceRefs: [body.ref],
      continuation: { kind: "waiting", wait: { kind: "facts", sourceRefs: [body.ref], reason: "Wait for an original receiver change." } } }] },
    operation: { kind: "think", operationId: "thought:c19-reference", purpose: "Choose the next source-bound inquiry",
      expectedChange: "Keep original meanings while selecting references", sourceRefs: [body.ref] },
    opportunities: [{ subject, sourceRef: body.ref, description: "The original receiver uncertainty remains open.", constraints: [] }],
    materials: [body, navigation, createCentralReferenceSelectionCapability()], organization: [recall] };
}

function handle(input: CentralChangeInput, kind: CentralInputKind, ref?: string): string {
  const entry = input.dictionary.entries.find(row => row.kind === kind && (ref === undefined || row.ref === ref));
  assert.ok(entry);
  return entry.handle;
}

function selectionCode(dictionary: object): string {
  assert.ok("selectionCode" in dictionary);
  assert.equal(typeof dictionary.selectionCode, "string");
  return String(dictionary.selectionCode);
}

function rejected(action: () => unknown, expected: Pick<CentralChangeReferenceRejection, "field" | "expected" | "actual" | "cause">,
  privateValue?: string): void {
  let returned: unknown, thrown: unknown;

  try { returned = action(); } catch (error) { thrown = error; }

  assert.equal(returned, undefined, "a rejected submission cannot return a partially compiled agenda");
  assert.ok(thrown instanceof CentralDeliberationError);
  assert.ok("semanticRejection" in thrown);
  const diagnostic = thrown.semanticRejection;
  assert.ok(isCentralChangeReferenceRejection(diagnostic));
  assert.deepEqual({ field: diagnostic.field, expected: diagnostic.expected, actual: diagnostic.actual, cause: diagnostic.cause }, expected);

  if (privateValue !== undefined) assert.equal(canonicalJson({ message: thrown.message, diagnostic }).includes(privateValue), false);
}

test("v4 selects short typed references through one bound code and rejects the first invalid slot without leaking caller values while legacy encodings remain frozen", () => {
  const input = request(), before = structuredClone(input), delivered = createCentralChangeView(input);

  assert.equal(delivered.dictionary.entries.find(row => row.kind === "source")?.handle, "b1",
    "the actual default v4 renderer uses short per-kind decimal handles");
  assert.equal(delivered.version, "central-learning-change-input-v4");
  const prefixes: Readonly<Record<CentralInputKind, string>> = { source: "b", read: "r", intent: "i", operation: "o", opportunity: "p",
    organization_recall: "c", organization_feedback: "f", organization_knowledge: "k", organization_revision: "v", reference: "e", span: "s" };

  for (const kind of Object.keys(prefixes) as CentralInputKind[]) {
    const entries = delivered.dictionary.entries.filter(row => row.kind === kind);
    entries.forEach((entry, index) => assert.equal(entry.handle, `${prefixes[kind]}${index + 1}`));
  }

  assert.equal(handle(delivered, "read"), "r1");
  assert.ok(delivered.dictionary.entries.every(row => /^[briopcfkves][1-9]\d*$/.test(row.handle)));
  assert.match(delivered.dictionary.checkpoint, /^central-input-checkpoint:[a-f0-9]{64}$/);
  const code = selectionCode(delivered.dictionary);
  assert.match(code, /^[a-f0-9]{12}$/);
  assert.equal(selectionCode(delivered.dictionary), code);
  assert.equal(code, delivered.dictionary.checkpoint.slice("central-input-checkpoint:".length, "central-input-checkpoint:".length + 12));
  assert.equal(delivered.checkpoint, delivered.dictionary.checkpoint);
  assert.equal(delivered.view.checkpoint, code);
  assert.equal(canonicalJson(delivered.view).split(code).length - 1, 1, "only one public selection code replaces repeated handle hashes");
  assert.equal(canonicalJson(delivered.view).includes(delivered.dictionary.checkpoint), false);

  const direct = createCentralInputDictionary(input, [{ kind: "source", ref: ORIGINAL }, { kind: "read", ref: UNREAD }]);

  assert.match(direct.entries[0]!.handle, /^b[a-f0-9]{12}_[1-9a-z][0-9a-z]*$/,
    "direct legacy dictionary consumers retain the checkpoint encoding unless explicitly selected otherwise");
  assert.equal(resolveCentralInputHandle(input, direct, direct.entries[0]!.handle, "source"), ORIGINAL);
  const select = delivered.dictionary.selectionHandles;
  assert.equal(typeof select, "function");
  assert.ok(select);
  const categoryKinds: Readonly<Record<CentralChangeReferenceCategory, readonly CentralInputKind[]>> = {
    source: SOURCE_KINDS, read: ["read"], intent: ["intent"], opportunity: ["opportunity"], citation: ["source", "span"],
    recall: ["organization_recall"], knowledge: ["organization_revision"], feedback: ["organization_feedback"],
  };

  for (const category of Object.keys(categoryKinds) as CentralChangeReferenceCategory[]) {
    assert.deepEqual(select(category), delivered.dictionary.entries.filter(row => categoryKinds[category].includes(row.kind)).map(row => row.handle));
  }

  const body = handle(delivered, "source"), span = handle(delivered, "span"), read = handle(delivered, "read", UNREAD);

  assert.equal(select("source").includes(read), false);
  assert.equal(select("read").includes(body), false);
  assert.ok(select("citation").includes(body));
  assert.ok(select("citation").includes(span));

  const capability = createCentralReferenceSelectionCapability();

  assert.equal(capability.ref, CENTRAL_REFERENCE_SELECTION_CONTRACT_REF);
  assert.equal(readCentralReferenceSelectionCapability(capability)?.contractRef, capability.ref);
  assert.equal(delivered.dictionary.referenceSelectionContractRef, capability.ref);
  const materials = delivered.view.materials;
  assert.ok(Array.isArray(materials));
  const capabilityHandle = handle(delivered, "reference", capability.ref);
  const presentedCapability = materials.find(row => row !== null && typeof row === "object" && !Array.isArray(row) && row.handle === capabilityHandle);

  assert.ok(presentedCapability !== null && typeof presentedCapability === "object" && !Array.isArray(presentedCapability));
  assert.equal(presentedCapability.delivery, "control");
  assert.equal(delivered.exposure.find(row => row.ref === capability.ref)?.kind, "control");
  assert.equal(delivered.dictionary.entries.some(row => row.ref === capability.ref
    && ["source", "span", "organization_feedback", "organization_knowledge", "organization_revision"].includes(row.kind)), false);
  assert.equal(readCentralReferenceSelectionCapability({ ...capability, ref: "source:ordinary-forged-capability" }), undefined);
  assert.equal(readCentralReferenceSelectionCapability({ ...capability, sourceRefs: [ORIGINAL] }), undefined);

  const create = { kind: "create" as const, key: "free:purpose-key-δ", subject: "central", goal: "Understand the actual receiver conversion condition.",
    why: "The source states a condition worth comparing with later handoffs.", sources: [body],
    grounding: { relation: "Preserving a source unit and obeying an explicit conversion request are complementary conditions.",
      whenRelevant: "A later handoff contains a unit-bearing quantity.", parents: [body], citations: [{ source: span }] },
    next: { kind: "wait" as const, for: "facts" as const, sources: [body], reason: "Wait for a different original receiver contract." } };
  const valid = { checkpoint: code, changes: [create], explanation: "Use only supplied reference capabilities while retaining free learning content.", sources: [body],
    inspect: { purpose: "Inspect the advertised original", expectedChange: "Obtain its original condition", sources: [body], refs: [read], maximumChars: 1024 },
    organizationUse: { recall: handle(delivered, "organization_recall"), changes: [{ knowledge: handle(delivered, "organization_revision"),
      choice: "timing" as const, before: "Choose a broad comparison", after: "Read the receiver first", reason: "The original hypothesis changes inquiry order." }] },
    organizationKnowledge: [{ kind: "propose" as const, key: "free:organization-key", statement: "Compare explicit receiver conditions before extrapolating.",
      conditions: "A source unit is present.", conditionKeys: ["free:condition-tag/chosen"], exceptions: "Other interfaces remain unknown.",
      implication: "Inspect originals before broader inference.", support: [handle(delivered, "organization_feedback")] }] };
  const compile = (value: unknown) => compileCentralLearningChange(value, input, delivered.dictionary);
  const expanded = decodeCentralDeliberation(compile(valid), input, []), created = expanded.intents.find(row => row.subject.plane === "central");
  assert.ok(created);
  assert.equal(created.derivation?.relation, create.grounding.relation);
  assert.deepEqual(created.derivation?.citations, [{ evidenceRef: delivered.dictionary.source(body), quote: QUOTE }]);
  assert.deepEqual(expanded.agendaRead?.refs, [UNREAD]);
  assert.deepEqual(expanded.organizationKnowledge?.[0]?.conditionKeys, ["free:condition-tag/chosen"]);

  const unknown = "CANARY_UNKNOWN_REFERENCE_C19_DO_NOT_ECHO", badQuote = "CANARY_UNDELIVERED_QUOTATION_C19_DO_NOT_ECHO";

  rejected(() => compile({ ...valid, inspect: { ...valid.inspect, refs: [unknown, body] } }),
    { field: "/inspect/refs/0", expected: ["read"], actual: "unknown", cause: "unknown_handle" }, unknown);
  rejected(() => compile({ ...valid, sources: [read] }),
    { field: "/sources/0", expected: SOURCE_KINDS, actual: "read", cause: "kind_mismatch" });
  rejected(() => compile({ ...valid, changes: [{ ...create, grounding: { ...create.grounding, citations: [{ source: body, quote: badQuote }] } }] }),
    { field: "/changes/0/grounding/citations/0/quote", expected: ["source", "span"], actual: "source", cause: "quote_not_exact" }, badQuote);
  const { checkpoint: _code, ...missingCheckpoint } = valid;

  rejected(() => compile(missingCheckpoint), { field: "/checkpoint", expected: ["checkpoint"], actual: "unknown", cause: "checkpoint_missing" });
  const older = createCentralChangeView({ ...input, stateRef: "state:c19-earlier" });

  rejected(() => compile({ ...valid, checkpoint: selectionCode(older.dictionary) }),
    { field: "/checkpoint", expected: ["checkpoint"], actual: "unknown", cause: "checkpoint_mismatch" });
  assert.throws(() => compileCentralLearningChange(valid, request("workspace:c19-other-scope"), delivered.dictionary), error =>
    error instanceof CentralInputDictionaryError && error.reason === "central_input_checkpoint_mismatch",
  "a dictionary from another scope stops at the original private binding boundary");
  assert.deepEqual(input, before, "neither valid compilation nor rejection changes the original request");

  for (const version of [LEGACY_CENTRAL_CHANGE_INPUT_VERSION, PREVIOUS_CENTRAL_CHANGE_INPUT_VERSION, C18_CENTRAL_CHANGE_INPUT_VERSION] as const) {
    const legacy = createCentralChangeView(input, version);
    assert.ok(legacy.dictionary.entries.every(row => /^[briopcfkves][a-f0-9]{12}_[1-9a-z][0-9a-z]*$/.test(row.handle)));
    assert.equal(legacy.view.checkpoint, legacy.dictionary.checkpoint);
    assert.equal(legacy.checkpoint, legacy.dictionary.checkpoint);
    const optional = { changes: [], explanation: "Retain the original agenda without a legacy optional checkpoint." };
    assert.deepEqual(compileCentralLearningChange(optional, input, legacy.dictionary, version),
      compileCentralLearningChange({ ...optional, checkpoint: legacy.dictionary.checkpoint }, input, legacy.dictionary, version));
  }
});
