import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage, ProviderNativeRequestIdentity, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { CompactWindow } from "../ports/compaction.js";
import type { ReportedRequestBasis } from "./compact-boundary.js";
import { capturePromptMeasurement, evaluatePreparedRequestBudget } from "./prompt-measurement.js";
import { capturePersistableInputIdentity } from "./prompt-input-identity.js";
import { captureStoredInputBasis, isStoredPromptInputBasisV1 } from "./prompt-input-basis.js";
import { boundMessagesTextTokens } from "../compaction/token-estimate.js";

const A = "a".repeat(64), B = "b".repeat(64), EMPTY = "e".repeat(64);
const provider: ProviderPort = { inputBindingDigest: () => A, async *stream() { throw new Error("No stream in pure measurement tests"); } };
const request: ProviderRequest = { attemptId: "old", continuationScope: "old-operation", model: "fixture", tools: [],
  messages: [{ role: "system", content: "old host" }, { role: "user", content: "request" }, { role: "assistant", content: "PUBLIC_ANSWER" }] };
const native = (fields: readonly string[] = [EMPTY, EMPTY, A]): ProviderNativeRequestIdentity => ({
  requestDigest: A, messageFieldDigests: fields, messageOverheadTokens: fields.map(() => 0) });
const estimate = (messages: readonly ProviderMessage[]) => messages.length * 5;

test("resumed automatic pressure retains the measured/history floor without billing a replaced host twice", () => {
  const input = { kind: "complete_prompt" as const, source: "provider_complete_input" as const, tokens: 900 };
  const measurement = capturePromptMeasurement(request, undefined, capturePersistableInputIdentity(provider, request, undefined));
  const stored = captureStoredInputBasis(measurement, input);
  assert.ok(stored);
  const current = { ...request, messages: [...request.messages.slice(1), { role: "assistant" as const, content: "New evidence" },
    { role: "system" as const, content: "New host state" }] };
  const reported: ReportedRequestBasis = { promptTokens: 900, transcriptLength: request.messages.length, windowId: undefined, storedInputBasis: stored };
  const binding = capturePersistableInputIdentity(provider, current, undefined);
  const admission = evaluatePreparedRequestBudget(current, 100, reported, undefined, estimate, undefined, undefined, binding);
  const automatic = evaluatePreparedRequestBudget(current, 100, reported, undefined, estimate, undefined, undefined, binding, "automatic");
  assert.equal(admission.decision.tokens, 910);
  assert.equal(automatic.decision.tokens, 905);
  assert.equal(automatic.exactInputTokens, undefined);
});

test("a complete measured prefix is retained while appended text uses its byte-level bound", () => {
  const previous: ProviderRequest = { attemptId: "previous", model: "fixture", tools: [],
    messages: [{ role: "user", content: "Measured history" }] };
  const reported: ReportedRequestBasis = { promptTokens: 848223, transcriptLength: 1, windowId: "same",
    measurement: capturePromptMeasurement(previous),
    inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 848223 } };
  const tail = String.fromCodePoint(0xf0137).repeat(1000);
  const current: ProviderRequest = { ...previous, attemptId: "next", messages: [...previous.messages, { role: "assistant", content: tail }] };
  const decision = evaluatePreparedRequestBudget(current, boundMessagesTextTokens(current.messages), reported, "same", boundMessagesTextTokens).decision;

  assert.equal(decision.basis, "server_plus_added");
  assert.equal(decision.observedInputTokens, 848223);
  assert.equal(decision.addedTokens, Buffer.byteLength(tail, "utf8"));
  assert.equal(decision.tokens, 848223 + Buffer.byteLength(tail, "utf8"), "the measured prefix is not multiplied by the local bound");
});

test("zero-valued text additions cannot certify unchanged active or restored complete input", () => {
  const previous: ProviderRequest = { attemptId: "old", model: "fixture", tools: [], messages: [
    { role: "system", content: "old host cost" }, { role: "user", content: "same user" },
  ] };
  const input = { kind: "complete_prompt" as const, source: "provider_complete_input" as const, tokens: 900 };
  const binding = capturePersistableInputIdentity(provider, previous, undefined);
  const measurement = capturePromptMeasurement(previous, undefined, binding);
  const stored = captureStoredInputBasis(measurement, input);
  assert.ok(stored);
  const active: ReportedRequestBasis = { promptTokens: 900, transcriptLength: 2, windowId: undefined,
    measurement, inputTokenObservation: input };

  for (const [reported, exactInputTokens] of [[active, 900], [{ ...active, storedInputBasis: stored }, undefined]] as const) {
    const evaluate = (current: ProviderRequest) => evaluatePreparedRequestBudget(current, boundMessagesTextTokens(current.messages),
      reported, undefined, boundMessagesTextTokens, undefined, undefined,
      capturePersistableInputIdentity(provider, current, undefined));
    assert.equal(evaluate(previous).exactInputTokens, exactInputTokens,
      "only full active input identity proves exactness; grouped durable commitments do not preserve cross-role order");

    for (const messages of [previous.messages.slice(1), [{ role: "system" as const, content: "" }, previous.messages[1]!],
      [...previous.messages, { role: "user" as const, content: "" }], [previous.messages[1]!, previous.messages[0]!]]) {
      const evaluation = evaluate({ ...previous, messages });
      assert.equal(evaluation.decision.addedTokens, 0);
      assert.equal(evaluation.exactInputTokens, undefined, "deleted systems and empty new occurrences still change input identity");
    }
  }
});

function capture(input = request, identity: ProviderNativeRequestIdentity | null | undefined = native(), window?: CompactWindow) {
  return capturePromptMeasurement(input, identity, capturePersistableInputIdentity(provider, input, window));
}

function report(tokens = 100, window?: CompactWindow, identity: ProviderNativeRequestIdentity | undefined = native()): ReportedRequestBasis {
  const stored = captureStoredInputBasis(capture(request, identity, window), { kind: "complete_prompt", source: "provider_complete_input", tokens });
  assert.ok(stored);
  return { promptTokens: tokens, transcriptLength: 0, windowId: undefined, storedInputBasis: stored };
}

function evaluate(input = request, prior = report(), identity: ProviderNativeRequestIdentity | null | "none" = native(),
  currentProvider = provider, window?: CompactWindow) {
  return evaluatePreparedRequestBudget(input, 1000, prior, window?.windowId, estimate, identity === "none" ? undefined : identity, estimate,
    capturePersistableInputIdentity(currentProvider, input, window)).decision;
}

test("stored complete input survives a new operation scope and adds only new occurrences", () => {
  const input = { ...request, attemptId: "new", continuationScope: "new-operation",
    messages: [...request.messages, { role: "user" as const, content: "next question" }] };
  const next = { ...native([EMPTY, EMPTY, A, EMPTY]), requestDigest: B };
  const decision = evaluate(input, report(), next);

  assert.equal(decision.basis, "server_plus_added");
  assert.equal(decision.tokens, 105);
  assert.equal(decision.observedInputTokens, 100);
  assert.equal(decision.addedTokens, 5);
});

test("a genuine complete input count of zero survives persistence", () => {
  assert.equal(evaluate(request, report(0)).tokens, 0);
});

test("providers without native continuation still require explicit effective input proof", () => {
  const measured = capturePromptMeasurement(request, undefined, capturePersistableInputIdentity(provider, request, undefined));
  const stored = captureStoredInputBasis(measured, { kind: "complete_prompt", source: "provider_complete_input", tokens: 100 });
  assert.ok(stored);
  assert.equal(evaluate(request, { ...report(), storedInputBasis: stored }, "none").tokens, 100);
});

test("provider configuration proof is required and changes invalidate input", () => {
  assert.equal(evaluate(request, report(), native(), { async *stream() {} }).reason, "input_binding_unavailable");
  assert.equal(evaluate(request, report(), native(), { ...provider, inputBindingDigest: () => B }).reason, "input_binding_changed");
});

test("model, tools and input schema changes cannot reuse a stored count", () => {
  assert.equal(evaluate({ ...request, model: "changed" }).reason, "model_changed");
  assert.equal(evaluate({ ...request, tools: [{ name: "new", description: "new", parameters: {} }] }).reason, "tools_changed");
  assert.equal(evaluate({ ...request, responseSchema: { type: "object" } }).reason, "request_settings_changed");
});

test("window identity rejects a changed summary but survives durable sequence remapping", () => {
  const window: CompactWindow = { formatVersion: "1", windowId: "w1", replacedFromSequence: 2, replacedToSequence: 20, summary: "old" };

  assert.equal(evaluate(request, report(100, window), native(), provider, window).basis, "server_plus_added");
  assert.equal(evaluate(request, report(100, window), native(), provider, { ...window, summary: "new" }).reason, "window_changed");
  // The writer maps core transcript bounds to journal coordinates. The actual
  // history/native commitments still have to match the same projected input.
  assert.equal(evaluate(request, report(100, window), native(), provider,
    { ...window, replacedFromSequence: 200, replacedToSequence: 210 }).basis, "server_plus_added");
});

test("changed or unverifiable native input is never credited as the old input", () => {
  assert.equal(evaluate(request, report(), null).reason, "native_unverifiable");
  assert.equal(evaluate(request, report(), "none").reason, "native_changed");
  assert.equal(evaluate(request, report(), native([EMPTY, EMPTY, B])).basis, "local");
});

test("ordered commitment rejects deletion, reorder and a changed duplicate occurrence", () => {
  const duplicate = { ...request, messages: [...request.messages, request.messages[2]!] };
  const stored = captureStoredInputBasis(capture(duplicate, native([EMPTY, EMPTY, A, B])),
    { kind: "complete_prompt", source: "provider_complete_input", tokens: 100 });

  assert.ok(stored);
  const prior = { ...report(), storedInputBasis: stored };

  assert.equal(evaluate(request, prior).reason, "history_changed");
  assert.equal(evaluate(duplicate, prior, native([EMPTY, EMPTY, B, A])).basis, "local");
  const reordered = { ...request, messages: [request.messages[0]!, request.messages[2]!, request.messages[1]!] };

  assert.equal(evaluate(reordered, report(), native([EMPTY, A, EMPTY])).reason, "history_changed");
});

test("middle insertions cannot be proved by a compact prefix commitment", () => {
  const inserted = { ...request, messages: [request.messages[0]!, request.messages[1]!,
    { role: "user" as const, content: "inserted" }, request.messages[2]!] };
  assert.equal(evaluate(inserted, report(), native([EMPTY, EMPTY, EMPTY, A])).reason, "history_changed");
});

test("replaced systems retain the whole old server charge and add the new system", () => {
  const changed = { ...request, messages: [{ role: "system" as const, content: "new host" }, ...request.messages.slice(1)] };
  assert.equal(evaluate(changed).tokens, 105);
  assert.equal(evaluate(changed, report(), native([B, EMPTY, A])).reason, "native_changed");
});

test("new native overhead uses the full outgoing occurrence lookup", () => {
  const input = { ...request, messages: [...request.messages, request.messages[2]!] };
  const identity = { ...native([EMPTY, EMPTY, A, B]), messageOverheadTokens: [0, 0, 0, 77] };
  assert.equal(evaluate(input, report(), identity).tokens, 182);
});

test("new images cannot be given text-only price credit", () => {
  const input = { ...request, messages: [...request.messages, { role: "user" as const, content: "picture",
    imageReferences: [{ path: "image.png", sha256: A, bytes: 1, detail: "high" as const }] }] };
  assert.equal(evaluate(input, report(), native([EMPTY, EMPTY, A, EMPTY])).reason, "unpriced_media");
});

test("stored identity has fixed fields and does not retain text or occurrence arrays", () => {
  const input = { ...request, messages: Array.from({ length: 10000 }, () => ({ role: "user" as const, content: "PRIVATE_TEXT_MARKER" })) };
  const measured = capturePromptMeasurement(input, undefined, capturePersistableInputIdentity(provider, input, undefined));
  const stored = captureStoredInputBasis(measured, { kind: "complete_prompt", source: "provider_complete_input", tokens: 99999 });

  assert.ok(stored);
  assert.equal(stored.nonSystem.count, 10000);
  assert.ok(JSON.stringify(stored).length < 1000);
  assert.equal(JSON.stringify(stored).includes("PRIVATE_TEXT_MARKER"), false);
  assert.equal(JSON.stringify(stored).includes("messageDigests"), false);
});

test("unknown versions, aliases, bad counts and extra fields are unavailable", () => {
  for (const [field, value] of [["version", 2], ["nativeMode", "guessed"], ["extra", "unexpected"]] as const) {
    const bad = structuredClone(report().storedInputBasis!);
    Reflect.set(bad, field, value);
    assert.equal(isStoredPromptInputBasisV1(bad), false);
  }

  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = structuredClone(report().storedInputBasis!);
    Reflect.set(bad.input, "tokens", value);
    assert.equal(isStoredPromptInputBasisV1(bad), false);
  }

  const alias = structuredClone(report().storedInputBasis!);
  Reflect.set(alias.input, "source", "normalized_input_alias");
  assert.equal(isStoredPromptInputBasisV1(alias), false);
});
