import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { createResponsesProvider } from "./responses.js";
import { httpFailureMessage } from "./http-failure-message.js";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";

const request = { attemptId: "quota-test", model: "fixture-model", messages: [{ role: "user" as const, content: "hello" }], tools: [] };
const diagnostics = { error: { code: "AccountQuotaExceeded", message: "You have exceeded the 5-hour usage quota. It will reset at 2026-10-25 17:25:37 +0800 CST. PRIVATE-CREDENTIAL PRIVATE-PROMPT" } };
async function eventsOf(provider: ProviderPort): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);
  return events;
}

for (const wire of ["chat", "responses"] as const) test(`${wire} reports the real plan-quota diagnostic once without immediate retries`, async () => {
  let calls = 0, sleeps = 0;
  const config = { endpoint: "https://fixture.invalid", model: "fixture-model", apiKey: "fixture-key",
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(diagnostics), { status: 429 }); },
    sleep: async () => { sleeps++; } };
  const events = await eventsOf(wire === "chat" ? createOpenAiCompatibleProvider(config) : createResponsesProvider(config));
  assert.equal(calls, 1); assert.equal(sleeps, 0);
  const error = events.find(event => event.type === "error"); assert.ok(error);
  assert.equal(error.class, "quota"); assert.equal(error.retryable, false); assert.equal(error.phase, "before_headers");
  assert.match(error.message, /quota_exceeded/); assert.match(error.message, /window=5-hour/);
  assert.match(error.message, /reset_at=2026-10-25T17:25:37\+08:00/);
  assert.equal(JSON.stringify(events).includes("PRIVATE-"), false);
});

test("ordinary transient 429 retains the existing retry behavior", async () => {
  let calls = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://fixture.invalid", model: "fixture-model", apiKey: "fixture-key", sleep: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('{"error":{"code":"rate_limit_exceeded","message":"slow down"}}', { status: 429 })
      : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') });
  const events = await eventsOf(provider); assert.equal(calls, 2); assert.ok(events.some(event => event.type === "finish"));
});

test("quota words without a recognized structured code never change rate-limit classification", async () => {
  let calls = 0;
  const events = await eventsOf(createOpenAiCompatibleProvider({ endpoint: "https://fixture.invalid", model: "fixture-model", apiKey: "fixture-key", sleep: async () => {},
    fetchImpl: async () => { calls++; return new Response('{"error":{"code":"other","message":"quota exceeded PRIVATE-PROMPT"}}', { status: 429 }); } }));
  assert.equal(calls, 3); const error = events.find(event => event.type === "error"); assert.ok(error);
  assert.equal(error.class, "rate_limit"); assert.equal(error.message, "http_429");
});

test("quota metadata is normalized and never echoes unknown timestamps or provider prose", async () => {
  const signal = new AbortController().signal;
  const valid = await httpFailureMessage(new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "PRIVATE-CREDENTIAL" } }), { status: 429 }), "rate_limit", signal);
  assert.equal(valid, "quota_exceeded");
  const malformed = await httpFailureMessage(new Response(JSON.stringify({ error: { code: "AccountQuotaExceeded", message: "reset at 2026-99-99 77:99:99 +9999 PRIVATE-CREDENTIAL" } }), { status: 429 }), "rate_limit", signal);
  assert.equal(malformed, "quota_exceeded");
  const oversized = await httpFailureMessage(new Response(JSON.stringify({ ...diagnostics, padding: "x".repeat(8192) }), { status: 429 }), "rate_limit", signal);
  assert.equal(oversized, "http_429");
});

test("an interrupted 429 diagnostic body releases its reader and preserves the status", async () => {
  let cancelled = false;
  const deadline = new AbortController();
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = httpFailureMessage(new Response(body, { status: 429 }), "rate_limit", new AbortController().signal, { timeoutSignal: deadline.signal });
  deadline.abort();
  assert.equal(await pending, "http_429"); assert.equal(cancelled, true);
});
