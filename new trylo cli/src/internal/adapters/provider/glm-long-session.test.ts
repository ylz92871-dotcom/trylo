import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage } from "../../ports/provider.js";
import type { NativeCheckpointState } from "./glm-continuation-checkpoint.js";
import { createGlmContinuationCache } from "./glm-continuation-cache.js";

function native(index: number, reasoning = `NATIVE_${index}`, repeated = false): NativeCheckpointState {
  return { kind: "native", assistant: { text: repeated ? "Repeated." : `Response ${index}`,
    calls: [{ toolCallId: repeated ? "same-call" : `call-${index}`, name: "read_file", arguments: { path: repeated ? "same.txt" : `file-${index}.txt` } }], reasoning } };
}

function message(state: NativeCheckpointState): ProviderMessage {
  const identity = state.kind === "native" ? state.assistant : state.identity;
  return { role: "assistant", content: identity.text, toolCalls: identity.calls };
}

test("115 small native responses survive while the existing character budget is unspent", () => {
  const cache = createGlmContinuationCache();
  const states = Array.from({ length: 115 }, (_, index) => native(index, `NATIVE_${index}_`.repeat(100)));
  const messages = states.map(message);
  for (const state of states) assert.deepEqual(cache.retain(state), []);
  const lookup = cache.matching(messages);
  assert.deepEqual(messages.map(item => lookup.matched.get(item)), states);
  assert.ok(cache.estimateOverheadTokens(messages) > 0);
});

test("small absent markers do not displace earlier native reasoning after 32 responses", () => {
  const cache = createGlmContinuationCache(), first = native(0), states: NativeCheckpointState[] = [first];
  cache.retain(first);
  for (let index = 1; index <= 80; index += 1) {
    const absent: NativeCheckpointState = { kind: "absent", identity: { text: `No native ${index}`, calls: [] } };
    states.push(absent); cache.retain(absent);
  }
  const messages = states.map(message), lookup = cache.matching(messages);
  assert.equal(lookup.matched.size, states.length);
  assert.equal(lookup.matched.get(messages[0]!), first);
});

test("115 repeated identities preserve every ordered occurrence without guessing", () => {
  const cache = createGlmContinuationCache();
  const states = Array.from({ length: 115 }, (_, index) => native(index, `DISTINCT_${index}`, true));
  states.forEach(state => cache.retain(state));
  const messages = states.map(message), lookup = cache.matching(messages);
  assert.equal(lookup.ambiguous.size, 0);
  assert.deepEqual(messages.map(item => lookup.matched.get(item)), states);
  const shortened = messages.slice(1), partial = cache.matching(shortened);
  assert.equal(partial.matched.size, 0);
  assert.equal(partial.ambiguous.size, shortened.length);
});

test("the original one-million-character ceiling still evicts whole oldest responses", () => {
  const cache = createGlmContinuationCache();
  const states = Array.from({ length: 5 }, (_, index) => native(index, String(index).repeat(262_144), true));
  states.forEach(state => cache.retain(state));
  const full = states.map(message);
  assert.equal(cache.matching(full).matched.size, 0);
  const tail = full.slice(1), lookup = cache.matching(tail);
  assert.deepEqual(tail.map(item => lookup.matched.get(item)), states.slice(1));
});

test("large identities without reasoning are bounded by serialized bytes too", () => {
  const cache = createGlmContinuationCache();
  const states: NativeCheckpointState[] = Array.from({ length: 12 }, (_, index) => ({ kind: "absent", identity: {
    text: `Marker ${index}`, calls: [{ toolCallId: `large-${index}`, name: "write_file", arguments: { content: "中".repeat(150_000) } }],
  } }));
  states.forEach(state => cache.retain(state));
  const messages = states.map(message), lookup = cache.matching(messages);
  assert.ok(lookup.matched.size > 0 && lookup.matched.size < states.length);
  assert.equal(lookup.matched.get(messages.at(-1)!), states.at(-1));
});

test("an individually oversized identity cannot evict a valid retained response", () => {
  const cache = createGlmContinuationCache(), valid = native(1);
  cache.retain(valid);
  const oversized: NativeCheckpointState = { kind: "absent", identity: { text: "x".repeat(4_300_000), calls: [] } };
  assert.equal(cache.retain(oversized).length, 1);
  const validMessage = message(valid), tooLargeMessage = message(oversized), lookup = cache.matching([validMessage, tooLargeMessage]);
  assert.equal(lookup.matched.get(validMessage), valid);
  assert.equal(lookup.matched.has(tooLargeMessage), false);
});

test("rebinding preserves native payload and cannot exceed the resident byte budget", () => {
  const cache = createGlmContinuationCache(), state = native(1);
  cache.retain(state);
  assert.equal(state.kind, "native");
  if (state.kind !== "native") return;
  const huge: NativeCheckpointState = { kind: "native", assistant: { ...state.assistant, text: "x".repeat(4_300_000) } };
  assert.equal(cache.replaceLast(state, huge), false);
  const rebound: NativeCheckpointState = { kind: "native", assistant: { ...state.assistant, text: "Canonical response." } };
  assert.equal(cache.replaceLast(state, rebound), true);
  const item = message(rebound);
  assert.equal(cache.matching([item]).matched.get(item), rebound);
});

test("clear resets both payload budgets for the next scope", () => {
  const cache = createGlmContinuationCache();
  for (let index = 0; index < 4; index += 1) cache.retain(native(index, "r".repeat(262_144)));
  cache.clear();
  const states = Array.from({ length: 115 }, (_, index) => native(index));
  for (const state of states) assert.deepEqual(cache.retain(state), []);
  assert.equal(cache.matching(states.map(message)).matched.size, states.length);
});
