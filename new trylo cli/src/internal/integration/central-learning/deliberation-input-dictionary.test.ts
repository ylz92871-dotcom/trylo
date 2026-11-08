import assert from "node:assert/strict";
import test from "node:test";
import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { bindCentralInputDictionary, centralInputHandle, createCentralInputDictionary, resolveCentralInputHandle,
  type CentralInputDictionary, type CentralInputKind } from "./deliberation-input-dictionary.js";

function request(): CentralDeliberationRequest {
  const scope = "workspace:input-dictionary";
  return { schemaVersion: 1, scope, budgetId: "budget:dictionary", boardSequence: 3, stateRef: "state:dictionary",
    configuration: { schemaVersion: 1, configurationRef: "configuration:dictionary", authorizationRef: "authorization:dictionary",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20574, maxCalls: 2, maxSteps: 2, maxPromptChars: 40000 } },
    resources: { boardSequence: 3, budgetId: "budget:dictionary", limits: { tokens: 20574, calls: 2, steps: 2 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 20574, calls: 2, steps: 2 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    materials: [{ ref: "source:original", kind: "source", text: "The original receiver takes seconds.", sourceRefs: [] }],
    organization: [], opportunities: [], operation: { kind: "think", operationId: "operation:dictionary",
      purpose: "Read the receiver contract.", expectedChange: "Keep the original unit premise.", sourceRefs: ["source:original"] } };
}

test("input dictionary deterministically binds typed identities to the exact packed request", () => {
  const input = request(), entries = [{ kind: "source" as const, ref: "source:original" },
    { kind: "read" as const, ref: "source:original" }, { kind: "source" as const, ref: "source:original" }];
  const dictionary = createCentralInputDictionary(input, entries);

  assert.equal(dictionary.checkpoint, `central-input-checkpoint:${contentHashOf(input)}`);
  assert.equal(dictionary.entries.length, 2, "only the same typed identity is deduplicated");
  assert.deepEqual(createCentralInputDictionary(structuredClone(input), structuredClone(entries)), dictionary);
  const body = centralInputHandle(dictionary, "source", "source:original"), read = centralInputHandle(dictionary, "read", "source:original");

  assert.notEqual(body, read);
  const resolve = bindCentralInputDictionary(input, dictionary);

  assert.equal(resolve(body, "source"), "source:original");
  assert.equal(resolve(read, "read"), "source:original");
  assert.throws(() => resolve(read, "source"), /central_input_handle_kind_mismatch/);
  assert.equal(resolveCentralInputHandle(input, dictionary, body, "source"), "source:original");
  assert.equal(resolveCentralInputHandle(input, dictionary, read, ["read", "reference"]), "source:original");
  assert.throws(() => resolveCentralInputHandle(input, dictionary, read, "source"), /central_input_handle_kind_mismatch/);
  assert.throws(() => centralInputHandle(dictionary, "reference", "source:original"), /central_input_entry_unknown/);
});

test("all input kinds remain distinct scalar identities including the reserved span kind", () => {
  const input = request(), kinds: readonly CentralInputKind[] = ["source", "read", "intent", "operation", "opportunity",
    "organization_recall", "organization_feedback", "organization_knowledge", "organization_revision", "reference", "span"];
  const dictionary = createCentralInputDictionary(input, kinds.map(kind => ({ kind, ref: "same:typed-reference" })));

  assert.equal(new Set(dictionary.entries.map(entry => entry.handle)).size, kinds.length);

  for (const kind of kinds) {
    const handle = centralInputHandle(dictionary, kind, "same:typed-reference");
    assert.equal(resolveCentralInputHandle(input, dictionary, handle, kind), "same:typed-reference");
  }
});

test("a changed checkpoint cannot reuse an earlier request's handles or dictionary", () => {
  const input = request(), entries = [{ kind: "source" as const, ref: "source:original" }];
  const dictionary = createCentralInputDictionary(input, entries), handle = centralInputHandle(dictionary, "source", "source:original");
  const changed = { ...input, materials: [{ ...input.materials[0]!, text: "The receiver now takes milliseconds." }] };
  const next = createCentralInputDictionary(changed, entries);

  assert.notEqual(next.checkpoint, dictionary.checkpoint);
  assert.notEqual(centralInputHandle(next, "source", "source:original"), handle);
  assert.throws(() => bindCentralInputDictionary(changed, dictionary), /central_input_checkpoint_mismatch/);
  assert.throws(() => resolveCentralInputHandle(changed, dictionary, handle, "source"), /central_input_checkpoint_mismatch/);
  assert.throws(() => resolveCentralInputHandle(changed, next, handle, "source"), /central_input_handle_unknown/);
  Object.assign(input.materials[0]!, { text: "The original input object was modified." });
  assert.throws(() => resolveCentralInputHandle(input, dictionary, handle, "source"), /central_input_checkpoint_mismatch/);
});

test("unknown handles and forged or mutated dictionaries fail without a reference fallback", () => {
  const input = request(), dictionary = createCentralInputDictionary(input, [{ kind: "source", ref: "source:original" }]);
  const handle = dictionary.entries[0]!.handle;

  assert.ok(Object.isFrozen(dictionary));
  assert.ok(Object.isFrozen(dictionary.entries));
  assert.ok(Object.isFrozen(dictionary.entries[0]));
  assert.throws(() => Object.assign(dictionary.entries[0]!, { ref: "source:forged" }), TypeError);
  assert.throws(() => resolveCentralInputHandle(input, dictionary, "source:original", "source"), /central_input_handle_unknown/);
  assert.throws(() => resolveCentralInputHandle(input, dictionary, handle, []), /central_input_kind_invalid/);
  assert.throws(() => resolveCentralInputHandle(input, dictionary, handle, "unknown" as CentralInputKind), /central_input_kind_invalid/);

  for (const forged of [structuredClone(dictionary), { ...dictionary, checkpoint: "central-input-checkpoint:forged" },
    { ...dictionary, entries: [{ ...dictionary.entries[0]!, ref: "source:forged" }] }]) {
    assert.throws(() => bindCentralInputDictionary(input, forged as CentralInputDictionary), /central_input_dictionary_invalid/);
    assert.throws(() => resolveCentralInputHandle(input, forged as CentralInputDictionary, handle, "source"), /central_input_dictionary_invalid/);
    assert.throws(() => centralInputHandle(forged as CentralInputDictionary, "source", "source:original"), /central_input_dictionary_invalid/);
  }

  assert.throws(() => createCentralInputDictionary(input, [{ kind: "unknown" as CentralInputKind, ref: "source:original" }]), /central_input_kind_invalid/);
  assert.throws(() => createCentralInputDictionary(input, [{ kind: "source", ref: "" }]), /central_input_reference_invalid/);
});
