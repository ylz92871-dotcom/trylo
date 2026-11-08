import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import { readContentModelStream } from "./model-stream.js";

const request = { attemptId: "stream:authorized", model: "controlled", messages: [], tools: [] };

test("an omitted caller deadline never arms a timer or cancels healthy content", async () => {
  let armed = 0;
  const provider: ProviderPort = { async *stream(): AsyncGenerator<ProviderEvent> {
    yield { type: "text_delta", blockId: "body", text: "healthy" };
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 1, outputTokens: 1, totalTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await readContentModelStream({ provider, request, maxTokens: 1000,
    signal: new AbortController().signal, enabled: () => true,

    scheduler: () => {
      armed++;
      throw new Error("no_caller_deadline");
    } });

  assert.equal(armed, 0);
  assert.equal(result.text, "healthy");
  assert.equal(result.reason, undefined);
  assert.equal(result.boundary.kind, "complete");
});

test("an explicit caller deadline still aborts transport and retains unknown remote outcome", async () => {
  let cancelled = false;
  const provider: ProviderPort = { async *stream(): AsyncGenerator<ProviderEvent> { await new Promise<void>(() => undefined); } };
  const result = await readContentModelStream({ provider, request, maxTokens: 1000, timeoutMs: 1234,
    signal: new AbortController().signal, enabled: () => true,

    scheduler: (delay, fire) => {
      assert.equal(delay, 1234);
      queueMicrotask(fire);
      return { cancel: () => { cancelled = true; } };
    } });

  assert.equal(result.reason, "content_model_timeout");
  assert.equal(result.boundary.kind, "unknown");
  assert.equal(result.reported, false);
  assert.equal(cancelled, true);
});
