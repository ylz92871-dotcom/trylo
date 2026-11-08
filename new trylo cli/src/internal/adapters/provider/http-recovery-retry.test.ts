import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderRecoveryHint } from "../../ports/provider.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { createResponsesProvider } from "./responses.js";

const request = { attemptId: "recovery-retry", model: "fixture", messages: [{ role: "user" as const, content: "hello" }], tools: [] };
const privateDiagnostic = "PRIVATE-FIXTURE-DIAGNOSTIC";

async function observe(wire: "chat" | "responses", retryAfter?: string, options: {
  readonly quota?: true; readonly maxAttempts?: number;
} = {}): Promise<{ calls: number; sleeps: number; events: ProviderEvent[] }> {
  let calls = 0, sleeps = 0;
  const config = { endpoint: "https://fixture.invalid", model: "fixture", apiKey: "fixture-key",
    ...(options.maxAttempts === undefined ? {} : { maxAttemptsBeforeHeaders: options.maxAttempts }),
    sleep: async () => { sleeps++; },
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: options.quota ? "insufficient_quota" : "rate_limit_exceeded",
        type: "rate_limit_error", message: privateDiagnostic } }), {
        status: 429, ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
      });
    } };
  const provider = wire === "chat" ? createOpenAiCompatibleProvider(config) : createResponsesProvider(config);
  const events: ProviderEvent[] = [];

  for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);

  assert.equal(JSON.stringify(events).includes(privateDiagnostic), false);

  return { calls, sleeps, events };
}

function failure(events: readonly ProviderEvent[]): Extract<ProviderEvent, { type: "error" }> {
  const errors = events.filter(event => event.type === "error");
  assert.equal(errors.length, 1);
  const error = errors[0];
  assert.ok(error);
  assert.equal(error.phase, "before_headers");
  assert.equal(events.some(event => event.type === "finish"), false);
  return error;
}

const hints: ReadonlyArray<{ readonly name: string; readonly header: string; readonly expected: ProviderRecoveryHint }> = [
  { name: "observed long AMD delay", header: "70135", expected: { kind: "after", delayMs: 70_135_000, source: "retry_after" } },
  { name: "zero delay", header: "0", expected: { kind: "after", delayMs: 0, source: "retry_after" } },
  { name: "future absolute deadline", header: "Tue, 01 Jan 2030 00:00:00 GMT", expected: { kind: "at", atMs: 1_893_456_000_000, source: "retry_after" } },
  { name: "past absolute deadline", header: "Sat, 01 Jan 2000 00:00:00 GMT", expected: { kind: "at", atMs: 946_684_800_000, source: "retry_after" } },
];

for (const wire of ["chat", "responses"] as const) {
  for (const hint of hints) test(`${wire} delegates ${hint.name} before another physical request`, async () => {
    const result = await observe(wire, hint.header);
    assert.equal(result.calls, 1);
    assert.equal(result.sleeps, 0);
    const error = failure(result.events);
    assert.equal(error.class, "rate_limit");
    assert.equal(error.retryable, true);
    assert.deepEqual(error.recovery, hint.expected);
  });

  for (const header of [undefined, "-1"]) test(`${wire} keeps ordinary retries for ${header === undefined ? "absent" : "malformed"} recovery hints`, async () => {
    const result = await observe(wire, header);
    assert.equal(result.calls, 3);
    assert.equal(result.sleeps, 2);
    const error = failure(result.events);
    assert.equal(error.class, "rate_limit");
    assert.equal(error.retryable, true);
    assert.equal(error.recovery, undefined);
  });

  test(`${wire} retains explicit caller retry allowance without a recovery hint`, async () => {
    const result = await observe(wire, undefined, { maxAttempts: 5 });
    assert.equal(result.calls, 5);
    assert.equal(result.sleeps, 4);
    assert.equal(failure(result.events).retryable, true);
  });

  test(`${wire} retains nonretryable quota classification and its recovery hint`, async () => {
    const result = await observe(wire, "70135", { quota: true });
    assert.equal(result.calls, 1);
    assert.equal(result.sleeps, 0);
    const error = failure(result.events);
    assert.equal(error.class, "quota");
    assert.equal(error.retryable, false);
    assert.deepEqual(error.recovery, { kind: "after", delayMs: 70_135_000, source: "retry_after" });
  });
}
