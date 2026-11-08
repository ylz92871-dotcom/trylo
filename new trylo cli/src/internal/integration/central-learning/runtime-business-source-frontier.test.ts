import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { testScratchPath } from "../../testing/scratch.js";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { createCentralDeliberationReceiptsAtRoot, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { consideredCentralBusinessSourceRefs, readConsideredCentralBusinessSourceRefs } from "./runtime-business-source-frontier.js";

const scope = "project:business-source-frontier", budgetId = "budget:business-source-frontier";
const operationId = "operation:consider-business-position";
const publicText = canonicalJson({ header: { role: "source_owned_public_turn_collection_not_independent_evidence",
  sessionId: "business-session", turnId: "business-turn", through: 15 }, records: [
    { journalSequence: 2, text: "Inspect the original receiver contract." },
    { journalSequence: 15, text: "The business turn ended; its usefulness is still unknown.".repeat(16) }] });
const frozenRef = `session-public-turn:${canonicalJson({ sessionId: "business-session", turnId: "business-turn",
  through: 15, sourceHash: contentHashOf(publicText) })}`;
const page = (changes: Partial<Parameters<typeof centralMaterialFromPage>[0]> = {}) => centralMaterialFromPage({
  ref: `session-address:${canonicalJson({ sessionId: "business-session", turnId: "business-turn" })}`,
  originalRef: frozenRef, originalScope: scope, owner: "session", origin: "execution_result",
  coordinate: { runId: frozenRef, sequence: 0 }, start: 0, end: 160, totalChars: publicText.length,
  text: publicText.slice(0, 160), sourceHash: contentHashOf(publicText), ...changes });

function delivery(materials: readonly CentralRuntimeMaterial[] = [page()]): CentralDeliberationDelivery {
  const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId, boardSequence: 0,
    configuration: { schemaVersion: 1, configurationRef: "configuration:frontier", authorizationRef: "authorization:frontier",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: 0, budgetId, limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    stateRef: initialCentralRuntimeRef(scope), state: emptyCentralRuntimeState(scope), opportunities: [], materials, organization: [],
    operation: { kind: "think", operationId, purpose: "Consider the original business version", expectedChange: "Choose whether to continue reading",
      sourceRefs: [frozenRef] } };
  const deliveryRef = `central-deliberation-delivery:${contentHashOf([scope, budgetId, operationId])}`;

  return { request, output: { schemaVersion: 1, intents: [], publicExplanation: "Wait for actual adoption evidence.", sourceRefs: [] },
    deliveryRef, sourceRefs: [deliveryRef] };
}

const proofOf = (value: CentralDeliberationDelivery) => ({ operationId, deliveryRef: value.deliveryRef,
  resultRef: `central-deliberation-result:${contentHashOf(value.output)}` });

test("an actual returned partial page establishes only its frozen navigable version and preserves unread bytes", () => {
  const value = delivery(), before = canonicalJson(value), body = JSON.parse(value.request.materials[0]!.text);

  assert.equal(body.complete, false);
  assert.ok(body.end < body.totalChars);
  assert.ok(body.nextRef.includes(frozenRef));
  assert.throws(() => JSON.parse(body.text), "a partial collection is not parsed as a complete source packet");
  const duplicate = { ...value, request: { ...value.request, organization: value.request.materials } };

  assert.deepEqual(consideredCentralBusinessSourceRefs(duplicate, proofOf(value), scope), [frozenRef]);
  assert.equal(canonicalJson(value), before);
  assert.deepEqual(value.request.state.consumedSourceRefs, [], "consideration never manufactures a read cursor");
  const complete = delivery([page({ end: publicText.length, text: publicText })]);

  assert.deepEqual(consideredCentralBusinessSourceRefs(complete, proofOf(complete), scope), [frozenRef]);
  const tail = delivery([page({ start: 160, end: publicText.length, text: publicText.slice(160) })]);
  const tailBefore = canonicalJson(tail);

  assert.deepEqual(consideredCentralBusinessSourceRefs(tail, proofOf(tail), scope), [frozenRef], "a closing fragment still exposes the exact frozen source address");
  assert.equal(JSON.parse(tail.request.materials[0]!.text).complete, false, "the unshown prefix never becomes a complete read");
  assert.equal(canonicalJson(tail), tailBefore);
});

test("state-only materials, navigation, attempts, cited refs and user JSON cannot establish an actual page frontier", () => {
  const actualPage = page();
  const value = delivery([
    { ref: "central-source-navigation:directory", kind: "source", sourceRefs: [frozenRef], text: canonicalJson({ originalRef: frozenRef }) },
    { ref: "central-semantic-attempt:pending", kind: "source", sourceRefs: [frozenRef], text: canonicalJson({ sourceRefs: [frozenRef] }) },
    { ref: "session-content:user-json", kind: "source", sourceRefs: [frozenRef], text: actualPage.text },
    { ...actualPage, kind: "knowledge" },
    centralMaterialFromPage({ ref: "board:unrelated", originalRef: "board:unrelated", originalScope: "project:other",
      owner: "board", origin: "execution_result", coordinate: { runId: "board:unrelated", sequence: 0 },
      start: 0, end: 7, totalChars: 7, text: "catalog", sourceHash: contentHashOf("catalog") }),
  ]);
  const checkpointOnly = { ...value, request: { ...value.request, state: { ...value.request.state, materials: [actualPage] } } };

  assert.deepEqual(consideredCentralBusinessSourceRefs(checkpointOnly, proofOf(value), scope), []);
});

test("a canonical session page cannot substitute scope, source hash, page identity, coordinate or continuation", () => {
  const valid = page(), body = JSON.parse(valid.text);
  for (const material of [page({ originalScope: "project:other" }), page({ sourceHash: contentHashOf("another-version") }),
    page({ coordinate: { runId: "another-source", sequence: 0 } }), page({ coordinate: { runId: frozenRef, sequence: 1 } }),
    page({ origin: "model_proposal" }), page({ origin: "user_statement" }),
    page({ originalRef: "session-public-turn:{broken" }), page({ ref: "session-public-turn:{broken" }),
    { ...valid, text: "{broken page JSON" },
    { ...valid, ref: `central-source-page:${"0".repeat(64)}` },
    { ...valid, text: canonicalJson({ ...body, nextRef: "central-page:160:another-source" }) },
    { ...valid, text: canonicalJson({ ...body, nextRef: undefined }) }]) {
    const value = delivery([material]);
    assert.throws(() => consideredCentralBusinessSourceRefs(value, proofOf(value), scope), /source_page_invalid|business_source_version_invalid/);
  }
});

test("actual delivery, operation, scope and output identities must match the successful agenda proof", () => {
  const value = delivery(), proof = proofOf(value);

  for (const changed of [{ ...proof, operationId: "operation:another" }, { ...proof, deliveryRef: "delivery:another" },
    { ...proof, resultRef: "central-deliberation-result:another" }]) {
    assert.throws(() => consideredCentralBusinessSourceRefs(value, changed, scope), /consideration_binding/);
  }

  assert.throws(() => consideredCentralBusinessSourceRefs(value, proof, "project:other"), /consideration_binding/);
  const foreignState = { ...value, request: { ...value.request, state: emptyCentralRuntimeState("project:other") } };

  assert.throws(() => consideredCentralBusinessSourceRefs(foreignState, proof, scope), /consideration_binding/);
  assert.throws(() => consideredCentralBusinessSourceRefs({ ...value, output: { ...value.output, publicExplanation: "Another returned choice." } }, proof, scope),
    /consideration_binding/);
});

async function persistedDelivery() {
  const facts: RewardV2Fact[] = [];
  let revision = 0, writes = 0;
  const board = { async read() { return { revision, facts: [...facts] }; }, async append(expected: number, draft: RewardV2Draft) {
    assert.equal(expected, revision);
    writes += 1;
    facts.push({ ...draft, sequence: ++revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const value = delivery(), receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: mkdtempSync(testScratchPath("central-business-frontier-board-")), scope, budgetId,
    enabled: () => true, board });
  const saved = await receipts.save({ request: value.request, output: value.output }), proof = { ...proofOf(saved), sourceRefs: [] };
  const agenda = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...emptyCentralRuntimeState(scope), completed: [{ intentId: "central:agenda", operation: value.request.operation,
      outcome: "returned", resultRefs: [proof.resultRef], publicResult: value.output.publicExplanation }] },
    reason: "central_deliberation_returned", sourceRefs: [], opportunityConsideration: proof }), sequence: ++revision };

  facts.push(agenda);
  const cursor = readCentralRuntimeRecords(facts, scope, revision);

  return { facts, agenda, proof, revision, writes, cursor, board };
}

test("cold history reads original receipts without migration or writes and refuses missing, corrupt or post-agenda receipts", async () => {
  const original = await persistedDelivery(), considerations = original.cursor.history.consideredDeliveries!;
  const input = { facts: original.facts, boardSequence: original.revision, scope, considerations };
  const before = canonicalJson(original.facts);

  assert.equal(considerations.length, 1);
  assert.deepEqual(readConsideredCentralBusinessSourceRefs(input), [frozenRef]);
  assert.deepEqual(readConsideredCentralBusinessSourceRefs({ ...input, considerations: [...considerations, ...considerations] }), [frozenRef]);
  assert.equal(canonicalJson(original.facts), before);
  assert.deepEqual(original.cursor.history.consumedSourceRefs, []);
  assert.equal((await original.board.read()).facts.length, original.facts.length);
  assert.throws(() => readConsideredCentralBusinessSourceRefs({ ...input,
    facts: original.facts.filter(fact => fact.id !== original.proof.deliveryRef) }), /consideration_binding/);
  assert.throws(() => readConsideredCentralBusinessSourceRefs({ ...input,
    facts: original.facts.map((fact, index) => index === 0 ? { ...fact, payloadJson: "{}" } : fact) }), /receipt_corrupt/);
  const late = [{ ...original.agenda, sequence: 1 }, ...original.facts.filter(fact => fact.id !== original.agenda.id)
    .map(fact => ({ ...fact, sequence: fact.sequence + 1 }))];

  assert.throws(() => readConsideredCentralBusinessSourceRefs({ ...input, facts: late,
    considerations: considerations.map(proof => ({ ...proof, sequence: 1 })) }), /consideration_binding/);
  assert.throws(() => readConsideredCentralBusinessSourceRefs({ ...input,
    considerations: considerations.map(proof => ({ ...proof, factRef: "runtime:missing-agenda" })) }), /consideration_binding/);
});
