import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { readCentralOpenPurposeBindings, readCentralPurposeMemory } from "./runtime-purpose-memory.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { CENTRAL_CHANGE_INPUT_VERSION, C34_CENTRAL_CHANGE_INPUT_VERSION, type CentralChangeInput } from "./change-input-contract.js";
import { centralAdvisoryKnowledgeHash } from "./central-advisory-records.js";
import { compileCentralDecision, encodeCentralDeliberation, centralDecisionWireFields } from "./deliberation-encoding.js";
import { expandCentralSingleActionV6Base } from "./change-single-action-handoff.js";
import { CENTRAL_SINGLE_ACTION_VERSION, CENTRAL_SINGLE_ACTION_V5_VERSION, CENTRAL_SINGLE_ACTION_V4_VERSION,
  CENTRAL_SINGLE_ACTION_V3_VERSION, CENTRAL_SINGLE_ACTION_V2_VERSION, CENTRAL_SINGLE_ACTION_LEGACY_VERSION } from "./change-single-action-version.js";
import { centralSingleActionMessages as v1 } from "./change-single-action-page-v1.js";
import { centralSingleActionMessages as v2 } from "./change-single-action-page-v2.js";
import { centralSingleActionMessages as v3 } from "./change-single-action-page-v3.js";
import { centralSingleActionMessages as v4 } from "./change-single-action-page-v4.js";
import { centralSingleActionMessages as v5 } from "./change-single-action-page-v5.js";
import { centralSingleActionGrammar as grammar3 } from "./change-single-action-grammar-v3.js";
import { centralSingleActionGrammar as grammar4 } from "./change-single-action-grammar-v4.js";
import { centralSingleActionGrammar as grammar5 } from "./change-single-action-grammar-v5.js";
import { centralSingleActionLegacyToolSchema } from "./change-single-action-tool-legacy.js";
import { CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION, CENTRAL_SINGLE_ACTION_TOOL_NAME } from "./change-single-action-tool-contract.js";

const scope = "project:handoff-v6", publicationRef = `central-advisory-publication:${"a".repeat(64)}`;
const original: CentralLearningIntentDraft = { intentId: "intent:existing", subject: { plane: "central", questionRef: "intent:existing" },
  goal: "Retain the condition of a public observation.", rationale: "The observation has a reusable condition.",
  conditions: ["Only in the original setting."], knowledge: [{ statement: "The original result has a specific condition.",
    conditions: "Only in the original setting.", sourceRefs: ["source:one"] }], residual: ["Future effects are unknown."],
  commitment: { purpose: "Retain conditional understanding.", assumptions: [], reconsiderWhen: ["The condition changes."] },
  revisionReason: "Original research record.", sourceRefs: ["source:one"], continuation: { kind: "open" } };

function request(): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:handoff-v6", boardSequence: 0,
    configuration: { schemaVersion: 1, configurationRef: "configuration:one", authorizationRef: "authorization:one",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: 0, budgetId: "budget:handoff-v6", limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: initialCentralRuntimeRef(scope), state: { ...emptyCentralRuntimeState(scope), intents: [original] }, opportunities: [],
    materials: [{ ref: "source:one", kind: "source", text: "The original result has a specific condition.", sourceRefs: ["source:one"] },
      { ref: publicationRef, kind: "knowledge", text: "A public advisory version; its effect remains unknown.", sourceRefs: [publicationRef] }],
    organization: [], operation: { kind: "think", operationId: "operation:current", purpose: "Choose whether to share a conditional advisory.",
      expectedChange: "An explicit public source selection or no change.", sourceRefs: ["source:one"] } };
}

const format = { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_VERSION } as const;

function compile(value: unknown, req = request()) {
  const input = createCentralLearningChangeView(req, [], CENTRAL_CHANGE_INPUT_VERSION);
  return { input, output: compileCentralDecision(value, req, input.dictionary, format, input.version) };
}

function handle(input: CentralChangeInput, kind: "intent" | "source" | "read", ref: string): string {
  const entry = input.dictionary.entries.find(row => row.kind === kind && row.ref === ref);
  assert.ok(entry);
  return entry.handle;
}

const selection = { knowledge: [0], whenRelevant: "The original setting recurs.", uncertainty: "Not a verified rule; effects are unknown." };

test("v7 explicitly teaches both required root shapes while retaining v6 action semantics", () => {
  const req = request(), newer = { kind: "action_tool", representationVersion: "central-learning-single-action-v7",
    description: CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION } as const;
  const older = { ...newer, representationVersion: "central-learning-single-action-v6" } as const;
  const current = encodeCentralDeliberation(req, newer), previous = encodeCentralDeliberation(req, older);

  assert.match(String(current.messages[0]!.content), /Required root shapes/);
  assert.doesNotMatch(String(previous.messages[0]!.content), /Required root shapes/);
  assert.deepEqual(current.wire.tools, previous.wire.tools);

  for (const submitted of [{ action: "none", why: "Preserve uncertainty." }, { changes: [], explanation: "Preserve uncertainty." }]) {
    assert.deepEqual(compileCentralDecision(submitted, req, current.dictionary, newer),
      compileCentralDecision(submitted, req, previous.dictionary, older));
  }
});

test("the current tool declares and compiles an exact decision envelope", () => {
  const req = request(), tool = { kind: "action_tool", representationVersion: CENTRAL_SINGLE_ACTION_VERSION,
    description: CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION } as const;
  const input = encodeCentralDeliberation(req, tool);

  assert.deepEqual(input.wire.tools[0]!.parameters.required, ["decision"]);
  const decision = { action: "none", why: "Retain the original uncertainty." };

  assert.deepEqual(compileCentralDecision({ decision }, req, input.dictionary, tool),
    compileCentralDecision(decision, req, input.dictionary, tool));
  assert.throws(() => compileCentralDecision({ decision, unexpected: true }, req, input.dictionary, tool), /central_learning_change_invalid/);
});

test("v6 handoffs bind actual resulting entries and explicit publication handles without changing ordinary action meaning", () => {
  const req = request(), input = createCentralLearningChangeView(req), target = handle(input, "intent", original.intentId);
  const source = handle(input, "source", "source:one"), publication = handle(input, "source", publicationRef);
  const raw = { action: "handoff", target, ...selection, why: "Share this conditional understanding." };
  const before = canonicalJson(raw), output = compile(raw).output;

  assert.deepEqual(output.intents, req.state.intents);
  assert.deepEqual(output.knowledgeHandoffs, [{ kind: "publish", intentId: original.intentId,
    knowledgeHash: centralAdvisoryKnowledgeHash(original.knowledge[0]!), whenRelevant: selection.whenRelevant, uncertainty: selection.uncertainty }]);
  assert.equal(canonicalJson(raw), before);
  assert.deepEqual(expandCentralSingleActionV6Base(raw, req, input.dictionary),
    expandCentralSingleActionV6Base({ action: "none", why: raw.why }, req, input.dictionary));

  const revised = compile({ action: "revise", target, why: "Narrow the original condition.", set: { knowledgeEdits: [
    { kind: "revise", target: 0, entry: { statement: "A narrowed public result.", conditions: "Only the narrower setting.", sources: [source] }, why: "A changed condition." },
  ] }, handoff: selection }).output;

  assert.equal(revised.knowledgeHandoffs?.[0]?.kind, "publish");
  assert.equal(revised.knowledgeHandoffs?.[0]?.kind === "publish" && revised.knowledgeHandoffs[0].knowledgeHash,
    centralAdvisoryKnowledgeHash(revised.intents.find(row => row.intentId === original.intentId)!.knowledge[0]!));
  assert.notEqual(revised.knowledgeHandoffs?.[0]?.kind === "publish" && revised.knowledgeHandoffs[0].knowledgeHash,
    centralAdvisoryKnowledgeHash(original.knowledge[0]!));

  const create = { action: "create", key: "new-advisory", subject: "central", goal: "Study the original condition.",
    next: { kind: "end", goalState: "open", reason: "No further investigation is selected." }, why: "The actual source supports this question.",
    grounding: { relation: "The source describes a conditional result.", whenRelevant: "That original condition recurs.", citations: [{ source }] },
    knowledge: [{ statement: "A conditional public result.", conditions: "Original setting only.", sources: [source] }] };
  const created = compile({ ...create, handoff: selection }).output, ordinary = compile(create).output;
  const { knowledgeHandoffs: selected, ...unchanged } = created;

  assert.deepEqual(unchanged, ordinary);
  const createdIntent = created.intents.find(row => row.intentId !== original.intentId)!;

  assert.deepEqual(selected, [{ kind: "publish", intentId: createdIntent.intentId,
    knowledgeHash: centralAdvisoryKnowledgeHash(createdIntent.knowledge[0]!), whenRelevant: selection.whenRelevant, uncertainty: selection.uncertainty }]);
  assert.deepEqual(compile({ action: "withdraw_handoff", publication, why: "Withdraw this public version." }).output.knowledgeHandoffs,
    [{ kind: "withdraw", publicationRef, why: "Withdraw this public version." }]);

  for (const invalid of [{ ...raw, checkpoint: "wrong" }, { ...raw, knowledge: [1] }, { ...raw, knowledge: [0, 0] },
    { ...raw, target: source }, { ...raw, knowledgeHash: "forged" }, { action: "none", why: "No change.", handoff: selection },
    { action: "withdraw_handoff", publication: publicationRef, why: "A raw address is not a handle." },
    { action: "withdraw_handoff", publication: source, why: "This source is not a publication." }]) assert.throws(() => compile(invalid));

  assert.throws(() => compileCentralDecision(raw, req, input.dictionary,
    { kind: "action_json", representationVersion: CENTRAL_SINGLE_ACTION_V5_VERSION }, input.version));
});

test("a real delivered archived ended body can be handed off without restoring it to the working agenda", () => {
  const ended: CentralLearningIntentDraft = { ...original, continuation: { kind: "ended", goalState: "open", reason: "Investment ended with residuals." } };
  const fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...emptyCentralRuntimeState(scope), intents: [ended] },
    reason: "Original purpose ended.", sourceRefs: ["source:one"] }), sequence: 1 };
  const archive = { facts: [fact], scope, boardSequence: 1 }, address = readCentralOpenPurposeBindings(archive).entries[0]!.readRef;
  const material = readCentralPurposeMemory(archive, address);
  assert.ok(material);
  const req = { ...request(), boardSequence: 1, state: emptyCentralRuntimeState(scope), materials: [...request().materials, material] };
  const input = createCentralLearningChangeView(req), target = handle(input, "intent", ended.intentId);
  const output = compile({ action: "handoff", target, ...selection, why: "Retain the original advisory condition." }, req).output;

  assert.deepEqual(output.intents, []);
  assert.equal(output.knowledgeHandoffs?.[0]?.kind === "publish" && output.knowledgeHandoffs[0].intentId, ended.intentId);
});

test("v1-v5 normal JSON and tool wire hashes still agree with their frozen factories", () => {
  const req = request(), rows = [
    { version: CENTRAL_SINGLE_ACTION_LEGACY_VERSION, messages: v1, schema: centralSingleActionLegacyToolSchema },
    { version: CENTRAL_SINGLE_ACTION_V2_VERSION, messages: v2, schema: centralSingleActionLegacyToolSchema },
    { version: CENTRAL_SINGLE_ACTION_V3_VERSION, messages: v3, schema: (r: CentralDeliberationRequest, d: CentralChangeInput["dictionary"]) => grammar3(r, d).schema },
    { version: CENTRAL_SINGLE_ACTION_V4_VERSION, messages: v4, schema: (r: CentralDeliberationRequest, d: CentralChangeInput["dictionary"]) => grammar4(r, d).schema },
    { version: CENTRAL_SINGLE_ACTION_V5_VERSION, messages: v5, schema: (r: CentralDeliberationRequest, d: CentralChangeInput["dictionary"]) => grammar5(r, d).schema },
  ] as const;
  for (const row of rows) {
    const inputVersion = row.version === CENTRAL_SINGLE_ACTION_V5_VERSION ? CENTRAL_CHANGE_INPUT_VERSION : C34_CENTRAL_CHANGE_INPUT_VERSION;
    const input = createCentralLearningChangeView(req, [], inputVersion), messages = row.messages(req, input);
    const json = encodeCentralDeliberation(req, { kind: "action_json", representationVersion: row.version }, [], inputVersion);

    assert.equal(contentHashOf(centralDecisionWireFields(json.wire)), contentHashOf({ messages, tools: [], responseFormat: { type: "json_object" } }));
    const tool = encodeCentralDeliberation(req, { kind: "action_tool", representationVersion: row.version,
      description: CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION }, [], inputVersion);
    const toolMessages = messages.map((message, index) => index === 0 ? { ...message,
      content: `${message.content}\nFor this connection, JSON means the arguments of ${CENTRAL_SINGLE_ACTION_TOOL_NAME}. Submit the decision through that sole function, not assistant prose. It records a learning decision; it executes no business operation.` } : message);

    assert.equal(contentHashOf(centralDecisionWireFields(tool.wire)), contentHashOf({ messages: toolMessages,
      tools: [{ name: CENTRAL_SINGLE_ACTION_TOOL_NAME, description: CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION, parameters: row.schema(req, input.dictionary) }] }));
    assert.equal(json.version, inputVersion);
    assert.doesNotMatch(JSON.stringify(row.schema(req, input.dictionary)), /withdraw_handoff|actionHandoff/);
  }
});
