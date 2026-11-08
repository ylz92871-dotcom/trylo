import assert from "node:assert/strict";
import { test } from "node:test";
import { aligned, humanBytes, isoDate, limited, LIST_LIMIT, relativeTime } from "./humanize.js";

/**
 * The list commands' formatting.
 *
 * These are pinned because they are what a person actually reads: a session
 * list that says `2026-09-25T22:42:46.439Z` and one that says `2 d ago` are
 * the same data, and only one of them can be scanned.
 *
 * `now` is always injected, never read from a clock, so "3 min ago" is a
 * number this file chose and not a number that drifts while the suite runs.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("byte counts are said in the unit a person would say", () => {
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(1023), "1023 B");
  assert.equal(humanBytes(1024), "1 KB");
  assert.equal(humanBytes(304_023), "297 KB");
  assert.equal(humanBytes(1024 * 1024), "1.0 MB");
  assert.equal(humanBytes(1024 * 1024 * 1024), "1.0 GB");
});

test("a size never grows more precise than the unit it is in", () => {
  for (const bytes of [0, 1, 999, 1024, 1_000_000, 999_999_999]) {
    assert.equal(humanBytes(bytes).includes("."), bytes >= 1024 * 1024, `${bytes}`);
  }
});

test("recent times are relative and old ones are not", () => {
  assert.equal(relativeTime(NOW - 5_000, NOW), "just now");
  assert.equal(relativeTime(NOW - 59_000, NOW), "just now");
  assert.equal(relativeTime(NOW - 3 * MINUTE, NOW), "3 min ago");
  assert.equal(relativeTime(NOW - 2 * HOUR, NOW), "2 hr ago");
  assert.equal(relativeTime(NOW - 3 * DAY, NOW), "3 d ago");
  // Past a week a relative time stops helping: "9 d ago" and a date are
  // equally unspecific, and only the date can be compared with its neighbours.
  assert.equal(relativeTime(NOW - 9 * DAY, NOW), isoDate(NOW - 9 * DAY));
});

test("a date is a plain YYYY-MM-DD, not a timestamp", () => {
  assert.equal(isoDate(NOW), "2026-09-27");
  assert.match(isoDate(NOW), /^\d{4}-\d{2}-\d{2}$/);
});

test("columns line up so the eye does not re-find them every row", () => {
  const lines = aligned([
    ["a", "bb"],
    ["ccc", "d"],
  ]);

  assert.deepEqual(lines, ["a    bb", "ccc  d"]);

  for (const line of lines) {
    assert.equal(line.endsWith(" "), false, "trailing padding is trimmed");
  }
});

test("aligning nothing says nothing", () => {
  assert.deepEqual(aligned([]), []);
});

test("a long list keeps its newest entries and counts the rest", () => {
  const items = Array.from({ length: LIST_LIMIT + 7 }, (_, at) => at);
  const { shown, hidden } = limited(items, LIST_LIMIT);
  assert.equal(shown.length, LIST_LIMIT);
  assert.equal(hidden, 7);
  assert.equal(shown[0], 0, "the newest first, which is the order the caller sorted into");
});

test("a short list is passed through untouched", () => {
  const { shown, hidden } = limited([1, 2, 3], LIST_LIMIT);
  assert.deepEqual(shown, [1, 2, 3]);
  assert.equal(hidden, 0);
});
