import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage, ProviderNativeRequestIdentity, ProviderRequest } from "../ports/provider.js";
import type { ReportedRequestBasis } from "./compact-boundary.js";
import * as measurement from "./prompt-measurement.js";

const system = (content: string): ProviderMessage => ({ role: "system", content });
const user = (content: string): ProviderMessage => ({ role: "user", content });
const assistant: ProviderMessage = { role: "assistant", content: "same completed exchange" };
const oldHost = system("PA state before"), newHost = system("PA state after");
const base: ProviderRequest = { attemptId: "before", model: "fixture-model", tools: [],
  messages: [system("Stable project rules"), user("Current task"), oldHost] };
const estimate = (messages: readonly ProviderMessage[]): number => messages.reduce((sum, item) => sum + Math.ceil(Buffer.byteLength(item.content) / 4), 0);
const E = "e".repeat(64), A = "a".repeat(64), B = "b".repeat(64), SCOPE = "c".repeat(64);
const DEFAULT_OBSERVATION = Symbol("complete-source fixture");
const NO_OBSERVATION = Symbol("unknown-source fixture");
const native = (digests: readonly string[], overhead: readonly number[], scope = SCOPE): ProviderNativeRequestIdentity => ({
  requestDigest: scope, messageFieldDigests: digests, messageOverheadTokens: overhead,
});

function report(request = base, tokens = 700, observed: unknown = DEFAULT_OBSERVATION,
  identity?: ProviderNativeRequestIdentity | null): ReportedRequestBasis {
  const output: ReportedRequestBasis = { promptTokens: tokens, transcriptLength: request.messages.length,
    windowId: undefined, measurement: measurement.capturePromptMeasurement(request, identity) };
  if (observed !== undefined && observed !== NO_OBSERVATION) Reflect.set(output, "inputTokenObservation", observed === DEFAULT_OBSERVATION
    ? { kind: "complete_prompt", source: "provider_complete_input", tokens } : observed);
  return output;
}

function basis(request: ProviderRequest, local: number, previous = report(), identity?: ProviderNativeRequestIdentity | null,
  window?: string): number {
  return measurement.preparedRequestTokenBasis(request, local, previous, window, estimate, identity, estimate);
}

test("complete prompt observation can replace the higher local estimate without subtracting old fees", () => {
  assert.equal(basis(base, 826), 700);
});

test("same legacy numeric input with unknown provenance retains the old local floor", () => {
  assert.equal(basis(base, 826, report(base, 700, NO_OBSERVATION)), 826);
});

test("known complete zero remains a distinct explicit observation", () => {
  assert.equal(basis(base, 826, report(base, 100, { kind: "complete_prompt", source: "provider_complete_input", tokens: 0 })), 0);
});

test("complete prompt count is independent of the old accounting input count", () => {
  assert.equal(basis(base, 826, report(base, 300, { kind: "complete_prompt", source: "provider_complete_input", tokens: 700 })), 700);
});

test("changed PA system is charged in full on top of the old server count", () => {
  const next = { ...base, messages: [...base.messages.slice(0, -1), newHost] };
  assert.equal(basis(next, 100), 700 + estimate([newHost]));
});

test("automatic maintenance re-estimates replacement systems without weakening admission or dropping added history", () => {
  const next = { ...base, messages: [...base.messages.slice(0, -1), assistant, newHost] };
  const previous = report();
  const admission = measurement.evaluatePreparedRequestBudget(next, 100, previous, undefined, estimate);
  const automatic = measurement.evaluatePreparedRequestBudget(next, 100, previous, undefined, estimate,
    undefined, undefined, undefined, "automatic");
  assert.equal(admission.decision.tokens, 700 + estimate([assistant, newHost]));
  assert.equal(automatic.decision.tokens, 700 + estimate([assistant]));
  assert.equal(automatic.exactInputTokens, undefined, "a forecast cannot claim a full current provider measurement");
});

test("removed old system keeps its old server cost instead of an estimated saving", () => {
  const next = { ...base, messages: base.messages.filter(item => item.role !== "system") };
  assert.equal(basis(next, 100), 700);
});

test("new messages before a changed host suffix add their full estimated cost", () => {
  const added = assistant;
  const next = { ...base, messages: [...base.messages.slice(0, -1), added, newHost] };
  assert.equal(basis(next, 100), 700 + estimate([added, newHost]));
});

test("reverse density fixture preserves high observed input after a system replacement", () => {
  const added = user(String.fromCodePoint(0x20000).repeat(100));
  const next = { ...base, messages: [...base.messages.slice(0, -1), added, newHost] };
  // Explicit hypothetical complete-source metadata, not retrofitted historical provenance.
  assert.equal(basis(next, 246_227, report(base, 903_460)), 903_460 + estimate([added, newHost]));
});

test("unknown source does not acquire system-replacement calibration", () => {
  const next = { ...base, messages: [...base.messages.slice(0, -1), newHost] };
  assert.equal(basis(next, 100, report(base, 700, NO_OBSERVATION)), 100);
});

for (const bad of [{ kind: "complete_prompt", source: "input_tokens", tokens: 700 },
  { kind: "complete_prompt", source: "openai_prompt_tokens", tokens: 700 },
  { kind: "complete_prompt", source: "provider_complete_input", tokens: -1 },
  { kind: "complete_prompt", source: "provider_complete_input", tokens: NaN }]) {
  test(`unproven observation ${String(bad.source)}:${String(bad.tokens)} retains the legacy floor`, () => {
    assert.equal(basis(base, 826, report(base, 700, bad)), 826);
  });
}

test("old measurements without model/settings/roles cannot enable the new lower basis", () => {
  const captured = measurement.capturePromptMeasurement(base);
  const previous = report();
  Reflect.set(previous, "measurement", { messageDigests: captured.messageDigests, toolDigest: captured.toolDigest });
  assert.equal(basis(base, 826, previous), 826);
});

test("model changes invalidate even canonically identical message history", () => {
  assert.equal(basis({ ...base, model: "another-model" }, 100), 100);
});

for (const [name, changes] of [
  ["scope", { continuationScope: "another-scope" }],
  ["schema", { responseSchema: { type: "object", properties: { x: { type: "string" } } } }],
  ["format", { responseFormat: { type: "json_object" as const } }],
] as const) test(`input ${name} changes invalidate the old basis`, () => {
  assert.equal(basis({ ...base, ...changes }, 100), 100);
});

test("attempt identifiers and return observation flags do not change input identity", () => {
  assert.equal(basis({ ...base, attemptId: "after", observeReturn: true }, 826), 700);
});

test("output allowance changes do not invalidate the measured input", () => {
  const previousRequest = { ...base, maxOutputTokens: 200 };
  assert.equal(basis({ ...previousRequest, maxOutputTokens: 50 }, 826, report(previousRequest)), 700);
});

test("system directives already reflected in messages are not an independent input charge", () => {
  const previousRequest = { ...base, systemPromptAppend: "before" };
  const next = { ...previousRequest, systemPromptAppend: "after", messages: [...base.messages.slice(0, -1), newHost] };
  assert.equal(basis(next, 100, report(previousRequest)), 700 + estimate([newHost]));
});

test("removing a previously measured non-system message prevents calibration", () => {
  const next = { ...base, messages: base.messages.filter(item => item.role === "system") };
  assert.equal(basis(next, 100), 100);
});

test("old non-system messages must retain order", () => {
  const before = { ...base, messages: [user("one"), user("two"), oldHost] };
  const after = { ...before, messages: [user("two"), user("one"), newHost] };
  assert.equal(basis(after, 100, report(before)), 100);
});

test("duplicate occurrences are charged separately rather than collapsed into a set", () => {
  const before = { ...base, messages: [assistant, oldHost] };
  const after = { ...before, messages: [assistant, assistant, newHost] };
  assert.equal(basis(after, 100, report(before)), 700 + estimate([assistant, newHost]));
});

test("duplicate native occurrences use full-request index overhead, not an isolated subset", () => {
  const before = { ...base, messages: [assistant, oldHost] };
  const after = { ...before, messages: [assistant, assistant, newHost] };
  const oldNative = native([A, E], [10, 0]), nextNative = native([B, A, E], [70, 10, 0]);
  assert.equal(basis(after, 100, report(before, 700, { kind: "complete_prompt", source: "provider_complete_input", tokens: 700 }, oldNative), nextNative),
    700 + estimate([assistant, newHost]) + 70);
});

test("changed old native fields invalidate a public-only match", () => {
  const before = { ...base, messages: [assistant, oldHost] };
  assert.equal(basis(before, 100, report(before, 700, { kind: "complete_prompt", source: "provider_complete_input", tokens: 700 }, native([A, E], [10, 0])),
    native([B, E], [10, 0])), 100);
});

test("a new native scope cannot reuse old server input", () => {
  assert.equal(basis(base, 100, report(base, 700, { kind: "complete_prompt", source: "provider_complete_input", tokens: 700 }, native([E, E, E], [0, 0, 0])),
    native([E, E, E], [0, 0, 0], B)), 100);
});

test("unverifiable native fields keep the local path", () => {
  assert.equal(basis(base, 100, report(base, 700, { kind: "complete_prompt", source: "provider_complete_input", tokens: 700 }, null), null), 100);
});

test("tool schemas and compaction windows still invalidate reports", () => {
  assert.equal(basis({ ...base, tools: [{ name: "new", description: "new", parameters: {} }] }, 100), 100);
  assert.equal(basis(base, 100, report(), undefined, "new-window"), 100);
});

test("capture retains immutable model/settings/roles without plaintext", () => {
  const request: ProviderRequest = { ...base, messages: [user("PRIVATE_SYNTHETIC_SENTINEL")], responseSchema: { type: "object" } };
  const captured = measurement.capturePromptMeasurement(request);
  assert.equal(Reflect.get(captured, "model"), request.model);
  assert.deepEqual(Reflect.get(captured, "messageRoles"), ["user"]);
  assert.match(String(Reflect.get(captured, "settingsDigest")), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(captured).includes("PRIVATE_SYNTHETIC_SENTINEL"), false);
});
