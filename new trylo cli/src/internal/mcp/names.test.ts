import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isMcpQualifiedName,
  isRoundTrippable,
  parseMcpToolName,
  qualifyMcpToolName,
} from "./names.js";

/**
 * M4: tool naming. The separator rules exist so `mcp__<server>__<tool>` can
 * never be read two ways. A server id may not contain `__` (registry names
 * cannot by construction), and a tool name containing `__` is refused rather
 * than escaped — otherwise `mcp__a__b__c` would be ambiguous.
 */

test("qualifying and parsing round-trips exactly", () => {
  const qualified = qualifyMcpToolName("fs", "read_file");

  assert.equal(qualified.ok, true);

  if (!qualified.ok) {
    return;
  }

  assert.equal(qualified.value, "mcp__fs__read_file");
  const parsed = parseMcpToolName(qualified.value);

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.deepEqual(parsed.value, { serverId: "fs", serverToolName: "read_file" });
  }
});

test("a tool name containing the separator is refused, not escaped", () => {
  const result = qualifyMcpToolName("fs", "a__b");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_tool_name");
  }
});

test("a server id containing the separator is refused", () => {
  const result = qualifyMcpToolName("a__b", "read");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_server_id");
  }
});

test("an empty tool name is refused", () => {
  const result = qualifyMcpToolName("fs", "");
  assert.equal(result.ok, false);
});

test("the round-trip property holds for the shape the registry admits", () => {
  assert.equal(isRoundTrippable("fs", "read_file"), true);
  assert.equal(isRoundTrippable("my-server_2", "list"), true);
  assert.equal(isRoundTrippable("a", "a__b"), false);
  assert.equal(isRoundTrippable("a__b", "x"), false);
});

test("a non-mcp name is the safe answer, not an error", () => {
  const result = parseMcpToolName("write_file");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "not_mcp_name");
  }
  assert.equal(isMcpQualifiedName("write_file"), false);
});

test("an empty half anywhere in the qualified name is malformed", () => {
  for (const name of ["mcp__", "mcp__x", "mcp__x__", "mcp____y", "mcp__fs__a__b"]) {
    assert.equal(isMcpQualifiedName(name), false, `${name} must not parse`);
  }
});
