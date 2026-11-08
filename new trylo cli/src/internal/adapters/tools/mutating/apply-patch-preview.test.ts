import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPreview } from "./apply-patch-preview.js";
import type { AppliedRegion } from "./apply-patch-match.js";

/**
 * WP10/L15: every committed file carries a unified diff preview rendered
 * from the operations that actually applied — never re-diffed, so the
 * preview cannot disagree with the bytes on disk.
 */

function region(ops: AppliedRegion["ops"], oldStart = 0, newStart = 0): AppliedRegion {
  return { oldStart, newStart, ops };
}

test("an update renders one hunk with context and changed lines", () => {
  const preview = renderPreview({
    kind: "updated",
    path: "f.txt",
    before: "one\ntwo\nthree\nfour\nfive\n",
    after: "one\ndeux\nthree\nfour\nfive\n",
    regions: [region([{ kind: "context", text: "one" }, { kind: "removed", text: "two" }, { kind: "added", text: "deux" }], 0, 0)],
  });

  assert.ok(preview.includes("--- a/f.txt"));
  assert.ok(preview.includes("+++ b/f.txt"));
  assert.ok(preview.includes("@@ -1,5 +1,5 @@"));
  assert.ok(preview.includes(" one"));
  assert.ok(preview.includes("-two"));
  assert.ok(preview.includes("+deux"));
  assert.ok(preview.includes(" three"));
});

test("an addition renders against /dev/null", () => {
  const preview = renderPreview({
    kind: "added",
    path: "new.txt",
    before: "",
    after: "hello\n",
    regions: [],
  });

  assert.ok(preview.includes("--- /dev/null"));
  assert.ok(preview.includes("+++ b/new.txt"));
  assert.ok(preview.includes("+hello"));
});

test("a deletion renders the removed lines", () => {
  const preview = renderPreview({
    kind: "deleted",
    path: "gone.txt",
    before: "bye\n",
    after: "",
    regions: [],
  });

  assert.ok(preview.includes("--- a/gone.txt"));
  assert.ok(preview.includes("+++ /dev/null"));
  assert.ok(preview.includes("-bye"));
});

test("a move names both ends of the rename", () => {
  const preview = renderPreview({
    kind: "moved",
    path: "dst.txt",
    from: "src.txt",
    before: "old\n",
    after: "new\n",
    regions: [region([{ kind: "removed", text: "old" }, { kind: "added", text: "new" }], 0, 0)],
  });

  assert.ok(preview.includes("--- a/src.txt"));
  assert.ok(preview.includes("+++ b/dst.txt"));
});

test("distant changes become separate hunks, not one giant hunk", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n");
  const first = region([{ kind: "removed", text: "line1" }, { kind: "added", text: "LINE1" }], 1, 1);
  const second = region([{ kind: "removed", text: "line28" }, { kind: "added", text: "LINE28" }], 28, 28);
  const preview = renderPreview({ kind: "updated", path: "f.txt", before, after: before, regions: [first, second] });
  assert.equal(preview.match(/^@@/gm)?.length, 2);
});

test("adjacent changes merge into one hunk with the gap kept as context", () => {
  const before = "line0\nline1\nline2\nline3\nline4\n";
  const first = region([{ kind: "removed", text: "line0" }, { kind: "added", text: "X" }], 0, 0);
  const second = region([{ kind: "removed", text: "line2" }, { kind: "added", text: "Z" }], 2, 2);
  const preview = renderPreview({ kind: "updated", path: "f.txt", before, after: before, regions: [first, second] });

  assert.equal(preview.match(/^@@/gm)?.length, 1);
  // The gap line survives on both sides; nothing is skipped or misaligned.
  assert.ok(preview.includes(" line1"));
  assert.ok(preview.includes("-line0"));
  assert.ok(preview.includes("+X"));
  assert.ok(preview.includes("-line2"));
  assert.ok(preview.includes("+Z"));
  assertHunkSelfConsistent(preview);
});

test("every rendered hunk header agrees with its body", () => {
  const before = Array.from({ length: 12 }, (_, index) => `row${index}`).join("\n");
  const first = region([{ kind: "removed", text: "row1" }, { kind: "added", text: "ROW1" }], 1, 1);
  const second = region([{ kind: "removed", text: "row3" }, { kind: "added", text: "ROW3" }], 3, 3);
  const third = region([{ kind: "removed", text: "row11" }, { kind: "added", text: "ROW11" }], 11, 11);
  const preview = renderPreview({ kind: "updated", path: "f.txt", before, after: before, regions: [first, second, third] });

  assert.equal(preview.match(/^@@/gm)?.length, 2);
  assertHunkSelfConsistent(preview);
});

/** A hunk whose header counts disagree with its body cannot be applied. */
function assertHunkSelfConsistent(preview: string): void {
  const lines = preview.split("\n");
  let header: RegExpMatchArray | null = null;
  let oldSeen = 0;
  let newSeen = 0;
  const check = (): void => {
    if (header !== null) {
      assert.equal(oldSeen, Number(header[1]), `old count for ${header[0]}`);
      assert.equal(newSeen, Number(header[2]), `new count for ${header[0]}`);
    }
  };

  for (const line of lines) {
    const opened = line.match(/^@@ -\d+,(\d+) \+\d+,(\d+) @@/);
    if (opened !== null) {
      check();
      header = opened;
      oldSeen = 0;
      newSeen = 0;
      continue;
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("... [preview")) {
      continue;
    }

    if (line.length === 0) {
      continue;
    }

    if (line.startsWith(" ")) {
      oldSeen += 1;
      newSeen += 1;
    } else if (line.startsWith("-")) {
      oldSeen += 1;
    } else if (line.startsWith("+")) {
      newSeen += 1;
    }
  }

  check();
}

test("a huge addition is truncated with a visible marker, never silently cut", () => {
  const after = Array.from({ length: 500 }, (_, index) => `row${index}`).join("\n");
  const preview = renderPreview({ kind: "added", path: "big.txt", before: "", after, regions: [] });
  assert.ok(preview.includes("preview truncated"));
  assert.ok(preview.split("\n").length < 500);
});
