import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage, ProviderNativeRequestIdentity, ProviderRequest } from "../ports/provider.js";
import type { ReportedRequestBasis } from "./compact-boundary.js";
import * as measurement from "./prompt-measurement.js";

type NativeIdentity = ProviderNativeRequestIdentity | null | undefined;

const capture: (request: ProviderRequest, native?: NativeIdentity) => measurement.PromptMeasurement & { readonly nativeIdentity?: NativeIdentity }
  = measurement.capturePromptMeasurement;
const basis: (request: ProviderRequest, local: number, report: ReportedRequestBasis | undefined, window: string | undefined,
  estimate: (messages: readonly ProviderMessage[]) => number, native?: NativeIdentity,
  estimateText?: (messages: readonly ProviderMessage[]) => number) => number = measurement.preparedRequestTokenBasis;
const EMPTY = "e".repeat(64), OLD = "a".repeat(64), NEW = "b".repeat(64), SCOPE = "c".repeat(64);
const assistant: ProviderMessage = { role: "assistant", content: "same completed public answer" };
const host: ProviderMessage = { role: "system", content: "stable host suffix" };
const request: ProviderRequest = { attemptId: "test", model: "fixture", tools: [], messages: [assistant, host] };
const identity = (): ProviderNativeRequestIdentity => ({ messageFieldDigests: [OLD, EMPTY], messageOverheadTokens: [10, 0], requestDigest: SCOPE });
const reportFor = (native: NativeIdentity): ReportedRequestBasis => ({ promptTokens: 950, transcriptLength: 2,
  windowId: undefined, measurement: capture(request, native) });
const textEstimate = (messages: readonly ProviderMessage[]) => messages.length * 5;

test("changed native input invalidates an otherwise identical prepared request measurement", () => {
  const next = { ...identity(), messageFieldDigests: [NEW, EMPTY] };
  assert.equal(basis(request, 100, reportFor(identity()), undefined, textEstimate, next, textEstimate), 100);
});

test("new duplicate assistant input charges native overhead from the full occurrence lookup", () => {
  const next = { ...request, messages: [assistant, assistant, host] };
  const native = { messageFieldDigests: [OLD, NEW, EMPTY], messageOverheadTokens: [10, 70, 0], requestDigest: SCOPE };
  // An isolated duplicate subset has no native match. Its text estimate alone
  // must not erase the new occurrence's full-request native input.
  assert.equal(basis(next, 100, reportFor(identity()), undefined, textEstimate, native, textEstimate), 950 + 5 + 70);
});

test("a changed native scope invalidates the old server basis", () => {
  const next = { ...identity(), requestDigest: NEW };
  assert.equal(basis(request, 100, reportFor(identity()), undefined, textEstimate, next, textEstimate), 100);
});

test("a captured native identity is immutable and contains no extra owner payload", () => {
  const original = { messageFieldDigests: [OLD, EMPTY], messageOverheadTokens: [10, 0], requestDigest: SCOPE, privateText: "PRIVATE_OWNER_TEXT" };
  const captured = capture(request, original);
  original.messageFieldDigests[0] = NEW;
  original.messageOverheadTokens[0] = 999;
  assert.deepEqual(captured.nativeIdentity, identity());
  assert.equal(JSON.stringify(captured).includes("PRIVATE_OWNER_TEXT"), false);
});

test("unverifiable native input cannot keep an older server floor", () => {
  assert.equal(basis(request, 100, reportFor(null), undefined, textEstimate, null, textEstimate), 100);
});

test("native input introduced after a plain measurement invalidates that basis", () => {
  assert.equal(basis(request, 100, reportFor(undefined), undefined, textEstimate, identity(), textEstimate), 100);
});

test("native reuse requires a pure text estimator for newly added messages", () => {
  const next = { ...request, messages: [assistant, { role: "user" as const, content: "new input" }, host] };
  const native = { messageFieldDigests: [OLD, EMPTY, EMPTY], messageOverheadTokens: [10, 0, 0], requestDigest: SCOPE };
  assert.equal(basis(next, 100, reportFor(identity()), undefined, textEstimate, native), 100);
});

test("plain providers retain the unchanged server measurement", () => {
  assert.equal(basis(request, 100, reportFor(undefined), undefined, textEstimate), 950);
});

test("an unavailable or throwing native measurement owner cannot break an iteration", () => {
  const measure: unknown = Reflect.get(measurement, "measureNativeRequestIdentity");
  assert.equal(typeof measure, "function");
  if (typeof measure !== "function") return;
  const continuation = { capture: () => undefined, restore: () => {}, measureRequestIdentity() { throw new Error("private source error"); } };
  assert.equal(measure({ continuation }, request), null);
});

for (const sparse of ["digests", "overhead"] as const) test(`sparse native ${sparse} cannot authorize reuse of a server measurement`, () => {
  const native = sparse === "digests" ? { ...identity(), messageFieldDigests: Array<string>(2) }
    : { ...identity(), messageOverheadTokens: Array<number>(2) };
  assert.equal(capture(request, native).nativeIdentity, null);
  assert.equal(basis(request, 100, reportFor(native), undefined, textEstimate, native, textEstimate), 100);
});
