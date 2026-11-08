import assert from "node:assert/strict";
import test from "node:test";
import type { CentralCompletedOperation, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, lookupCentralRuntimeRecords,
  readCentralRuntimeRecords, type CentralRuntimeLookup } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { recallCentralComparisonContext } from "./runtime-comparison-context.js";
import type { createCentralRuntimeStore } from "./runtime-store.js";

const scope = "workspace:comparison-context";

type ComparisonStore = Pick<ReturnType<typeof createCentralRuntimeStore>, "lookupMany">;

function businessPage(sessionId: string, text: string, originalScope = scope): CentralRuntimeMaterial {
  return centralMaterialFromPage({ ref: `session-address:${canonicalJson({ journalSequence: 2, sessionId })}`,
    originalRef: `session-content:${contentHashOf([sessionId, text])}`, originalScope,
    owner: "session", origin: "user_statement", coordinate: { runId: sessionId, sequence: 2 },
    start: 0, end: text.length, totalChars: text.length, text, sourceHash: contentHashOf(text) });
}

function archived(materials: readonly CentralRuntimeMaterial[], outcome: CentralCompletedOperation["outcome"] = "returned") {
  const empty = emptyCentralRuntimeState(scope);
  const completed: CentralCompletedOperation = { intentId: "central:agenda", operation: { kind: "think",
    operationId: "operation:original-business-agenda", purpose: "Consider the original business conditions",
    expectedChange: "Preserve the original comparison question", sourceRefs: materials.map(row => row.ref) },
    outcome, resultRefs: outcome === "returned" ? ["result:original-business-agenda"] : [], publicResult: "Original operation receipt" };
  const first: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...empty, completed: [completed], materials }, reason: "archive_original_business_pages", sourceRefs: [] }), sequence: 1 };
  const compacted: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: first.id,
    state: { ...empty, completed: [completed] }, reason: "compact_already_archived_pages", sourceRefs: [] }), sequence: 2 };
  const facts = [first, compacted], cursor = readCentralRuntimeRecords(facts, scope, 2);
  const calls: { readonly scope: string; readonly queries: readonly CentralRuntimeLookup[] }[] = [];
  const store: ComparisonStore = { async lookupMany(requestedScope, queries) {
    calls.push({ scope: requestedScope, queries });
    return lookupCentralRuntimeRecords(facts, requestedScope, 2, queries);
  } };

  return { cursor, store, calls, first };
}

test("comparison context recalls the exact archived business page through a returned thought and rejects scope or identity substitutions", async () => {
  const a = businessPage("sender-a", "Duration invoice handoff: source-a.json records 24 hours; draft-a.json records {\"value\":24}.");
  const b = businessPage("receiver-b", "Duration invoice handoff: source-b.json records 1 day; draft-b.json records {\"value\":1}.");
  const history = archived([a]);
  const materials = Object.freeze([b]), before = canonicalJson(history.cursor);

  assert.deepEqual(history.cursor.state.materials, [], "the old body has genuinely left the current workset");
  assert.deepEqual(history.cursor.history.consumedSourceRefs, [], "read progress is not the candidate source");
  const recalled = await recallCentralComparisonContext({ cursor: history.cursor, materials, intent: null, store: history.store });

  assert.deepEqual(recalled, [a], "same business conditions across different real file values retain the original bytes and reference");
  assert.equal(recalled[0]!.text, a.text);
  assert.equal(history.calls.length, 1, "archive candidates use one original batch lookup");
  assert.equal(history.calls[0]!.scope, scope);
  assert.deepEqual(history.calls[0]!.queries, [{ kind: "material", ref: a.ref, factRef: history.first.id }]);
  assert.equal(canonicalJson(history.cursor), before);
  assert.deepEqual(materials, [b]);

  const foreign = archived([businessPage("foreign-a", "Duration invoice handoff: 24 hours in source-a.json.", "workspace:foreign")]);

  await assert.rejects(recallCentralComparisonContext({ cursor: foreign.cursor, materials, intent: null, store: foreign.store }),
    /source_missing|source_page_invalid/, "a semantically related foreign-scope page is not this scope's original comparison context");
  const replacement = businessPage("substituted-a", "Duration invoice handoff: source-a.json now records 25 hours.");
  const substituted: ComparisonStore = { async lookupMany() {
    return [{ status: "found", factRef: history.first.id, value: { ...replacement, ref: a.ref } }];
  } };

  await assert.rejects(recallCentralComparisonContext({ cursor: history.cursor, materials, intent: null, store: substituted }),
    /source_missing|source_page_invalid/, "a locator cannot return different source bytes under the original page identity");
});

test("comparison context ignores unrelated shells while preserving current materials and bounding only old pages", async () => {
  const a = businessPage("sender-a", "Duration invoice handoff: source-a.json records 24 hours.");
  const b = businessPage("receiver-b", "Duration invoice handoff: source-b.json records 1 day.");
  const history = archived([a]);
  const constraint: CentralRuntimeMaterial = Object.freeze({ ref: "central-runtime-constraint:pa-withdrawal", kind: "source",
    text: canonicalJson({ role: "PA_current_constraint_not_business_evidence", reason: "PA withdrew the old proposed operation" }), sourceRefs: [] });
  const catalog: CentralRuntimeMaterial = { ref: "central-business-catalog:addresses-only", kind: "source",
    text: canonicalJson({ role: "host_normal_turn_source_catalog_not_read_body", readRef: a.ref,
      preview: "Duration invoice handoff: source-a.json records 24 hours." }), sourceRefs: [a.ref] };
  const directories = Object.freeze([catalog, constraint]);

  assert.deepEqual(await recallCentralComparisonContext({ cursor: history.cursor, materials: directories, intent: null, store: history.store }), []);
  assert.equal(history.calls.length, 0, "a directory and PA constraint do not manufacture a current business page or active purpose");
  const boardPage = centralMaterialFromPage({ ref: "board:legal-catalog", originalRef: "board:legal-catalog", originalScope: scope,
    owner: "board", origin: "execution_result", coordinate: { runId: "board:legal-catalog", sequence: 0 },
    start: 0, end: 7, totalChars: 7, text: "catalog", sourceHash: contentHashOf("catalog") });
  const withProvenance = { ...boardPage, sourceRefs: [...boardPage.sourceRefs, "original:reader-appended-provenance"] };
  const domainPage = centralMaterialFromPage({ ref: "domain:compatible", originalRef: "domain:compatible", originalScope: "workspace:compatible-domain",
    owner: "domain_feedback", origin: "execution_result", coordinate: { runId: "domain:compatible", sequence: 0 },
    start: 0, end: 7, totalChars: 7, text: "catalog", sourceHash: contentHashOf("catalog") });

  assert.deepEqual(await recallCentralComparisonContext({ cursor: history.cursor, materials: [withProvenance, domainPage, constraint],
    intent: null, store: history.store }), [], "unrelated legal reader pages are not revalidated as optional business context");
  const nonBusiness = archived([withProvenance, domainPage]);

  assert.deepEqual(await recallCentralComparisonContext({ cursor: nonBusiness.cursor, materials: [b], intent: null, store: nonBusiness.store }), []);

  const unrelated = archived([businessPage("horticulture-a", "Orchid petals require violet spectrum exposure.")]);

  assert.deepEqual(await recallCentralComparisonContext({ cursor: unrelated.cursor, materials: [b, constraint], intent: null, store: unrelated.store }), [],
    "common page metadata does not establish business relevance");
  const generic = archived([businessPage("generic-a", "Read the source file and write the output file.")]);

  assert.deepEqual(await recallCentralComparisonContext({ cursor: generic.cursor,
    materials: [businessPage("generic-b", "Read the source file and write the output file.")], intent: null, store: generic.store }), [],
    "generic task verbs do not identify a comparison premise across sessions");
  const oversized = businessPage("large-old-a", `Duration invoice handoff: source-a.json records 24 hours. ${"original detail ".repeat(180)}`);

  assert.ok(oversized.text.length > 2048);
  const largeArchive = archived([oversized]);

  assert.deepEqual(await recallCentralComparisonContext({ cursor: largeArchive.cursor, materials: [b, constraint], intent: null, store: largeArchive.store }), [],
    "an old page beyond the recall window is skipped rather than truncated or relabeled");
  const largeCurrent = businessPage("large-new-b", `Duration invoice handoff: source-b.json records 1 day. ${"current detail ".repeat(180)}`);
  const current = Object.freeze([largeCurrent, constraint]), before = canonicalJson(current);
  const recalled = await recallCentralComparisonContext({ cursor: history.cursor, materials: current, intent: null, store: history.store });

  assert.ok(largeCurrent.text.length > 2048);
  assert.deepEqual(recalled, [a], "the old-page window is independent of the existing current page and PA context");
  assert.ok(recalled.reduce((sum, row) => sum + row.text.length, 0) <= 2048);
  assert.equal(canonicalJson(current), before, "comparison recall cannot crop a current page or alter PA withdrawal");
  assert.deepEqual(directories, [catalog, constraint]);
});

test("a selected new thought recalls a related original after every earlier thought failed without changing their receipts", async () => {
  const a = businessPage("sender-a", "Duration invoice handoff: source-a.json records 24 hours; draft-a.json records {\"value\":24}.");
  const b = businessPage("receiver-b", "Duration invoice handoff: source-b.json records 1 day; draft-b.json records {\"value\":1}.");
  const e = businessPage("receiver-e", "Duration invoice handoff: source-e.json records 2 days; the receiver requires numeric seconds.");
  const empty = emptyCentralRuntimeState(scope);
  const failed: CentralCompletedOperation[] = [a, b, b].map((material, index) => ({ intentId: "central:agenda",
    operation: { kind: "think", operationId: `operation:failed-comparison-${index}`, purpose: `Consider original handoff ${index}`,
      expectedChange: `Compare original duration conditions ${index}`, sourceRefs: [material.ref] },
    outcome: "failed", resultRefs: [], publicResult: "Original computation failed; no confirmed model consideration" }));
  const original: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...empty, completed: failed, materials: [a, b] }, reason: "failed_original_thoughts", sourceRefs: [] }), sequence: 1 };
  const compacted: RewardV2Fact = { ...buildCentralRuntimeRecord({ previousRef: original.id,
    state: { ...empty, completed: failed, materials: [b] }, reason: "compact_original_a_only", sourceRefs: [] }), sequence: 2 };
  const facts = [original, compacted], cursor = readCentralRuntimeRecords(facts, scope, 2), before = canonicalJson(cursor);
  const calls: CentralRuntimeLookup[][] = [];
  const store: ComparisonStore = { async lookupMany(requestedScope, queries) {
    assert.equal(requestedScope, scope);
    calls.push([...queries]);
    return lookupCentralRuntimeRecords(facts, requestedScope, 2, queries);
  } };

  assert.deepEqual(cursor.state.materials, [b]);
  assert.equal(cursor.state.completed.every(row => row.outcome === "failed"), true);
  const recalled = await recallCentralComparisonContext({ cursor, materials: Object.freeze([e]), intent: null, store });

  assert.deepEqual(recalled, [a], "semantic comparison recovers exact old A; current working-set B need not consume the old-page window");
  assert.deepEqual(calls, [[{ kind: "material", ref: a.ref, factRef: original.id }]]);
  assert.deepEqual(cursor.history.consumedSourceRefs, []);
  assert.deepEqual(cursor.history.consideredSourceRefs, []);
  assert.equal(canonicalJson(cursor), before, "archive lookup cannot change failure, consumption, operation identity or agenda state");
});
