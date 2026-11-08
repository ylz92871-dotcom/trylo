import assert from "node:assert/strict";
import { test } from "node:test";
import { freshSseOpen, scanSse } from "./sse.js";

/**
 * Pure SSE scanning (T1). Every split-event shape is a unit test, not a
 * socket session: the parser must survive chunk boundaries, keep-alive
 * comments, multi-line data and CRLF, and dispatch nothing without data.
 */

test("one complete event with an explicit name", () => {
  const result = scanSse("event: endpoint\ndata: /message?token=1\n\n");
  assert.deepEqual(result.events, [{ event: "endpoint", data: "/message?token=1" }]);
  assert.equal(result.rest, "");
});

test("the default event name is message", () => {
  const result = scanSse("data: {\"jsonrpc\":\"2.0\"}\n\n");
  assert.deepEqual(result.events, [{ event: "message", data: "{\"jsonrpc\":\"2.0\"}" }]);
});

test("a split chunk keeps the partial line and the open event", () => {
  const first = scanSse("event: me");
  assert.deepEqual(first.events, []);
  const second = scanSse("ssage\ndata: hi\n\n");
  assert.deepEqual(second.events, [{ event: "message", data: "hi" }]);
});

test("multi-line data is joined with newlines into one payload", () => {
  const result = scanSse("data: line1\ndata: line2\n\n");
  assert.deepEqual(result.events, [{ event: "message", data: "line1\nline2" }]);
});

test("comments and blank keep-alive lines produce nothing", () => {
  const result = scanSse(": keep-alive\n\n\n");
  assert.deepEqual(result.events, []);
});

test("an event without data is not dispatched", () => {
  const result = scanSse("event: ping\n\n");
  assert.deepEqual(result.events, []);
});

test("CRLF line endings are handled", () => {
  const result = scanSse("event: endpoint\r\ndata: /m\r\n\r\n");
  assert.deepEqual(result.events, [{ event: "endpoint", data: "/m" }]);
});

test("an event split across many chunks still dispatches exactly once", () => {
  let rest = "";
  let open = freshSseOpen;
  const chunks = ["even", "t: endpoint\nda", "ta: /abc\n", "\n"];
  const events: Array<{ event: string; data: string }> = [];

  for (const chunk of chunks) {
    const scanned = scanSse(rest + chunk, open);
    events.push(...scanned.events);
    rest = scanned.rest;
    open = scanned.open;
  }

  assert.deepEqual(events, [{ event: "endpoint", data: "/abc" }]);
  assert.equal(rest, "");
});

test("an event whose terminator lands in a later chunk is not truncated", () => {
  // The failure mode that motivated the open-state carry: the data field
  // completes in one chunk, the blank line arrives in the next. The pump
  // feeds `rest + chunk` with the carried open state, exactly as here.
  const first = scanSse("data: /abc\n");

  assert.deepEqual(first.events, []);
  const second = scanSse(first.rest + "\n", first.open);

  assert.deepEqual(second.events, [{ event: "message", data: "/abc" }]);
});

test("id and retry fields are ignored, not treated as data", () => {
  const result = scanSse("id: 7\nretry: 500\ndata: x\n\n");
  assert.deepEqual(result.events, [{ event: "message", data: "x" }]);
});
