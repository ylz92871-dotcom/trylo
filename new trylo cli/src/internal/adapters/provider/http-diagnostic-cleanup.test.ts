import assert from "node:assert/strict";
import { test } from "node:test";
import { httpFailureMessage } from "./http-failure-message.js";

for (const scenario of ["oversized429", "uninspected503"] as const) test(`${scenario} returns its HTTP failure while underlying cancellation is stalled`, async () => {
  let release!: () => void;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { calls++; return new Promise<void>(resolve => { release = resolve; }); },
  });
  const status = scenario === "oversized429" ? 429 : 503;
  const response = new Response(body, { status });
  let settled = false;
  const pending = httpFailureMessage(response, status === 429 ? "rate_limit" : "server", new AbortController().signal).then(value => { settled = true; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(settled, true, "known HTTP failure must not await an unbounded cleanup operation");
    assert.equal(await pending, "http_" + status);
    assert.equal(response.body?.locked, false);
  } finally { release(); await pending; }
});

test("a rejected diagnostic cancellation keeps the classified failure and releases the reader", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8193)); },
    cancel() { return Promise.reject(new Error("PRIVATE-CLEANUP-FAILURE")); } });
  const response = new Response(body, { status: 429 });
  assert.equal(await httpFailureMessage(response, "rate_limit", new AbortController().signal), "http_429");
  assert.equal(response.body?.locked, false);
});
