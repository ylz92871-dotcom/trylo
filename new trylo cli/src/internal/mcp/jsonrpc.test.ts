import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeMessage,
  encodeMessage,
  requestMessage,
  scanFrames,
  type JsonRpcRequest,
} from "./jsonrpc.js";

/**
 * M3 (framing half): the incremental NDJSON decoder is pure, so every hostile
 * input shape has a unit test without a subprocess. A newline is a real frame
 * boundary (JSON strings escape their newlines), so `scanFrames` either yields
 * complete frames or carries a partial line forward — never a half-frame.
 */

test("scanFrames splits two complete frames in one chunk", () => {
  const result = scanFrames(`${encodeMessage(requestMessage(1, "a"))}${encodeMessage(requestMessage(2, "b"))}`);
  assert.equal(result.messages.length, 2);
  assert.equal(result.rest, "");
  assert.equal(result.overflowed, false);
});

test("scanFrames carries a partial frame forward and joins it later", () => {
  const first = `{"jsonrpc":"2.0","id":1,"me`;
  const second = `thod":"x"}\n`;
  const one = scanFrames(first);

  assert.equal(one.messages.length, 0);
  assert.equal(one.rest, first);
  const two = scanFrames(one.rest + second);

  assert.equal(two.messages.length, 1);
  assert.equal(two.rest, "");
});

test("a blank line and a CRLF-terminated frame are both tolerated", () => {
  const result = scanFrames(`\r\n${encodeMessage(requestMessage(1, "x"))}\r\n`);
  assert.equal(result.messages.length, 1);
});

test("non-JSON on the wire becomes an invalid message, not a crash", () => {
  const result = scanFrames("not json at all\n");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.kind, "invalid");
});

test("a frame past the ceiling is discarded and flagged as overflowed", () => {
  const big = "x".repeat(1024);
  const result = scanFrames(`{"jsonrpc":"2.0","id":1,"method":"${big}"}\n`, 64);
  assert.equal(result.messages.length, 0);
  assert.equal(result.overflowed, true);
  assert.equal(result.rest, "");
});

test("decodeMessage refuses a non-object and a wrong version", () => {
  assert.equal(decodeMessage("x").kind, "invalid");
  assert.equal(decodeMessage({ jsonrpc: "1.0", id: 1, method: "x" }).kind, "invalid");
});

test("decodeMessage separates request, notification, response and error", () => {
  assert.equal(decodeMessage({ jsonrpc: "2.0", id: 1, method: "x" }).kind, "request");
  assert.equal(decodeMessage({ jsonrpc: "2.0", method: "x" }).kind, "notification");
  assert.equal(decodeMessage({ jsonrpc: "2.0", id: 1, result: {} }).kind, "response");
  const error = decodeMessage({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "nope" } });
  assert.equal(error.kind, "response");
});

test("a response carrying both result and error is invalid", () => {
  const result = decodeMessage({ jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } });
  assert.equal(result.kind, "invalid");
});

test("encodeMessage always terminates with exactly one newline", () => {
  const wire = encodeMessage(requestMessage(1, "x"));
  assert.equal(wire.endsWith("\n"), true);
  assert.equal(wire.slice(0, -1).includes("\n"), false);
});

test("a request with string params round-trips through the decode", () => {
  const request: JsonRpcRequest = requestMessage(7, "tools/call", { name: "echo" });
  const decoded = scanFrames(encodeMessage(request));

  assert.equal(decoded.messages.length, 1);
  const message = decoded.messages[0];

  assert.equal(message?.kind, "request");

  if (message?.kind === "request") {
    assert.equal(message.request.method, "tools/call");
    assert.equal(message.request.id, 7);
  }
});
