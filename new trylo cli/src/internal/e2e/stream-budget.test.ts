import assert from "node:assert/strict";
import { test } from "node:test";
import { translateBody } from "../adapters/provider/openai-stream.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";
import type { ProviderEvent } from "../ports/provider.js";

test("network chunk boundaries cannot multiply the retained event count", async () => {
  let chunks = 0;
  const frame = new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"x"},"finish_reason":null}]}\n\n');
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (chunks++ < 5000) controller.enqueue(frame);
    else {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    }
  } });
  const events: ProviderEvent[] = [];

  for await (const event of translateBody(body, new AbortController().signal)) {
    if (event.type === "reasoning_delta" && !events.some(e => e.type === "reasoning_delta")) assert.ok(chunks < 10, "first fragment must not wait for a full buffer");
    events.push(event);
  }

  const deltas = events.filter(e => e.type === "reasoning_delta");

  assert.equal(deltas.map(e => e.text).join(""), "x".repeat(5000));
  assert.ok(deltas.length <= 50, `expected bounded deltas, got ${deltas.length}`);
});

test("a long reasoning stream completes without a turn-wide event ceiling", async () => {
  let pulled = 0, released = false, signal: AbortSignal | undefined;
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: createFakeTools([]),
    provider: { async *stream(_request, abort): AsyncIterable<ProviderEvent> {
      signal = abort;
      try {
        yield { type: "reasoning_start", blockId: "r", redacted: false };
        for (let i = 0; i < 5000; i++) {
          pulled++;
          yield { type: "reasoning_delta", blockId: "r", text: "x", redacted: false };
        }
        yield { type: "reasoning_end", blockId: "r" };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      } finally { released = true; }
    } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Check overflow." });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.envelopes.filter(e => e.kind === "terminal").length, 1);
  assert.equal(pulled, 5000);
  assert.equal(signal?.aborted, false);
  assert.equal(released, true);
});
