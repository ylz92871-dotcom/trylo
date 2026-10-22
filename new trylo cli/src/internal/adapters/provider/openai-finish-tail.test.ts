import assert from "node:assert/strict";
import { test } from "node:test";
import { translateBody } from "./openai-stream.js";
import type { ProviderEvent } from "../../ports/provider.js";

test("a finished Chat stream cannot wait forever for DONE or an HTTP close", async () => {
  let close = () => {};
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const consume = async () => {
    const events: ProviderEvent[] = [];
    for await (const event of translateBody(body, new AbortController().signal)) events.push(event);
    return events;
  };
  try {
    const events = await Promise.race([consume(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("finish was held indefinitely after the model stopped")), 2_000);
    })]);
    assert.equal(events.filter(e => e.type === "finish").length, 1);
    assert.equal(events.some(e => e.type === "error"), false);
    assert.equal(events.some(e => e.type === "warning" && e.code === "stream_finish_tail_timeout"), true);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  } finally {
    clearTimeout(timer);
    if (!cancelled) close();
  }
});
