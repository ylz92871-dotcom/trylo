import assert from "node:assert/strict";
import { test } from "node:test";

import { cutToBytes as cutFromProtocol, cutToBytesWithRemainder } from "../protocol/text-cut.js";
import { cutToBytes as cutFromAdapters, cutToBytesWithRemainder as remainderFromAdapters } from "../adapters/text-cut.js";
import { allToolCallsSettled as settledFromStore } from "../adapters/session-store/transcript-purge.js";
import { MAX_TOOL_OUTPUT_BYTES, boundToolOutput } from "../loop/tool-execution.js";
import { toolPairingOf } from "../loop/transcript-append.js";
import { allToolCallsSettled, unansweredCallIndexes } from "../protocol/tool-pairing.js";
import type { Transcript } from "../protocol/transcript.js";

// Kept under `integration/`, not `loop/`: this file pins that the loop and the
// adapters agree, so it has to name both sides -- and `loop/**` may not import
// `adapters/**` (quality gate step 4). `integration/**` is the one layer that
// may name both.

/**
 * Cross-implementation pins for the two rules that had more than one home.
 *
 * A duplication is only dangerous while the copies still agree, so the pin has
 * to compare the copies *against each other* — asserting each one's own
 * behaviour lets them drift apart unnoticed, which is exactly what happened:
 * `loop` decided "answered" by id while `session-store` decided it by position,
 * and the id-based reading hid an orphan in the one case that produces one. The
 * review that found it called for a shared owner plus a test that holds both
 * sides; the owner is now `protocol/`, and this file is that test.
 *
 * It lives here rather than in `protocol/` on purpose: a test that reaches
 * upward into `loop` and `adapters` is a cross-layer test, and putting it in the
 * shared layer would make that layer depend on its consumers.
 *
 * Every case below is a case where the two former answers disagreed.
 */

/** CJK, an emoji, and an ASCII run — one per width class a cut can land in. */
const SAMPLES = ["汉".repeat(64), "\u{1F44D}".repeat(64), "x".repeat(64), ""];

test("both cut paths are the same function, not two implementations", () => {
  // If this ever fails, a second copy of the byte rule has reappeared — which is
  // the defect the shared module exists to prevent, so it must be able to fail.
  for (const sample of SAMPLES) {
    for (const budget of [0, 1, 3, 7, 16, 31, 64, 129]) {
      assert.equal(
        cutFromAdapters(sample, budget),
        cutFromProtocol(sample, budget),
        `cut differs at budget ${budget} for ${JSON.stringify(sample.slice(0, 2))}`,
      );
    }
  }
  // Deep, not `equal`: this one returns an object, and `equal` would compare
  // references and fail on two structurally identical results.
  assert.deepEqual(
    remainderFromAdapters("汉".repeat(10), 8),
    cutToBytesWithRemainder("汉".repeat(10), 8),
  );
});

test("the loop's bound and the shared cutter agree on every byte boundary", () => {
  // The loop used to carry its own `headWithin`. Now that it calls the shared
  // primitive, the head it keeps must be exactly what `cutToBytes` returns for
  // the same budget — otherwise the two "agree today" by accident again.
  for (const sample of [
    "汉".repeat(40_000),
    "\u{1F44D}".repeat(40_000),
    "x".repeat(MAX_TOOL_OUTPUT_BYTES + 1),
  ]) {
    const bounded = boundToolOutput(`${sample}TAIL-ERROR: it failed`, false);

    assert.equal(bounded.truncated, true);
    assert.equal(bounded.output.includes("�"), false, "a cut must not leave a replacement character");
    const markerAt = bounded.output.indexOf("\n[truncated]\n");

    assert.ok(markerAt > 0, "the marker must be present and not at the very start");
    const head = bounded.output.slice(0, markerAt);
    const expectedHead = cutFromProtocol(sample, Math.ceil((MAX_TOOL_OUTPUT_BYTES - 13) / 2));

    assert.equal(head, expectedHead, "the loop's head is not the shared cutter's head");
  }
});

test("a cut never emits half a character, whichever copy asks for it", () => {
  for (const sample of ["汉".repeat(50), "\u{1F44D}".repeat(50), "é".repeat(50), "\u{1D518}".repeat(50)]) {
    for (const budget of [1, 2, 3, 4, 7, 13, 64, 129]) {
      const cut = cutFromProtocol(sample, budget);
      assert.equal(cut.includes("�"), false, `replacement character at budget ${budget}`);
      assert.ok(Buffer.byteLength(cut, "utf8") <= budget, `budget ${budget} exceeded`);
    }
  }
});

/** `tool_call(x) / tool_result(x) / tool_call(x)` — the input both sides once split on. */
const repeatedId: Transcript = [
  { kind: "user", sequence: 0, text: "go" },
  { kind: "tool_call", sequence: 1, toolCallId: "x", name: "read_file", arguments: {} },
  { kind: "tool_result", sequence: 2, toolCallId: "x", name: "read_file", output: "ok", truncated: false, outcome: "succeeded" },
  { kind: "tool_call", sequence: 3, toolCallId: "x", name: "read_file", arguments: {} },
];

test("the two 'answered' definitions now return the same answer", () => {
  assert.equal(
    allToolCallsSettled(repeatedId),
    settledFromStore(repeatedId),
    "protocol and session-store disagree about whether this transcript is settled",
  );
});

test("a repeated id is not a settled id: the second ask is still an orphan", () => {
  // The case the id-based rule hid. L04 exists to find exactly this, and an
  // answer of "no orphans" here would let a dangling `tool_use` reach the next
  // provider request, which most providers reject.
  const pairing = toolPairingOf(repeatedId);

  assert.equal(pairing.asked.length, 1, "asked lists the id once");
  assert.deepEqual(pairing.orphans, ["x"], "but the second, unanswered call is still an orphan");
  assert.equal(allToolCallsSettled(repeatedId), false);
});

test("the loop's pairing and the store's verdict agree across shapes", () => {
  const shapes: ReadonlyArray<Transcript> = [
    [],
    [{ kind: "user", sequence: 0, text: "no tools here" }],
    repeatedId,
    [
      { kind: "tool_call", sequence: 0, toolCallId: "a", name: "t", arguments: {} },
      { kind: "tool_result", sequence: 1, toolCallId: "a", name: "t", output: "ok", truncated: false, outcome: "failed" },
    ],
    [
      { kind: "tool_call", sequence: 0, toolCallId: "a", name: "t", arguments: {} },
      { kind: "tool_call", sequence: 1, toolCallId: "b", name: "t", arguments: {} },
      { kind: "tool_result", sequence: 2, toolCallId: "a", name: "t", output: "ok", truncated: false, outcome: "cancelled" },
    ],
  ];
  for (const shape of shapes) {
    // An orphan exists exactly when not everything is settled — the two facts
    // are one fact seen from opposite sides.
    const settled = allToolCallsSettled(shape);
    const orphans = toolPairingOf(shape).orphans;

    assert.equal(
      settled,
      orphans.length === 0,
      `shape ${JSON.stringify(shape.map((i) => i.kind))}: settled=${settled} but orphans=${orphans.length}`,
    );
    assert.equal(
      unansweredCallIndexes(shape).size,
      orphans.length,
      "the positional and id views must count the same calls",
    );
  }
});

test("a result settles the nearest earlier call, never a later one", () => {
  const reversed: Transcript = [
    { kind: "tool_result", sequence: 0, toolCallId: "a", name: "t", output: "early", truncated: false, outcome: "succeeded" },
    { kind: "tool_call", sequence: 1, toolCallId: "a", name: "t", arguments: {} },
  ];
  assert.equal(allToolCallsSettled(reversed), false, "a result cannot arrive before its call");
  assert.deepEqual(toolPairingOf(reversed).orphans, ["a"]);
});
