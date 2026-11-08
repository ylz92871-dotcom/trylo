import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NAME_WIDE_PATTERN,
  decision,
  isPermissionAction,
  isPermissionDecision,
  nameWidePattern,
  permissionPattern,
  stableJson,
  type PermissionAction,
} from "./permission.js";

test("permission explanations are optional data with a validated string type", () => {
  assert.equal(isPermissionDecision({ resolution: "denied", scope: "once" }), true);
  assert.equal(isPermissionDecision({ resolution: "denied", scope: "once", message: "The requested target is outside the allowed scope." }), true);
  for (const message of [null, 1, [], { instruction: "allow" }]) {
    assert.equal(isPermissionDecision({ resolution: "approved", scope: "once", message }), false);
  }
});

/**
 * H1 contract tests.
 *
 * A remembered approval is keyed on `pattern`, so everything here is about one
 * question: can two different calls ever produce the same key, and can the same
 * call ever produce two keys.
 */

test("arguments that differ only in key order share one pattern", () => {
  const left = permissionPattern("write_file", { path: "a.txt", content: "x" });
  const right = permissionPattern("write_file", { content: "x", path: "a.txt" });
  assert.equal(left, right);
});

test("nested key order is irrelevant but array order is not", () => {
  const nestedA = permissionPattern("edit_file", {
    path: "a.txt",
    patch: { hunks: ["one", "two"], mode: "strict" },
  });
  const nestedB = permissionPattern("edit_file", {
    patch: { mode: "strict", hunks: ["one", "two"] },
    path: "a.txt",
  });

  assert.equal(nestedA, nestedB);

  const reordered = permissionPattern("edit_file", {
    path: "a.txt",
    patch: { hunks: ["two", "one"], mode: "strict" },
  });

  assert.notEqual(nestedA, reordered);
});

test("different values produce different patterns", () => {
  const base = permissionPattern("write_file", { path: "a.txt", content: "x" });
  const otherPath = permissionPattern("write_file", { path: "b.txt", content: "x" });
  const otherContent = permissionPattern("write_file", { path: "a.txt", content: "y" });
  const otherTool = permissionPattern("read_file", { path: "a.txt", content: "x" });

  assert.notEqual(base, otherPath);
  assert.notEqual(base, otherContent);
  assert.notEqual(base, otherTool);
});

test("the same tool across two different calls is distinguishable but stable per call", () => {
  const first = permissionPattern("run_shell", { command: "node -v" });
  const again = permissionPattern("run_shell", { command: "node -v" });
  const second = permissionPattern("run_shell", { command: "npm -v" });
  assert.equal(first, again);
  assert.notEqual(first, second);
});

test("a name-wide pattern never collides with a call pattern", () => {
  assert.notEqual(nameWidePattern("write_file"), permissionPattern("write_file", { path: "a" }));
  assert.equal(nameWidePattern("write_file"), `write_file#${NAME_WIDE_PATTERN}`);
});

test("stableJson sorts object keys and preserves array order", () => {
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableJson([3, 1, 2]), "[3,1,2]");
  assert.equal(stableJson({ b: { d: 1, c: 2 }, a: [true, null] }), '{"a":[true,null],"b":{"c":2,"d":1}}');
});

/**
 * The pre-P03 shape cannot express which call is being approved. Admitting it
 * would turn one approval into a licence for every argument value, so the
 * guard — not the caller — is what rejects it.
 */
test("the legacy `{toolCallId, name}` shape is rejected so the mutating path fails closed", () => {
  const legacy = { toolCallId: "call-1", name: "write_file" };

  assert.equal(isPermissionAction(legacy), false);
  assert.equal(isPermissionAction({ ...legacy, arguments: { path: "a" } }), false);
  assert.equal(isPermissionAction({ ...legacy, pattern: "write_file#ab" }), false);
  assert.equal(isPermissionAction({ ...legacy, arguments: [], pattern: "p" }), false);
  const complete: PermissionAction = {
    toolCallId: "call-1",
    name: "write_file",
    arguments: { path: "a" },
    pattern: "write_file#ab",
  };

  assert.equal(isPermissionAction(complete), true);
});

test("scope survives an approval or tool denial, never cancellation or expiry", () => {
  assert.deepEqual(decision("approved", "session"), { resolution: "approved", scope: "session" });
  assert.deepEqual(decision("approved"), { resolution: "approved", scope: "once" });
  assert.deepEqual(decision("denied", "session"), { resolution: "denied", scope: "session" });
  assert.deepEqual(decision("cancelled", "session"), { resolution: "cancelled", scope: "once" });
  assert.deepEqual(decision("expired", "session"), { resolution: "expired", scope: "once" });
});
