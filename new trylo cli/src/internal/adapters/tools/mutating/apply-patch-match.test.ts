import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUpdateChunks, seekSequence } from "./apply-patch-match.js";
import { prepareSource } from "./patch-engine.js";
import type { ApplyPatchUpdateChunk } from "./apply-patch-format.js";

/**
 * WP10.2: tolerant matching ported from Codex `seek_sequence.rs` /
 * `file_update.rs`, with the new-CLI line-ending convention (untouched lines
 * keep their own terminators, the file keeps its trailing-newline state).
 */

function chunk(overrides: Partial<ApplyPatchUpdateChunk>): ApplyPatchUpdateChunk {
  return {
    changeContext: undefined,
    oldLines: [],
    newLines: [],
    contextPairs: [],
    endOfFile: false,
    ...overrides,
  };
}

test("an exact block is replaced and the trailing newline is preserved", () => {
  const applied = applyUpdateChunks(
    prepareSource("one\ntwo\nthree\n"),
    [chunk({ oldLines: ["two"], newLines: ["deux"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "one\ndeux\nthree\n");
  assert.equal(applied.regions.length, 1);
});

test("trailing whitespace differences still match, file bytes win", () => {
  const applied = applyUpdateChunks(
    prepareSource("foo   \nbar\n"),
    [chunk({ oldLines: ["foo"], newLines: ["FOO"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "FOO\nbar\n");
});

test("leading whitespace differences still match", () => {
  const applied = applyUpdateChunks(
    prepareSource("    indented\nnext\n"),
    [chunk({ oldLines: ["indented"], newLines: ["flat"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "flat\nnext\n");
});

test("typographic dashes in the file match ASCII dashes in the patch", () => {
  const applied = applyUpdateChunks(
    prepareSource("local import \u2013 avoids dep\nkeep\n"),
    [chunk({ oldLines: ["local import - avoids dep"], newLines: ["changed"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "changed\nkeep\n");
});

test("a missing block is a mismatch naming the file, never a guess", () => {
  const applied = applyUpdateChunks(
    prepareSource("something\nelse\n"),
    [chunk({ oldLines: ["absent"], newLines: ["new"] })],
    "f.txt",
  );

  assert.equal(applied.ok, false);

  if (!applied.ok) {
    assert.equal(applied.code, "patch_hunk_mismatch");
    assert.match(applied.message, /f\.txt/);
  }
});

test("a change context anchors the search after its first occurrence", () => {
  const applied = applyUpdateChunks(
    prepareSource("fn run()\nold\nfn run()\nold\n"),
    [chunk({ changeContext: "fn run()", oldLines: ["old"], newLines: ["new"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "fn run()\nnew\nfn run()\nold\n");
});

test("two chunks apply in file order and report two regions", () => {
  const applied = applyUpdateChunks(
    prepareSource("a\nb\nc\nd\n"),
    [
      chunk({ oldLines: ["a", "b"], newLines: ["a", "B"] }),
      chunk({ oldLines: ["c", "d"], newLines: ["C", "d"] }),
    ],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "a\nB\nC\nd\n");
  assert.equal(applied.regions.length, 2);
});

test("a chunk that only reaches backwards is refused instead of overlapping", () => {
  const applied = applyUpdateChunks(
    prepareSource("a\nb\nc\n"),
    [
      chunk({ oldLines: ["b", "c"], newLines: ["B", "C"] }),
      chunk({ oldLines: ["a", "b"], newLines: ["A", "B"] }),
    ],
    "f.txt",
  );

  assert.equal(applied.ok, false);

  if (!applied.ok) {
    assert.equal(applied.code, "patch_hunk_mismatch");
  }
});

test("an LF patch applies to a CRLF file and the file stays CRLF", () => {
  const applied = applyUpdateChunks(
    prepareSource("one\r\ntwo\r\nthree\r\n"),
    [chunk({ oldLines: ["two"], newLines: ["deux"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "one\r\ndeux\r\nthree\r\n");
});

test("a file without trailing newline keeps it that way", () => {
  const applied = applyUpdateChunks(
    prepareSource("one\ntwo"),
    [chunk({ oldLines: ["one"], newLines: ["ONE"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "ONE\ntwo");
});

test("an end-of-file chunk lands at the end", () => {
  const applied = applyUpdateChunks(
    prepareSource("head\ntail\n"),
    [chunk({ oldLines: ["tail"], newLines: ["TAIL"], endOfFile: true })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "head\nTAIL\n");
});

test("pure insertion appends with the file's own line style", () => {
  const applied = applyUpdateChunks(
    prepareSource("one\r\ntwo\r\n"),
    [chunk({ oldLines: [], newLines: ["three"] })],
    "f.txt",
  );

  assert.equal(applied.ok, true);

  if (!applied.ok) {
    return;
  }

  assert.equal(applied.content, "one\r\ntwo\r\nthree\r\n");
});

test("seekSequence finds exact, trimmed and normalised matches in order", () => {
  assert.equal(seekSequence(["a", "b"], ["b"], 0, false), 1);
  assert.equal(seekSequence(["a   "], ["a"], 0, false), 0);
  assert.equal(seekSequence(["  a  "], ["a"], 0, false), 0);
  assert.equal(seekSequence(["x \u2014 y"], ["x - y"], 0, false), 0);
  assert.equal(seekSequence(["a"], ["b"], 0, false), undefined);
  assert.equal(seekSequence(["a"], ["a", "b"], 0, false), undefined);
});
