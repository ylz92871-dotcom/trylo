import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralChangeView } from "./change-input.js";
import { activePurposeAgendaVersion, activePurposeCatalogRef, activePurposeReadRef, activePurposeVersion,
  createActivePurposeNavigation, createActivePurposeNavigationData, createActivePurposeOriginal,
  isActivePurposeDelivery, ownsActivePurposeReadRef, parseActivePurposeReadRef, readActivePurposeDelivery } from "./active-purpose-delivery.js";

const scope = "workspace:active-purpose-delivery";

function intent(id: string): CentralLearningIntentDraft {
  return { intentId: id, subject: { plane: "central", questionRef: id }, goal: `Understand ${id} under its actual conditions`,
    rationale: "The original observation leaves an open condition.", conditions: ["When the original interface is reused"],
    knowledge: [{ statement: "The observed interface has a conditional requirement.", conditions: "This interface only", sourceRefs: ["source:original"] }],
    residual: ["Does the same condition hold for the next actual use?"], commitment: { purpose: "Inspect its actual use", assumptions: [], reconsiderWhen: [] },
    revisionReason: "Original source-grounded purpose", sourceRefs: ["source:original"],
    continuation: { kind: "waiting", wait: { kind: "use_feedback", sourceRefs: ["source:original"], reason: "Await its actual use" } } };
}

function request(intents: readonly CentralLearningIntentDraft[], materials: readonly CentralRuntimeMaterial[] = []): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId: "budget:active-purpose", boardSequence: 1, stateRef: "state:active-purpose",
    configuration: { schemaVersion: 1, configurationRef: "config:active-purpose", authorizationRef: "auth:active-purpose",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    resources: { boardSequence: 1, budgetId: "budget:active-purpose", limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents, completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [], materials, organization: [], operation: { kind: "think", operationId: "operation:active-purpose",
      purpose: "Choose the next source-bound learning change", expectedChange: "Reconsider the actual unresolved condition", sourceRefs: [] } };
}

function navigation(input: CentralDeliberationRequest): CentralDeliberationRequest {
  return { ...input, activePurposeDelivery: { version: "active-purpose-navigation-v1",
    agendaVersion: activePurposeAgendaVersion(input.state.intents), maximumEntries: 1 } };
}

test("active purpose catalog reads and their source fragments never grant quotation evidence", () => {
  const first = intent("intent:catalog"), catalog = createActivePurposeNavigation(scope, [first], 0, 1);
  const text = catalog.text.slice(0, 120);
  const fragment: CentralRuntimeMaterial = { ref: `central-runtime-fragment:${contentHashOf([catalog.ref, 0, text])}`,
    kind: "knowledge", sourceRefs: [catalog.ref], text: canonicalJson({ originalRef: catalog.ref, start: 0,
      end: text.length, totalChars: catalog.text.length, text,
      nextRef: `central-runtime-page:${text.length}:${encodeURIComponent(catalog.ref)}` }) };
  const input = createCentralChangeView(request([first], [catalog, fragment]));

  for (const material of [catalog, fragment]) {
    assert.equal(input.exposure.find(row => row.ref === material.ref)?.kind, "navigation");
    assert.equal(input.dictionary.entries.some(row => row.ref === material.ref && row.kind === "source"), false);
    const read = input.dictionary.entries.find(row => row.ref === material.ref && row.kind === "read");
    assert.ok(read);
    assert.equal(input.dictionary.read(read.handle), material.ref);
    const reference = input.dictionary.entries.find(row => row.ref === material.ref && row.kind === "reference");
    assert.ok(reference);
    assert.equal(input.dictionary.citation(reference.handle, text), undefined);
  }
});

test("active purpose addresses bind exact scope and versions while navigation pages remain bounded", () => {
  const first = { ...intent("intent:first"), goal: `${"a".repeat(255)}😀 followed by the rest of the original goal` };
  const second = intent("intent:second"), ended: CentralLearningIntentDraft = { ...intent("intent:ended"),
    continuation: { kind: "ended", goalState: "open", reason: "Expenditure ended while its question remains open" } };
  const intents = [first, second, ended];

  assert.equal(activePurposeVersion(first), contentHashOf(first));
  assert.notEqual(activePurposeReadRef(scope, first), activePurposeReadRef("workspace:other", first));
  const revised = { ...first, residual: ["A correction changes the unresolved question"] };

  assert.notEqual(activePurposeReadRef(scope, first), activePurposeReadRef(scope, revised));
  const page = createActivePurposeNavigationData(scope, intents, 0, 1);

  assert.equal(page.total, 2);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]?.goal, "a".repeat(255), "an excerpt never splits an original Unicode character");
  assert.equal(page.entries[0]?.readRef, activePurposeReadRef(scope, first));
  assert.equal(page.nextRef, activePurposeCatalogRef(scope, intents, 1, 1));
  assert.notEqual(page.nextRef, activePurposeCatalogRef(scope, [first, second, { ...ended, revisionReason: "A later original revision" }], 1, 1));
  assert.notEqual(page.nextRef, activePurposeCatalogRef(scope, [second, first, ended], 1, 1));
  assert.notEqual(page.nextRef, activePurposeCatalogRef("workspace:other", intents, 1, 1));
  const last = createActivePurposeNavigation(scope, intents, 1, 1);

  assert.deepEqual(last.sourceRefs, []);
  assert.equal(JSON.parse(last.text).nextRef, null);
  assert.equal(parseActivePurposeReadRef(activePurposeReadRef(scope, first))?.kind, "body");
  const parsed = parseActivePurposeReadRef(last.ref);
  assert.ok(parsed?.kind === "catalog");
  assert.equal(parsed.offset, 1);
  assert.equal(parsed.pageSize, 1);
  assert.equal(parseActivePurposeReadRef(`${last.ref}:extra`), undefined);
  assert.equal(ownsActivePurposeReadRef(`${last.ref}:extra`), true, "malformed owned addresses cannot fall through to other readers");
  assert.equal(ownsActivePurposeReadRef("source:unrelated"), false);
  assert.equal(parseActivePurposeReadRef(last.ref.replace(/:1:1$/, ":01:1")), undefined);
  assert.throws(() => createActivePurposeNavigation(scope, intents, 0, 33), /central_active_purpose_page_invalid/);
});

test("navigation grants only complete current originals and leaves the canonical agenda untouched", () => {
  const first = intent("intent:first"), second = intent("intent:second");
  const input = request([first, second]), before = canonicalJson(input);
  const legacy = readActivePurposeDelivery(input);

  assert.equal(legacy.navigation, false);
  assert.equal(legacy.visibleIntents, input.state.intents);
  const pending = navigation(input), unopened = readActivePurposeDelivery(pending);

  assert.equal(unopened.navigation, true);
  assert.deepEqual(unopened.visibleIntents, []);
  assert.equal(unopened.navigationData?.entries.length, 1);
  assert.deepEqual(pending.materials, [], "first navigation is not a material, source read or notice");
  const catalog = createActivePurposeNavigation(scope, input.state.intents, 0, 1);

  assert.deepEqual(readActivePurposeDelivery({ ...pending, materials: [catalog] }).visibleIntents, []);
  const original = createActivePurposeOriginal(scope, second);

  assert.equal(original.kind, "work_result");
  assert.deepEqual(original.sourceRefs, [second.intentId]);
  const opened = readActivePurposeDelivery({ ...pending, materials: [original] });

  assert.deepEqual(opened.visibleIntents, [second]);
  assert.equal(opened.visibleIntents[0], second);
  assert.equal(canonicalJson(input), before);
  assert.equal(pending.state, input.state);
  assert.deepEqual(readActivePurposeDelivery({ ...input, materials: [catalog] }).visibleIntents, input.state.intents,
    "a catalog body cannot silently switch a legacy request into navigation mode");
});

test("stale, foreign and partial purpose bodies never authorize current intent changes", () => {
  const old = intent("intent:current"), current = { ...old, residual: ["A newly observed counterexample still needs an answer"] };
  const pending = navigation(request([current])), original = createActivePurposeOriginal(scope, current);
  const body = (value: unknown): CentralRuntimeMaterial => ({ ...original, text: canonicalJson(value) });
  const invalid = [createActivePurposeOriginal(scope, old), createActivePurposeOriginal("workspace:other", current),
    { ...original, ref: `central-active-purpose:${"0".repeat(64)}` },
    body({ role: "central_active_purpose_original", scope, intentVersion: activePurposeVersion(current), intent: { intentId: current.intentId } }),
    body({ role: "central_active_purpose_original", scope, intentVersion: activePurposeVersion(current), intent: { ...current, residual: [] } }),
    body({ role: "central_active_purpose_original", scope, intentVersion: activePurposeVersion(old), intent: current })];

  for (const material of invalid) assert.deepEqual(readActivePurposeDelivery({ ...pending, materials: [material] }).visibleIntents, []);

  const delivered = { ...pending, state: { ...pending.state, materials: [original] } };

  assert.deepEqual(readActivePurposeDelivery(delivered).visibleIntents, [current]);
  assert.equal(isActivePurposeDelivery(pending.activePurposeDelivery, [old]), false);
  assert.throws(() => readActivePurposeDelivery({ ...pending, activePurposeDelivery: { ...pending.activePurposeDelivery!,
    agendaVersion: activePurposeAgendaVersion([old]) } }), /central_active_purpose_delivery_invalid/);

  for (const maximumEntries of [0, 33, 1.5]) {
    assert.equal(isActivePurposeDelivery({ ...pending.activePurposeDelivery, maximumEntries }, [current]), false);
  }

  assert.equal(isActivePurposeDelivery({ ...pending.activePurposeDelivery, extra: true }, [current]), false);
  assert.equal(isActivePurposeDelivery({ ...pending.activePurposeDelivery, version: "unknown" }, [current]), false);
});

test("complete delivered purpose fragments grant one current capability while gaps and stale pages do not", () => {
  const current = { ...intent("intent:paged"), goal: "g".repeat(20000), rationale: "r".repeat(20000) };
  const original = createActivePurposeOriginal(scope, current), pending = navigation(request([current]));

  assert.ok(original.text.length > 32768);
  const fragment = (start: number, end: number): CentralRuntimeMaterial => {
    const text = original.text.slice(start, end);
    return { ref: `central-runtime-fragment:${contentHashOf([original.ref, start, text])}`, kind: original.kind,
      sourceRefs: [original.ref, current.intentId], text: canonicalJson({ originalRef: original.ref, start, end,
        totalChars: original.text.length, text, nextRef: end < original.text.length
          ? `central-runtime-page:${end}:${encodeURIComponent(original.ref)}` : null }) };
  };
  const middle = Math.floor(original.text.length / 2), first = fragment(0, middle), last = fragment(middle, original.text.length);

  assert.deepEqual(readActivePurposeDelivery({ ...pending, materials: [first] }).visibleIntents, []);
  const complete = readActivePurposeDelivery({ ...pending, materials: [last, first] });

  assert.deepEqual(complete.visibleIntents.map(row => row.intentId), [current.intentId]);
  assert.deepEqual(complete.materialRefsByIntent.get(current.intentId), [first.ref, last.ref]);
  assert.deepEqual(readActivePurposeDelivery({ ...pending, materials: [first, fragment(middle + 1, original.text.length)] }).visibleIntents, []);
  const revised = { ...current, residual: ["A later original counterexample changes the current version"] };

  assert.deepEqual(readActivePurposeDelivery({ ...navigation(request([revised])), materials: [first, last] }).visibleIntents, []);
});
