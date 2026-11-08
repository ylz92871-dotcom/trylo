import assert from "node:assert/strict";
import test from "node:test";
import { consumeProviderStream } from "../loop/stream.js";
import { createOpenAiTranslator } from "../adapters/provider/openai-translate.js";
import { emptyUsage, type ProviderEvent, type ProviderPort } from "../ports/provider.js";

function observation(value: object): unknown {
  return "inputTokenObservation" in value ? value.inputTokenObservation : undefined;
}

function complete(tokens: number): ProviderEvent[] {
  return createOpenAiTranslator().push({ usage: { prompt_tokens: tokens, completion_tokens: 2, total_tokens: tokens + 2 } });
}

async function consume(events: readonly ProviderEvent[]) {
  const provider: ProviderPort = { async *stream() {
    yield* events;
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  let next = 0;

  return consumeProviderStream({ port: provider, request: { attemptId: "synthetic-attempt", model: "synthetic", messages: [{ role: "user", content: "public fixture" }], tools: [] },
    signal: new AbortController().signal, startSequence: 0, nextEventId: () => `event-${next++}` });
}

test("one stream reports its last complete input observation separately from billing", async () => {
  const report = await consume(complete(100));
  assert.deepEqual(observation(report), { kind: "complete_prompt", source: "provider_complete_input", tokens: 100 });
  assert.deepEqual(report.usage, { ...emptyUsage(), inputTokens: 100, outputTokens: 2, totalTokens: 102 });
  assert.equal("inputTokenObservation" in report.usage, false);
});

test("a complete zero observation replaces a prior positive observation in the same stream", async () => {
  const report = await consume([...complete(100), ...complete(0)]);
  assert.deepEqual(observation(report), { kind: "complete_prompt", source: "provider_complete_input", tokens: 0 });
  assert.equal(report.usage.inputTokens, 0);
});

test("later unqualified billing cannot manufacture or add to complete input provenance", async () => {
  const report = await consume([...complete(100), { type: "usage", usage: { ...emptyUsage("delta"), inputTokens: 5, totalTokens: 5 } }]);
  assert.deepEqual(observation(report), { kind: "complete_prompt", source: "provider_complete_input", tokens: 100 });
  assert.equal(report.usage.inputTokens, 105);
  assert.equal(report.usage.totalTokens, 107);
});

test("a past or auxiliary stream observation never leaks into a new unqualified main stream", async () => {
  const main = await consume(complete(100));
  const auxiliary = await consume(complete(900));
  const nextMain = await consume([{ type: "usage", usage: { ...emptyUsage(), inputTokens: 30, totalTokens: 30 } }]);

  assert.deepEqual(observation(main), { kind: "complete_prompt", source: "provider_complete_input", tokens: 100 });
  assert.deepEqual(observation(auxiliary), { kind: "complete_prompt", source: "provider_complete_input", tokens: 900 });
  assert.equal(observation(nextMain), undefined);
  assert.deepEqual(nextMain.usage, { ...emptyUsage(), inputTokens: 30, totalTokens: 30 });
});

test("legacy and absent usage preserve the original report shape", async () => {
  const report = await consume([]);
  assert.equal(observation(report), undefined);
  assert.equal(Object.hasOwn(report, "inputTokenObservation"), false);
  assert.deepEqual(report.usage, emptyUsage());
});
