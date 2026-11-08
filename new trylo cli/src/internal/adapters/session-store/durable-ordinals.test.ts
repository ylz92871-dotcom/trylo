import assert from "node:assert/strict";
import test from "node:test";
import type { Transcript } from "../../protocol/transcript.js";
import { allToolCallsSettled, purgeUnsettledToolCalls } from "./transcript-purge.js";
import { resumedTranscriptFor } from "../../loop/request.js";
import { adoptResumedWindow, createCompactionLedger, journalView, windowOnJournal } from "../../loop/compact-ledger.js";

const history: Transcript = [
  { kind: "user", sequence: 0, text: "first" },
  { kind: "tool_call", sequence: 1, toolCallId: "same", name: "read_file", arguments: {} },
  { kind: "tool_result", sequence: 2, toolCallId: "same", name: "read_file", output: "ok", truncated: false, outcome: "succeeded" },
  { kind: "tool_call", sequence: 3, toolCallId: "same", name: "read_file", arguments: {} },
];
const window = { windowId: "w1", replacedFromSequence: 0, replacedToSequence: 2, summary: "summary", formatVersion: "1" };

test("a historical result cannot settle a later repeated call id", () => {
  assert.equal(allToolCallsSettled(history), false);
  assert.deepEqual(purgeUnsettledToolCalls(history), history.slice(0, 3));
});

test("a new result settles the nearest earlier call, preserving an older unanswered request as torn", () => {
  const transcript: Transcript = [history[1]!, history[3]!, { ...history[2]!, sequence: 4 }];
  assert.deepEqual(purgeUnsettledToolCalls(transcript).map(item => item.sequence), [3, 4]);
});

test("resume starts above the durable ordinal high-water even after a tail call is purged", () => {
  const durable = journalView("s", history, []);
  // Structural future signature keeps the red run executable against the old implementation.
  const resume: (items: Transcript, text: string, records: typeof durable) => Transcript = resumedTranscriptFor;
  const resumed = resume(history.slice(0, 3), "next", durable);
  assert.equal(resumed[resumed.length - 1]?.sequence, 4);
});

test("a compaction translates projected positions using source items with ordinal gaps", () => {
  const transcript: Transcript = [history[0]!, { kind: "user", sequence: 4, text: "next" }];
  const durable = journalView("s", history, []);
  const source = journalView("s", transcript, []);
  const translate: (win: typeof window, records: typeof durable, basis: typeof source) => typeof window | undefined = windowOnJournal;
  const mapped = translate(window, durable, source);

  assert.equal(mapped, undefined, "a source item missing from disk must not produce a partial window");
  const withNew = [...durable, { ...source[2]!, sequence: 5 }];

  assert.deepEqual(translate(window, withNew, source), { ...window, replacedFromSequence: 1, replacedToSequence: 5 });
});

test("adopting a persisted window counts only the projected transcript, leaving a new user tail live", () => {
  const durable = journalView("s", history, []);
  const ledger = createCompactionLedger();
  const projected: Transcript = [...history.slice(0, 3), { kind: "user", sequence: 4, text: "next" }];
  const adopt: (target: typeof ledger, win: typeof window, records: typeof durable, items: Transcript) => void = adoptResumedWindow;

  adopt(ledger, { ...window, replacedToSequence: 4 }, durable, projected);
  assert.equal(ledger.replacedPrefix, 3);
  assert.equal(projected.slice(ledger.replacedPrefix)[0]?.kind, "user");
});
