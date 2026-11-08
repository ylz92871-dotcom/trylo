import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PATCH_HUNKS,
  applyPatch,
  parseUnifiedPatch,
  prepareSource,
} from "./patch-engine.js";

/**
 * The patch engine is pure, which is exactly why it can be attacked cheaply:
 * every shape below is something a model could emit, and none of them may leave
 * the caller with a half-applied file.
 */

const ONE_HUNK = "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three\n";

test("a single hunk applies and keeps the trailing newline exactly as it was", () => {
  const parsed = parseUnifiedPatch(ONE_HUNK);

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const kept = applyPatch(prepareSource("one\ntwo\nthree\n"), parsed.hunks);

  assert.equal(kept.ok, true);

  if (kept.ok) {
    assert.equal(kept.content, "one\ndeux\nthree\n");
  }

  const noTrailing = applyPatch(prepareSource("one\ntwo\nthree"), parsed.hunks);

  assert.equal(noTrailing.ok, true);

  if (noTrailing.ok) {
    assert.equal(noTrailing.content, "one\ndeux\nthree");
  }
});

test("pure additions and pure deletions both apply", () => {
  const addition = parseUnifiedPatch("@@ -1,2 +1,3 @@\n one\n+inserted\n two\n");

  assert.equal(addition.ok, true);

  if (addition.ok) {
    const applied = applyPatch(prepareSource("one\ntwo\n"), addition.hunks);
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.content, "one\ninserted\ntwo\n");
    }
  }

  const deletion = parseUnifiedPatch("@@ -1,3 +1,2 @@\n one\n-gone\n two\n");

  assert.equal(deletion.ok, true);

  if (deletion.ok) {
    const applied = applyPatch(prepareSource("one\ngone\ntwo\n"), deletion.hunks);
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.content, "one\ntwo\n");
    }
  }
});

test("a hunk whose counts disagree with its body is refused at parse time", () => {
  const parsed = parseUnifiedPatch("@@ -1,3 +1,3 @@\n one\n-two\n three\n");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "patch_parse_failed");
  }
});

test("D7: a count mismatch names the way out, not just the numbers", () => {
  // hard-eval：模型算错行数几乎必然发生；旧 CLI/apply_patch 系的教训是报错
  // 必须可行动。本引擎早支持 rangeless，但报错从没提过——消息补上出路。
  const parsed = parseUnifiedPatch("@@ -1,3 +1,3 @@\n one\n-two\n three\n");

  assert.equal(parsed.ok, false);

  if (!parsed.ok) {
    assert.match(parsed.message, /header \(\`@@\`\)/);
    assert.equal(parseUnifiedPatch("@@\n one\n-two\n three\n").ok, true);
    assert.match(parsed.message, /-3\/\+2/);
  }
});

test("a hunk header with its ranges left out applies by content alone", () => {
  const parsed = parseUnifiedPatch("@@\n one\n-two\n+deux\n three\n");

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.hunks[0]?.oldCount, undefined);
  const applied = applyPatch(prepareSource("one\ntwo\nthree\n"), parsed.hunks);

  assert.equal(applied.ok, true);

  if (applied.ok) {
    assert.equal(applied.content, "one\ndeux\nthree\n");
  }

  // Content is still the only thing that decides where it lands: a body that
  // appears nowhere is a mismatch, exactly as it is for a ranged header.
  const missing = applyPatch(prepareSource("nothing\nlike\nthis\n"), parsed.hunks);

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.code, "patch_hunk_mismatch");
  }
});

test("garbage where a hunk should be is refused, never skipped", () => {
  for (const patch of ["nonsense\n", "", "@@ -a +b @@\n one\n", "@@ -1 +1 @@\n?unknown\n"]) {
    const parsed = parseUnifiedPatch(patch);
    assert.equal(parsed.ok, false, patch);
    if (!parsed.ok) {
      assert.equal(parsed.code, "patch_parse_failed", patch);
    }
  }
});

test("hunks beyond the limit are refused rather than slowly applied", () => {
  const hunk = "@@ -1,1 +1,1 @@\n-a\n+b\n";
  const patch = `${hunk.repeat(MAX_PATCH_HUNKS + 1)}`;
  const parsed = parseUnifiedPatch(patch);

  assert.equal(parsed.ok, false);

  if (!parsed.ok) {
    assert.equal(parsed.code, "patch_too_large");
  }
});

test("a hunk that exists nowhere in the file is a mismatch, not a guess", () => {
  const parsed = parseUnifiedPatch(ONE_HUNK);

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const applied = applyPatch(prepareSource("something\nelse\n"), parsed.hunks);

  assert.equal(applied.ok, false);

  if (!applied.ok) {
    assert.equal(applied.code, "patch_hunk_mismatch");
    assert.match(applied.message, /hunk 0/);
  }
});

test("the declared line number decides between two identical contexts", () => {
  const parsed = parseUnifiedPatch("@@ -1,2 +1,2 @@\n-same\n+first\n same\n@@ -4,2 +4,2 @@\n-same\n+second\n same\n");

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const source = prepareSource("same\nsame\nsame\nsame\nsame\n");
  const applied = applyPatch(source, parsed.hunks);

  assert.equal(applied.ok, true);

  if (applied.ok) {
    assert.equal(applied.content, "first\nsame\nsame\nsecond\nsame\n");
  }
});

test("overlapping hunks are refused instead of silently dropping one", () => {
  const parsed = parseUnifiedPatch("@@ -3,1 +3,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-a\n+b\n");

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const applied = applyPatch(prepareSource("a\na\na\n"), parsed.hunks);

  assert.equal(applied.ok, false);

  if (!applied.ok) {
    assert.equal(applied.code, "patch_hunk_mismatch");
  }
});

test("a rewrite of the whole file is just another patch", () => {
  const parsed = parseUnifiedPatch("--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,1 @@\n-old\n-other\n+brand new\n");

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    const applied = applyPatch(prepareSource("old\nother\n"), parsed.hunks);
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.content, "brand new\n");
      assert.equal(applied.hunksApplied, 1);
    }
  }
});

test("D7: an LF patch applies to a CRLF file and the file stays CRLF", () => {
  // hard-eval #12：200/200 纯 CRLF 文件。补丁侧早归一，源侧没归一——整文件拒掉。
  // 对照 opencode 的 fuzzy replacer 系：行尾差异不该是 mismatch。
  const parsed = parseUnifiedPatch("@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three\n");

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const applied = applyPatch(prepareSource("one\r\ntwo\r\nthree\r\n"), parsed.hunks);

  assert.equal(applied.ok, true);

  if (applied.ok) {
    assert.equal(applied.content, "one\r\ndeux\r\nthree\r\n");
  }
});

test("D7: added lines take the file's own ending, untouched lines keep theirs", () => {
  const parsed = parseUnifiedPatch("@@ -1,2 +1,3 @@\n one\n+inserted\n two\n");

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const crlf = applyPatch(prepareSource("one\r\ntwo"), parsed.hunks);

  assert.equal(crlf.ok, true);

  if (crlf.ok) {
    assert.equal(crlf.content, "one\r\ninserted\r\ntwo");
  }

  // 混合行尾：没碰的行一个字节都不动。
  const single = parseUnifiedPatch("@@ -2,1 +2,1 @@\n-two\n+TWO\n");

  assert.equal(single.ok, true);

  if (!single.ok) {
    return;
  }

  const mixed = applyPatch(prepareSource("one\r\ntwo\nthree\r\n"), single.hunks);

  assert.equal(mixed.ok, true);

  if (mixed.ok) {
    assert.equal(mixed.content, "one\r\nTWO\nthree\r\n");
  }
});

test("a JSDoc context mismatch explains the diff prefix without weakening matching", () => {
  const source = prepareSource(" * @property {boolean} [fix] Enables fixes.\n */\n");
  const wrong = parseUnifiedPatch("@@\n * @property {boolean} [fix] Enables fixes.\n+ * @property {number} [maxFixPasses] Pass limit.\n  */");

  assert.equal(wrong.ok, true);

  if (!wrong.ok) return;

  const failed = applyPatch(source, wrong.hunks);

  assert.equal(failed.ok, false);

  if (failed.ok) return;

  assert.match(failed.message, /original indentation/);
  const corrected = parseUnifiedPatch("@@\n  * @property {boolean} [fix] Enables fixes.\n+ * @property {number} [maxFixPasses] Pass limit.\n  */");

  assert.equal(corrected.ok, true);

  if (!corrected.ok) return;

  const applied = applyPatch(source, corrected.hunks);

  assert.equal(applied.ok, true);

  if (applied.ok) assert.equal(applied.content, " * @property {boolean} [fix] Enables fixes.\n * @property {number} [maxFixPasses] Pass limit.\n */\n");
});
