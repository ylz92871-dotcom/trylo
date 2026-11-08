import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage, ProviderRequest } from "../ports/provider.js";
import type { ReportedRequestBasis } from "./compact-boundary.js";
import * as measurement from "./prompt-measurement.js";

const system = (content: string): ProviderMessage => ({ role: "system", content });
const user = (content: string): ProviderMessage => ({ role: "user", content });
const base: ProviderRequest = { attemptId: "before", model: "fixture", tools: [], messages: [system("project rules"), user("current task")] };
const estimate = (messages: readonly ProviderMessage[]) => messages.reduce((sum, message) => sum + Math.ceil(Buffer.byteLength(message.content) / 4), 0);
const attachment = { mediaType: "image/png" as const, dataBase64: "AA==", bytes: 1, detail: "high" as const };
const reference = { path: "synthetic.png", sha256: "a".repeat(64), bytes: 1, detail: "high" as const };

function report(request: ProviderRequest): ReportedRequestBasis {
  return { promptTokens: 700, transcriptLength: request.messages.length, windowId: undefined,
    measurement: measurement.capturePromptMeasurement(request),
    inputTokenObservation: { kind: "complete_prompt", source: "provider_complete_input", tokens: 700 } };
}

function basis(request: ProviderRequest, previous: ReportedRequestBasis): number {
  return measurement.preparedRequestTokenBasis(request, 826, previous, undefined, estimate);
}

for (const [name, digests] of [
  ["short digest", ["bad"]], ["non-hex digest", ["g".repeat(64)]],
  ["sparse digest array", new Array<string>(1)], ["missing digest array", null],
] as const) test(`malformed all-system measurement ${name} cannot authorize a lower basis`, () => {
  const request = { ...base, messages: [system("project rules")] };
  const previous = report(request);
  Reflect.set(previous.measurement!, "messageDigests", digests);
  assert.equal(basis(request, previous), 826);
});

test("a missing whole measurement object falls back without breaking the turn", () => {
  const previous = report(base);
  Reflect.set(previous, "measurement", null);
  assert.equal(basis(base, previous), 826);
});

for (const [name, media] of [
  ["attachment", { attachments: [attachment] }], ["reference", { imageReferences: [reference] }],
] as const) {
  test(`new unpriced image ${name} retains the complete old local-floor path`, () => {
    const added = { ...user("inspect this"), ...media };
    const request = { ...base, messages: [...base.messages, added] };
    assert.equal(basis(request, report(base)), 826);
  });
  test(`previously measured unchanged image ${name} remains reusable`, () => {
    const request = { ...base, messages: [system("project rules"), { ...user("inspect this"), ...media }] };
    assert.equal(basis(request, report(request)), 700);
  });
}

test("new unpriced media plus replaced system falls back when the old all-message match fails", () => {
  const request = { ...base, messages: [system("changed rules"), ...base.messages.slice(1),
    { ...user("inspect this"), attachments: [attachment] }] };
  assert.equal(basis(request, report(base)), 826);
});

test("empty media arrays remain text-only additions", () => {
  const added = { ...user("text only"), attachments: [], imageReferences: [] };
  const request = { ...base, messages: [...base.messages, added] };
  assert.equal(basis(request, report(base)), 700 + estimate([added]));
});
