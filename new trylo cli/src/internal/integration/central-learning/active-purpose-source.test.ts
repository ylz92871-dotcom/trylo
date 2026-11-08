import assert from "node:assert/strict";
import test from "node:test";
import type { BoardState } from "../../learning/control/state.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { createActivePurposeNavigation, createActivePurposeOriginal } from "./active-purpose-delivery.js";
import { createCentralRuntimeSource } from "./runtime-source.js";

const scope = "workspace:active-purpose-source";
const signal = new AbortController().signal;

function purpose(id: string, goal = `Understand the original condition for ${id}`): CentralLearningIntentDraft {
  return { intentId: `intent:${id}`, subject: { plane: "agent", domain: "prompt", issueId: `issue:${id}` },
    goal, rationale: "An original comparison leaves an unresolved condition", conditions: ["Only the observed receiver"],
    knowledge: [{ statement: "The original input preserves minutes", conditions: "Before an explicit receiver conversion", sourceRefs: ["source:unit"] }],
    residual: ["Whether a second receiver requires seconds"], commitment: { purpose: "Compare the exact receiver contracts", assumptions: [],
      reconsiderWhen: ["A genuine receiver correction arrives"] }, revisionReason: "Retain the original research purpose", sourceRefs: ["source:unit"],
    continuation: { kind: "waiting", wait: { kind: "facts", reason: "Await the original second receiver contract", sourceRefs: ["source:receiver"] } } };
}

function checkpoint(previousRef: string, intents: readonly CentralLearningIntentDraft[], sequence: number,
  materials: readonly CentralRuntimeMaterial[] = [], selectedScope = scope) {
  return { ...buildCentralRuntimeRecord({ previousRef, state: { ...emptyCentralRuntimeState(selectedScope), intents, materials },
    reason: "Original source fixture checkpoint", sourceRefs: [] }), sequence };
}

function sourceFor(facts: NonNullable<BoardState["rewardV2Facts"]>, options: { readonly secrets?: readonly string[];
  readonly enabled?: () => boolean; readonly compatibleScopes?: readonly string[]; readonly scope?: string } = {}) {
  const state: BoardState = { ...emptyBoardState(), sequence: facts.length, rewardV2Facts: facts };
  const source = createCentralRuntimeSource({ scope: options.scope ?? scope, boardRoot: "unused-injected-active-purpose-board", ports: [],
    board: { async load() { return { ok: true, state, generation: 1 }; } }, enabled: options.enabled ?? (() => true),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.compatibleScopes === undefined ? {} : { compatibleScopes: options.compatibleScopes }) });
  return { source, state };
}

test("active purpose reads resolve the original same-scope body and historical catalog pages after revision and restart", async () => {
  const original = purpose("one"), others = [purpose("two"), purpose("three")], agenda = [original, ...others];
  const first = checkpoint(initialCentralRuntimeRef(scope), agenda, 1);
  const revised = { ...original, goal: "Investigate the explicitly corrected seconds condition", revisionReason: "The original receiver supplied a correction" };
  const second = checkpoint(first.id, [revised, ...others], 2);
  const fixture = sourceFor([first, second]), before = JSON.stringify(fixture.state);
  const catalog = createActivePurposeNavigation(scope, agenda, 0, 1);
  const [readCatalog] = await fixture.source.read(scope, [catalog.ref], 12000, signal);

  assert.deepEqual(readCatalog, catalog);
  const navigation = JSON.parse(readCatalog!.text);

  assert.equal(navigation.role, "central_active_purpose_navigation");
  assert.equal(navigation.entries.length, 1);
  assert.ok(navigation.nextRef);
  const [nextCatalog] = await fixture.source.read(scope, [navigation.nextRef], 12000, signal);

  assert.deepEqual(nextCatalog, createActivePurposeNavigation(scope, agenda, 1, 1));
  const originalMaterial = createActivePurposeOriginal(scope, original);
  const [readOriginal] = await sourceFor([first, second]).source.read(scope, [originalMaterial.ref], 12000, signal);

  assert.deepEqual(readOriginal, originalMaterial);
  assert.deepEqual(JSON.parse(readOriginal!.text).intent, original, "the old address must never substitute the latest intent");
  assert.equal(JSON.stringify(fixture.state), before, "source reads own no checkpoint or budget writer");
  const batch = sourceFor([first, second]);
  let prefixReads = 0;

  Object.defineProperty(batch.state, "rewardV2Facts", { get() {
    prefixReads += 1;
    return [first, second];
  } });
  assert.deepEqual(await batch.source.read(scope, [catalog.ref, originalMaterial.ref, navigation.nextRef], 30000, signal),
    [catalog, originalMaterial, createActivePurposeNavigation(scope, agenda, 1, 1)]);
  assert.equal(prefixReads, 1, "one source-read batch must verify the original history only once");
});

test("a Windows canonical purpose scope is metadata while private prose paths stay protected", async () => {
  const windowsScope = "D:\\CC\\trylo\\work\\actual-workspace", original = purpose("windows");
  const fact = checkpoint(initialCentralRuntimeRef(windowsScope), [original], 1, [], windowsScope);
  const material = createActivePurposeOriginal(windowsScope, original);
  const read = await sourceFor([fact], { scope: windowsScope }).source.read(windowsScope, [material.ref], 12000, signal);

  assert.deepEqual(read, [material], "the original scope, body and identity remain unchanged");
  const privatePurpose = purpose("private", "Read C:\\Users\\private-person\\secret.txt");
  const privateFact = checkpoint(initialCentralRuntimeRef(windowsScope), [privatePurpose], 1, [], windowsScope);

  await assert.rejects(sourceFor([privateFact], { scope: windowsScope }).source.read(windowsScope,
    [createActivePurposeOriginal(windowsScope, privatePurpose).ref], 12000, signal), /central_runtime_source_sensitive/);
});

test("active purpose addresses reject missing versions, foreign scopes, forged archived bodies and corrupt original chains", async () => {
  const original = purpose("one"), nonexistent = purpose("invented");
  const forged = createActivePurposeOriginal(scope, nonexistent);
  const malformed = { ...forged, ref: forged.ref.replace(/[a-f0-9]{64}$/, "invalid") };
  const first = checkpoint(initialCentralRuntimeRef(scope), [original], 1, [forged, malformed]);
  const fixture = sourceFor([first], { compatibleScopes: ["workspace:foreign"] });
  const missing = createActivePurposeOriginal(scope, { ...original, goal: "A version never committed" });

  for (const ref of [missing.ref, forged.ref, malformed.ref, createActivePurposeOriginal("workspace:foreign", original).ref,
    createActivePurposeNavigation(scope, [nonexistent], 0, 1).ref]) {
    await assert.rejects(fixture.source.read(scope, [ref], 12000, signal), /central_runtime_source_missing/);
  }

  const fork = checkpoint(initialCentralRuntimeRef(scope), [purpose("fork")], 2);

  await assert.rejects(sourceFor([first, fork]).source.read(scope, [createActivePurposeOriginal(scope, original).ref], 12000, signal),
    /central_runtime_chain_corrupt/);
});

test("active purpose reads retain the original credential, cancellation, collection and page boundaries", async () => {
  const secret = "active-purpose-source-secret-7d1a";
  const sensitive = purpose("sensitive", `The exact rejected value is ${secret}`);
  const privateFact = checkpoint(initialCentralRuntimeRef(scope), [sensitive], 1);

  await assert.rejects(sourceFor([privateFact], { secrets: [secret] }).source.read(scope,
    [createActivePurposeOriginal(scope, sensitive).ref], 12000, signal), /central_runtime_source_sensitive/);
  const original = purpose("large", "Original complete purpose. ".repeat(150));
  const first = checkpoint(initialCentralRuntimeRef(scope), [original], 1), whole = createActivePurposeOriginal(scope, original);
  const fixture = sourceFor([first]);
  let nextRef: string | null = whole.ref, rebuilt = "", pages = 0;

  while (nextRef !== null) {
    const [material] = await fixture.source.read(scope, [nextRef], 1800, signal);
    assert.ok(material);
    assert.ok(material.text.length <= 1800);
    const page = JSON.parse(material.text);
    assert.equal(page.originalRef, whole.ref);
    assert.equal(page.start, rebuilt.length);
    rebuilt += page.text;
    nextRef = page.nextRef;
    pages += 1;
    assert.ok(pages < 20, "the original finite body must produce finite advancing pages");
  }

  assert.ok(pages > 1);
  assert.equal(rebuilt, whole.text);
  await assert.rejects(sourceFor([first], { enabled: () => false }).source.read(scope, [whole.ref], 12000, signal), /collect_disabled/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(fixture.source.read(scope, [whole.ref], 12000, cancelled.signal), /central_runtime_source_cancelled/);
});
