import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANCELLED_TOOL_RESULT_TEXT,
  pairCancelledToolCalls,
  toolPairingOf,
} from "./transcript-append.js";
import type { Transcript } from "../protocol/transcript.js";

/**
 * L04: a cancelled turn must not leave a `tool_use` unanswered.
 *
 * The legacy runtime had a function for exactly this — `yieldMissingToolResultBlocks`
 * in `trylo cli/src/query.ts:124`, called on the abort path — because a
 * `tool_use` with no `tool_result` makes the next request invalid. Measured
 * missing here: `evidence/2026-10-05-WP07/probe-l04-orphan-tool-use.mjs` recorded
 * a cancelled turn leaving `[user, tool_call, tool_call]` with two orphans.
 */

function toolCallItem(id: string, name = "echo"): Transcript[number] {
  return { kind: "tool_call", sequence: 1, toolCallId: id, name, arguments: { text: id } };
}

function toolResultItem(id: string, name = "echo"): Transcript[number] {
  return {
    kind: "tool_result",
    sequence: 2,
    toolCallId: id,
    name,
    output: "done",
    truncated: false,
    outcome: "succeeded",
  };
}

test("pairing reports an unanswered tool_use as an orphan", () => {
  const pairing = toolPairingOf([
    { kind: "user", sequence: 0, text: "go" },
    toolCallItem("call-1"),
    toolCallItem("call-2"),
  ]);

  assert.deepEqual(pairing.asked, ["call-1", "call-2"]);
  assert.deepEqual(pairing.orphans, ["call-1", "call-2"]);
});

test("a transcript with no orphans reports none", () => {
  const pairing = toolPairingOf([toolCallItem("call-1"), toolResultItem("call-1")]);
  assert.deepEqual(pairing.orphans, []);
});

test("every orphan gets a cancelled result, and the pairing closes", () => {
  const before: Transcript = [
    { kind: "user", sequence: 0, text: "go" },
    toolCallItem("call-1"),
    toolCallItem("call-2"),
  ];
  const after = pairCancelledToolCalls(before);

  assert.deepEqual(toolPairingOf(after).orphans, [], "the gap must be closed");
  const results = after.filter((item) => item.kind === "tool_result");

  assert.equal(results.length, 2);

  for (const result of results) {
    if (result.kind !== "tool_result") throw new Error("expected a tool_result");
    assert.equal(result.outcome, "cancelled", "a synthetic result must not claim success");
    assert.equal(result.output, CANCELLED_TOOL_RESULT_TEXT);
  }
});

test("the synthetic result names the tool that was asked for", () => {
  const after = pairCancelledToolCalls([toolCallItem("call-1", "write_file")]);
  const result = after.find((item) => item.kind === "tool_result");
  if (result?.kind !== "tool_result") throw new Error("expected a tool_result");
  assert.equal(result.name, "write_file");
  assert.equal(result.toolCallId, "call-1");
});

test("a call that already has a result is left exactly as it was", () => {
  const before: Transcript = [toolCallItem("call-1"), toolResultItem("call-1")];
  assert.equal(pairCancelledToolCalls(before), before, "nothing to close means nothing changes");
});

test("the same call asked twice is answered once, and the second ask is still an orphan", () => {
  // Pairing is positional, not by id: asking twice and answering once leaves the
  // second ask unanswered, and closing it takes a second result. An earlier
  // version of this test asserted one result here, on the reasoning that "a
  // repeated `tool_call` for one id is a repeated fact, not a second call". That
  // premise is what F3 removed: it is exactly what made
  // `tool_call(x)/tool_result(x)/tool_call(x)` report "settled" and hide the
  // orphan L04 exists to catch. Three sources agree on the position rule — the
  // legacy `yieldMissingToolResultBlocks` (`trylo cli/src/query.ts:135`, one
  // `tool_result` per `tool_use` block), `session-store/durable-ordinals.test.ts:16`,
  // and the malformed request a lone unanswered `tool_use` produces. Evidence:
  // `evidence/2026-10-05-WP07/17-transcript-pairing-id-rule-collision.md`.
  const answeredOnce: Transcript = [
    toolCallItem("call-1"),
    toolResultItem("call-1"),
    toolCallItem("call-1"),
  ];

  assert.deepEqual(
    toolPairingOf(answeredOnce).orphans,
    ["call-1"],
    "the second ask is unanswered even though the id was answered once",
  );
  const closed = pairCancelledToolCalls(answeredOnce);

  assert.deepEqual(toolPairingOf(closed).orphans, [], "both asks end up answered");
  assert.equal(closed.filter((item) => item.kind === "tool_result").length, 2);
});

test("an id that already has its result is not given a second one", () => {
  // The half of the old expectation that was real: pairing must not invent a
  // duplicate result for a call the transcript already carries an answer for.
  // Counted per call, not per id — see the test above.
  const before: Transcript = [toolCallItem("call-1"), toolResultItem("call-1")];

  assert.equal(pairCancelledToolCalls(before), before, "one result is enough for one call");
  assert.equal(
    before.filter((item) => item.kind === "tool_result").length,
    1,
    "the existing result is the only one",
  );
});

test("an orphan is reported as cancelled, never as succeeded or failed", () => {
  // The distinction is the whole point: "stopped" and "produced nothing" are
  // different facts, and a reader must be able to tell them apart.
  const after = pairCancelledToolCalls([toolCallItem("call-1")]);
  const outcome = after.find((item) => item.kind === "tool_result");
  if (outcome?.kind !== "tool_result") throw new Error("expected a tool_result");

  assert.equal(outcome.outcome, "cancelled");
  assert.notEqual(outcome.outcome, "succeeded");
  assert.notEqual(outcome.outcome, "failed");
  assert.equal(outcome.truncated, false, "nothing was produced, so nothing was cut");
});
