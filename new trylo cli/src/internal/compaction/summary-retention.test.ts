import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../protocol/transcript.js";
import { summarizeTranscript } from "./summary.js";

/**
 * WP09.2 — what the digest must survive with.
 *
 * The extractive digest used to keep the *head* of the replaced range and drop
 * the tail first. For a second compaction that is exactly backwards: the head
 * carries the task's standing constraints, but the tail carries the most
 * recent state before the window boundary — the last steer, the last tool
 * outcome — and losing it first is how a task quietly drifts off its
 * constraints after two compactions (WP09.2's acceptance case).
 *
 * The contract now: the digest keeps the head (constraints, goals) AND the
 * tail (recent state), and elides the middle with an explicit count. Written
 * against the unfixed summarizer first (red evidence, WP09 交接记录).
 */

function userItem(sequence: number, text: string): TranscriptItem {
  return { kind: "user", sequence, text };
}

const HEAD_MARK = "CONSTRAINT-KEEP-TESTS-GREEN";
const TAIL_MARK = "LATEST-USER-STEER-MARKER";

test("an overflowing digest keeps the first line and the last line", () => {
  const items: TranscriptItem[] = [
    userItem(0, `${HEAD_MARK}: follow the repo discipline`),
    ...Array.from({ length: 40 }, (_, index): TranscriptItem =>
      userItem(index + 1, `filler line ${index} ${"p".repeat(180)}`)),
    userItem(41, `${TAIL_MARK}: switch to the other module`),
  ];
  const summary = summarizeTranscript(items, { maxChars: 1_200 });

  assert.ok(summary.length <= 1_200, `summary is ${summary.length} chars`);
  assert.equal(summary.includes(HEAD_MARK), true, "the standing constraint (head) must survive");
  assert.equal(summary.includes(TAIL_MARK), true, "the latest steer (tail) must survive");
  assert.equal(summary.includes("[elided"), true, "the elided middle is counted, not hidden");
});

test("a digest that fits whole is unchanged by the retention policy", () => {
  const items: TranscriptItem[] = [
    userItem(0, "short one"),
    userItem(1, "short two"),
  ];
  const summary = summarizeTranscript(items);
  assert.equal(summary, "user: short one\nuser: short two");
});

test("a near-limit single-paragraph previous summary retains its head alongside new work", () => {
  const previousSummary = "Keep the public API compatible. " + "prior context ".repeat(290);
  // The old implementation ignores this additional option; that must fail the retention assertion.
  const options = { maxChars: 4000, previousSummary };
  const summary = summarizeTranscript([userItem(9, "Verify the next stage. " + "latest ".repeat(27))], options);

  assert.match(summary, /Keep the public API compatible/);
  assert.match(summary, /Verify the next stage/);
  assert.ok(summary.length <= 4000);
});
