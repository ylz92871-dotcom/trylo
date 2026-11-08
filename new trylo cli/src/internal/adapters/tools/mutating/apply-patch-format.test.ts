import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApplyPatch } from "./apply-patch-format.js";

/**
 * WP10.1: the Codex `*** Begin Patch` grammar as the multi-file contract.
 *
 * These cases mirror `parser.rs` / `streaming_parser.rs` line rules: headers
 * match trimmed, bodies keep raw prefixes, an update hunk without chunks is
 * refused at close, and anything after `*** End Patch` must be blank.
 */

test("an add hunk keeps every +-line as content with trailing newlines", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Add File: a.txt\n+hello\n+world\n*** End Patch");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.deepEqual(parsed.hunks, [{ kind: "add", path: "a.txt", contents: "hello\nworld\n" }]);
});

test("add, delete and update hunks parse in one patch, in order", () => {
  const parsed = parseApplyPatch(
    "*** Begin Patch\n*** Add File: one.txt\n+one\n*** Delete File: gone.txt\n*** Update File: src.ts\n@@\n-old\n+new\n*** End Patch",
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.hunks.length, 3);
  assert.equal(parsed.hunks[0]?.kind, "add");
  assert.equal(parsed.hunks[1]?.kind, "delete");
  const update = parsed.hunks[2];

  assert.equal(update?.kind, "update");

  if (update?.kind === "update") {
    assert.equal(update.moveTo, undefined);
    assert.equal(update.chunks.length, 1);
    assert.deepEqual(update.chunks[0]?.oldLines, ["old"]);
    assert.deepEqual(update.chunks[0]?.newLines, ["new"]);
  }
});

test("a move destination is carried on the update hunk", () => {
  const parsed = parseApplyPatch(
    "*** Begin Patch\n*** Update File: src.txt\n*** Move to: dst.txt\n@@\n-old\n+new\n*** End Patch",
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const update = parsed.hunks[0];

  assert.equal(update?.kind, "update");

  if (update?.kind === "update") {
    assert.equal(update.path, "src.txt");
    assert.equal(update.moveTo, "dst.txt");
  }
});

test("an update hunk without chunks is refused at close", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Update File: test.py\n*** End Patch");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_hunk");
    assert.match(parsed.message, /empty/);
  }
});

test("a patch without the end marker is refused, never half-accepted", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Add File: foo\n+hi\n");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_patch");
  }
});

test("a patch without the begin marker is refused", () => {
  const parsed = parseApplyPatch("*** Add File: foo\n+hi\n*** End Patch");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_patch");
  }
});

test("an empty patch parses with no hunks so execution can refuse it as empty", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** End Patch");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.deepEqual(parsed.hunks, []);
});

test("context lines keep their text on both sides of a chunk", () => {
  const parsed = parseApplyPatch(
    "*** Begin Patch\n*** Update File: f.py\n@@ def f():\n     pass\n+    return 1\n*** End Patch",
  );

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const update = parsed.hunks[0];

  assert.equal(update?.kind, "update");

  if (update?.kind === "update") {
    assert.equal(update.chunks[0]?.changeContext, "def f():");
    assert.deepEqual(update.chunks[0]?.oldLines, ["    pass"]);
    assert.deepEqual(update.chunks[0]?.newLines, ["    pass", "    return 1"]);
    assert.deepEqual(update.chunks[0]?.contextPairs, [[0, 0]]);
  }
});

test("an end-of-file marker sticks to the last chunk", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Update File: f.txt\n@@\n+tail\n*** End of File\n*** End Patch");

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const update = parsed.hunks[0];
  if (update?.kind === "update") {
    assert.equal(update.chunks[0]?.endOfFile, true);
  } else {
    assert.fail("expected an update hunk");
  }
});

test("a body line with no prefix is refused, never guessed", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Update File: f.txt\n@@\nno prefix here\n*** End Patch");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_hunk");
  }
});

test("an add body line without + is refused", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Add File: f.txt\nplain\n*** End Patch");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_hunk");
  }
});

test("a move marker after chunks started is refused, not silently kept", () => {
  const parsed = parseApplyPatch(
    "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** Move to: b.txt\n*** End Patch",
  );

  assert.equal(parsed.ok, false);

  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_hunk");
  }
});

test("CRLF patch text is normalised before parsing", () => {
  const parsed = parseApplyPatch("*** Begin Patch\r\n*** Add File: a.txt\r\n+hi\r\n*** End Patch\r\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.deepEqual(parsed.hunks, [{ kind: "add", path: "a.txt", contents: "hi\n" }]);
});

test("an environment-id header is refused as unknown: no such routing exists here", () => {
  const parsed = parseApplyPatch("*** Begin Patch\n*** Environment ID: remote\n*** Add File: a.txt\n+hi\n*** End Patch");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "invalid_hunk");
  }
});

test("blank lines after the end marker are tolerated, content is not", () => {
  const trailing = parseApplyPatch("*** Begin Patch\n*** End Patch\n\n");

  assert.equal(trailing.ok, true);
  const dirty = parseApplyPatch("*** Begin Patch\n*** End Patch\nleftover\n");

  assert.equal(dirty.ok, false);

  if (!dirty.ok) {
    assert.equal(dirty.code, "invalid_patch");
  }
});
