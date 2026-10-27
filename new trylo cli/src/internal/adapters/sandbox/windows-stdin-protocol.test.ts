import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeArgv, STDIN_ACK, takeStdinHeader, validStdinToken } from "./windows-stdin-protocol.js";

test("private stdin argv accepts data arguments but refuses malformed executable plans", () => {
  const plan = [process.execPath, "space 中文", "`$()&", "line\nbreak"];
  assert.deepEqual(bridgeArgv(JSON.stringify(plan)), plan);
  for (const value of [null, [], ["relative.exe"], [process.execPath, null], [process.execPath, "nul\0byte"]]) {
    assert.throws(() => bridgeArgv(JSON.stringify(value)), /stdin_bridge_invalid_argv/);
  }
});

test("stdin authentication handles fragmented and coalesced headers without losing input", () => {
  assert.equal(takeStdinHeader(Buffer.from("trylo-stdin-")), undefined);
  const frame = takeStdinHeader(Buffer.from(STDIN_ACK + "release🙂\n"));
  assert.ok(frame);
  assert.equal(frame.header.toString() + "\n", STDIN_ACK);
  assert.equal(frame.rest.toString(), "release🙂\n");
  assert.throws(() => takeStdinHeader(Buffer.alloc(257, 65)), /invalid_header/);
  assert.throws(() => takeStdinHeader(Buffer.from("x".repeat(257) + "\n")), /invalid_header/);
});

test("stdin authentication refuses wrong and truncated capabilities", () => {
  const token = "a".repeat(64);
  assert.equal(validStdinToken(Buffer.from(token), token), true);
  assert.equal(validStdinToken(Buffer.from("b".repeat(64)), token), false);
  assert.equal(validStdinToken(Buffer.from(token.slice(1)), token), false);
});
