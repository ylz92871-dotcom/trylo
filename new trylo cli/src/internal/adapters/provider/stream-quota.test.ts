import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { createResponsesProvider } from "./responses.js";
import type { ProviderEvent } from "../../ports/provider.js";

for (const wire of ["chat", "responses-error", "responses-failed", "responses-completed-failed"] as const) {
  for (const code of ["AccountQuotaExceeded", "QuotaExceeded", "insufficient_quota"]) {
    test(`${wire} normalizes stream quota ${code} without retries or provider prose`, async () => {
      let calls = 0;
      const error = { code, message: "Exceeded the 5-hour usage quota. It will reset at 2026-10-25 23:20:06 +0800 CST. PRIVATE-STREAM-DIAGNOSTIC" };
      const frame = wire === "chat" ? `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`
        : wire === "responses-error" ? `event: error\ndata: ${JSON.stringify(error)}\n\n`
          : `event: ${wire === "responses-failed" ? "response.failed" : "response.completed"}\ndata: ${JSON.stringify({ response: { status: "failed", error } })}\n\n`;
      const config = { endpoint: "http://fixture.invalid", model: "fixture", apiKey: "fixture-key",
        fetchImpl: async () => { calls++; return new Response(frame, { headers: { "Content-Type": "text/event-stream" } }); }, sleep: async () => {} };
      const provider = wire === "chat" ? createOpenAiCompatibleProvider(config) : createResponsesProvider(config);
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream({ attemptId: "stream-quota", model: "fixture", messages: [], tools: [] }, new AbortController().signal)) events.push(event);
      assert.equal(calls, 1);
      const failure = events.find(event => event.type === "error"); assert.ok(failure);
      assert.equal(failure.class, "quota"); assert.equal(failure.retryable, false);
      assert.equal(failure.phase, "after_stream_started");
      assert.ok(failure.message.includes("window=5-hour"));
      assert.ok(failure.message.includes("reset_at=2026-10-25T23:20:06+08:00"));
      assert.equal(JSON.stringify(events).includes("PRIVATE-STREAM-DIAGNOSTIC"), false);
      assert.equal(events.some(event => event.type === "finish"), false);
    });
  }
}
