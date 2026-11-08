import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnDiffTracker } from "./turn-diff.js";
import { feedTurnDiffFromOutcome } from "./turn-diff-feed.js";

/**
 * WP11.1 (C20): the turn's net diff, aggregated from committed previews.
 *
 * Red evidence: these tests import `./turn-diff.js`, which did not exist
 * before WP11 — the suite fails to load on the unfixed tree. Behavioural
 * red was additionally shown by commenting out the tombstone branch in
 * `trackDelete`: `delete renders a tombstone` and `add-then-delete is net
 * zero` both fail (tombstone missing / stray deletion rendered).
 */

const UPDATE_PREVIEW = [
  "--- a/keep.ts",
  "+++ b/keep.ts",
  "@@ -1,2 +1,2 @@",
  " context",
  "-old",
  "+new",
  "",
].join("\n");

const SECOND_UPDATE_PREVIEW = [
  "--- a/keep.ts",
  "+++ b/keep.ts",
  "@@ -1,2 +1,2 @@",
  " context",
  "-new",
  "+newer",
  "",
].join("\n");

const DELETE_PREVIEW = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye", ""].join("\n");

const ADD_PREVIEW = ["--- /dev/null", "+++ b/fresh.ts", "@@ -0,0 +1,1 @@", "+hello", ""].join("\n");

const MOVE_PREVIEW = ["--- a/prev.ts", "+++ b/next.ts", "@@ -1,1 +1,1 @@", "-old-name", "+new-name", ""].join("\n");

const DELETE_PREVIEW_A = ["--- a/a.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye-a", ""].join("\n");

const MOVE_AB_PREVIEW = ["--- a/a.ts", "+++ b/b.ts", "@@ -1,1 +1,1 @@", "-old-a", "+new-b", ""].join("\n");

test("empty turn has no diff", () => {
  const tracker = createTurnDiffTracker();

  assert.equal(tracker.unifiedDiff(), undefined);
  assert.deepEqual(tracker.summary(), {
    files: 0,
    insertions: 0,
    deletions: 0,
    binaryFiles: 0,
    collapsed: 0,
    unrendered: 0,
  });
});

test("one update renders its preview and counts lines", () => {
  const tracker = createTurnDiffTracker();

  tracker.track({ path: "keep.ts", op: "updated", preview: UPDATE_PREVIEW, exact: true });
  assert.equal(tracker.unifiedDiff(), UPDATE_PREVIEW);
  assert.deepEqual(tracker.summary(), {
    files: 1,
    insertions: 1,
    deletions: 1,
    binaryFiles: 0,
    collapsed: 0,
    unrendered: 0,
  });
});

test("two writes to one path collapse to the last preview", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "keep.ts", op: "updated", preview: UPDATE_PREVIEW, exact: true });
  tracker.track({ path: "keep.ts", op: "updated", preview: SECOND_UPDATE_PREVIEW, exact: true });
  assert.equal(tracker.unifiedDiff(), SECOND_UPDATE_PREVIEW);
  assert.deepEqual(tracker.summary().collapsed, 1);
});

test("delete renders a tombstone", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "gone.ts", op: "deleted", preview: DELETE_PREVIEW, exact: true });
  assert.equal(tracker.unifiedDiff(), DELETE_PREVIEW);
  assert.deepEqual(tracker.summary().files, 1);
});

test("update-then-delete renders the deletion, not silence", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "gone.ts", op: "updated", preview: UPDATE_PREVIEW, exact: true });
  tracker.track({ path: "gone.ts", op: "deleted", preview: DELETE_PREVIEW, exact: true });
  assert.equal(tracker.unifiedDiff(), DELETE_PREVIEW);
});

test("add-then-delete is net zero", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "fresh.ts", op: "added", preview: ADD_PREVIEW, exact: true, isNew: true });
  tracker.track({ path: "fresh.ts", op: "deleted", preview: DELETE_PREVIEW, exact: true });
  assert.equal(tracker.unifiedDiff(), undefined);
  assert.deepEqual(tracker.summary().files, 0);
});

test("move renders once with origin, sorted among paths", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "b.ts", op: "updated", preview: UPDATE_PREVIEW, exact: true });
  tracker.track({ path: "next.ts", op: "moved", from: "prev.ts", preview: ADD_PREVIEW, exact: true });
  const diff = tracker.unifiedDiff() ?? "";
  assert.match(diff, /rename from prev\.ts\nrename to next\.ts/);
  assert.ok(diff.indexOf("b.ts") < diff.indexOf("rename from"));
});

test("binary change renders a differ line and counts no rows", () => {
  const tracker = createTurnDiffTracker();

  tracker.track({ path: "logo.png", op: "updated", preview: "unreadable-bytes", exact: true, binary: true });
  assert.equal(tracker.unifiedDiff(), "Binary files a/logo.png and b/logo.png differ\n");
  assert.deepEqual(tracker.summary(), {
    files: 1,
    insertions: 0,
    deletions: 0,
    binaryFiles: 1,
    collapsed: 0,
    unrendered: 0,
  });
});

test("inexact delta invalidates the whole turn", () => {
  const tracker = createTurnDiffTracker();

  tracker.track({ path: "keep.ts", op: "updated", preview: UPDATE_PREVIEW, exact: true });
  tracker.track({ path: "half.ts", op: "updated", preview: "partial", exact: false });
  assert.equal(tracker.valid, false);
  assert.match(tracker.invalidReason ?? "", /inexact delta for half\.ts/);
  assert.equal(tracker.unifiedDiff(), undefined);
  assert.deepEqual(tracker.summary().files, 0);
});

test("a move without a source invalidates with a named reason", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "next.ts", op: "moved", preview: ADD_PREVIEW, exact: true });
  assert.equal(tracker.valid, false);
  assert.match(tracker.invalidReason ?? "", /without a source/);
});

test("long turns truncate with a marker, never silently", () => {
  const tracker = createTurnDiffTracker();
  const big = `--- a/big.ts\n+++ b/big.ts\n${"+x\n".repeat(70_000)}`;
  tracker.track({ path: "big.ts", op: "updated", preview: big, exact: true });
  const diff = tracker.unifiedDiff() ?? "";
  assert.ok(diff.includes("... [turn diff truncated:"));
  assert.ok(diff.length < big.length + 200);
});

test("F4 counter-example A: move plus recreate renders two additions, never a rename", () => {
  // One apply_patch can move A->B and then add a new A. Codex pairs nothing
  // here (`current.contains(origin)`): A renders as modification, B as
  // addition. Without baseline contents the modification reads as an
  // addition, but A must never be counted twice nor B mislabelled a rename.
  // Red evidence: with the old render (origins map only) the diff contained
  // both "rename from a.ts to b.ts" and a second a.ts section.
  const tracker = createTurnDiffTracker();

  tracker.track({ path: "b.ts", op: "moved", from: "a.ts", preview: MOVE_PREVIEW, exact: true });
  tracker.track({ path: "a.ts", op: "added", preview: ADD_PREVIEW, exact: true, isNew: true });
  const diff = tracker.unifiedDiff() ?? "";

  assert.ok(!diff.includes("rename from"), `must not pair:\n${diff}`);
  assert.deepEqual(tracker.summary().files, 2);
});

test("F4 counter-example B: move onto an existing file renders change plus deletion", () => {
  // Codex refuses the pairing (`baseline.contains(dest)`): "A deleted, B
  // modified". The destination keeps its real preview; the origin renders a
  // header-only deletion pointing at the checkpoint instead of fabricated
  // content. Red evidence: the old render printed "rename from a.ts to b.ts"
  // and lost the fact that b.ts previously existed.
  const tracker = createTurnDiffTracker();

  tracker.track({
    path: "b.ts",
    op: "moved",
    from: "a.ts",
    preview: MOVE_AB_PREVIEW,
    exact: true,
    overwrote: true,
  });
  const diff = tracker.unifiedDiff() ?? "";

  assert.ok(!diff.includes("rename from"), `must not pair an overwrite:\n${diff}`);
  assert.match(diff, /\+\+\+ b\/b\.ts/);
  assert.match(diff, /--- a\/a\.ts\n\+\+\+ \/dev\/null/);
  assert.match(diff, /turn checkpoint holds the bytes/);
  assert.deepEqual(tracker.summary().files, 2);
});

test("a retained origin preview renders the full deletion", () => {
  const tracker = createTurnDiffTracker();

  tracker.track({
    path: "b.ts",
    op: "moved",
    from: "a.ts",
    preview: MOVE_AB_PREVIEW,
    exact: true,
    overwrote: true,
    originPreview: DELETE_PREVIEW_A,
  });
  const diff = tracker.unifiedDiff() ?? "";

  assert.ok(diff.includes(DELETE_PREVIEW_A.trim()));
});

test("moving a turn-created file pairs nothing and stays an addition", () => {
  const tracker = createTurnDiffTracker();
  tracker.track({ path: "fresh.ts", op: "added", preview: ADD_PREVIEW, exact: true, isNew: true });
  tracker.track({ path: "next.ts", op: "moved", from: "fresh.ts", preview: ADD_PREVIEW, exact: true });
  const diff = tracker.unifiedDiff() ?? "";
  assert.ok(!diff.includes("rename from"), `a rename of a new file is an addition:\n${diff}`);
  assert.deepEqual(tracker.summary().files, 1);
});

test("feeder maps an apply_patch outcome value, honouring exact", () => {
  const tracker = createTurnDiffTracker();

  feedTurnDiffFromOutcome(tracker, {
    applied: [
      { op: "added", path: "fresh.ts", bytes: 6, mode: "created", preview: ADD_PREVIEW },
      { op: "updated", path: "keep.ts", bytes: 20, mode: "patched", preview: UPDATE_PREVIEW },
      { op: "moved", from: "old.ts", path: "new.ts", bytes: 6, preview: MOVE_PREVIEW },
      { op: "deleted", path: "gone.ts", bytes: 4, preview: DELETE_PREVIEW },
    ],
    exact: true,
    fileWrites: [],
  });
  assert.equal(tracker.valid, true);
  assert.deepEqual(tracker.summary().files, 4);
  const diff = tracker.unifiedDiff() ?? "";

  assert.match(diff, /rename from old\.ts\nrename to new\.ts/);
});

test("feeder invalidates on an inexact batch and on malformed changes", () => {
  const inexact = createTurnDiffTracker();

  feedTurnDiffFromOutcome(inexact, { applied: [], exact: false, fileWrites: [] });
  assert.equal(inexact.valid, false);
  assert.match(inexact.invalidReason ?? "", /inexact/);

  const malformed = createTurnDiffTracker();

  feedTurnDiffFromOutcome(malformed, { applied: [{ op: "moved", path: "x" }], exact: true, fileWrites: [] });
  assert.equal(malformed.valid, false);
});

test("feeder ignores non-mutating tools and shapes", () => {
  const tracker = createTurnDiffTracker();
  feedTurnDiffFromOutcome(tracker, { output: "hello" });
  feedTurnDiffFromOutcome(tracker, { fileWrite: { kind: "nope", path: "", bytes: 0, mode: "x" } });
  assert.equal(tracker.valid, true);
  assert.deepEqual(tracker.summary().files, 0);
});

test("single-file writes without previews count in the trailer, never invented", () => {
  const tracker = createTurnDiffTracker();

  feedTurnDiffFromOutcome(tracker, {
    fileWrite: { kind: "file_write", path: "over.ts", bytes: 9, mode: "overwritten" },
    path: "over.ts",
    bytes: 9,
    mode: "overwritten",
  });
  assert.equal(tracker.valid, true);
  assert.deepEqual(tracker.summary().files, 1);
  assert.deepEqual(tracker.summary().unrendered, 1);
  const diff = tracker.unifiedDiff() ?? "";

  assert.match(diff, /without retained previews/);
});
