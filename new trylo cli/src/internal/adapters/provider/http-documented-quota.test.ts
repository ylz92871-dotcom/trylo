import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderEvent } from "../../ports/provider.js";

// Official Ark error vocabulary: https://docs.volcengine.com/docs/ark/error-codes
// Keep the wire-observed AccountQuotaExceeded alias alongside documented QuotaExceeded.
for (const code of ["QuotaExceeded", "AccountQuotaExceeded"]) test(`documented monthly allowance code ${code} stops once and retains a safe reset`, async () => {
  let calls = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://fixture.invalid", model: "fixture", apiKey: "fixture-key", sleep: async () => {},
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { code, message: "Monthly usage quota exhausted. It will reset at 2026-11-01 00:00:00 +0800 CST. PRIVATE-DIAGNOSTIC" } }), { status: 429 }); } });
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ attemptId: "doc-quota", model: "fixture", messages: [{ role: "user", content: "fixture" }], tools: [] }, new AbortController().signal)) events.push(event);
  assert.equal(calls, 1);
  const error = events.find(event => event.type === "error"); assert.ok(error);
  assert.equal(error.class, "quota"); assert.equal(error.retryable, false);
  assert.ok(error.message.includes("window=monthly")); assert.ok(error.message.includes("reset_at=2026-11-01T00:00:00+08:00"));
  assert.equal(JSON.stringify(events).includes("PRIVATE-DIAGNOSTIC"), false);
});

test("documented AccountRateLimitExceeded remains a transient rate limit", async () => {
  let calls = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://fixture.invalid", model: "fixture", apiKey: "fixture-key", sleep: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('{"error":{"code":"AccountRateLimitExceeded","message":"Requests are too frequent."}}', { status: 429 })
      : new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') });
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ attemptId: "doc-rate", model: "fixture", messages: [{ role: "user", content: "fixture" }], tools: [] }, new AbortController().signal)) events.push(event);
  assert.equal(calls, 2); assert.ok(events.some(event => event.type === "finish"));
});
