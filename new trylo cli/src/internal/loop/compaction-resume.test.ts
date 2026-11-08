import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactWindow } from "../ports/compaction.js";
import { SESSION_FORMAT_VERSION, type SessionRecord } from "../ports/session.js";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { Transcript, TranscriptItem } from "../protocol/transcript.js";
import { adoptResumedWindow, createCompactionLedger, journalView, windowOnJournal } from "./compact-ledger.js";
import {
  createFakeCompaction,
  createFakePermission,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
  type FakeCompaction,
} from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * The two numberings a window has to survive (WP E 波 §6.3).
 *
 * The loop numbers `session_start` 0 and the transcript items after it: that is
 * what makes an in-memory window comparable with the items the next one would
 * cover. The durable journal numbers every record it holds — `turn_start`,
 * envelopes, effect rows and terminals included — so the same window means a
 * different position once it is stored. Nothing reconciles them on its own, and
 * nothing fails loudly either: a bound that lands short leaves replaced text in
 * the model's live history, and a bound that lands long drops live items.
 *
 * The fixture makes the gap visible by construction: `session_start` is 0,
 * `turn_start` is 1, so the items occupy 2..5 and a window standing in for the
 * first three of them reads 2..4 — never 0..3. Every case below is one leg of
 * that crossing.
 */

const ORIGINAL = "ORIGINAL-SEGMENT-MARKER";
const TOOL_OUTPUT = "TOOL-OUTPUT-MARKER";
const AT = "1970-01-01T00:00:00.000Z";

const USER: TranscriptItem = { kind: "user", sequence: 0, text: ORIGINAL };
const CALL: TranscriptItem = {
  kind: "tool_call",
  sequence: 1,
  toolCallId: "call-0",
  name: "echo",
  arguments: {},
};
const OUTPUT: TranscriptItem = {
  kind: "tool_result",
  sequence: 2,
  toolCallId: "call-0",
  name: "echo",
  output: TOOL_OUTPUT,
  truncated: false,
  outcome: "succeeded",
};
const DONE: TranscriptItem = { kind: "assistant_text", sequence: 3, blockId: "b0", text: "done" };
const RESUMED_ITEMS: Transcript = [USER, CALL, OUTPUT, DONE];

function journalRecord(
  sequence: number,
  type: SessionRecord["type"],
  payload: object,
): SessionRecord {
  return {
    formatVersion: SESSION_FORMAT_VERSION,
    sequence,
    type,
    sessionId: "s",
    at: AT,
    payload: payload as SessionRecord["payload"],
  };
}

/** The four items as a journal holds them: two bookkeeping rows first, then items. */
const RESUMED_JOURNAL: ReadonlyArray<SessionRecord> = [
  journalRecord(0, "session_start", {}),
  journalRecord(1, "turn_start", { iterations: 1 }),
  journalRecord(2, "transcript_item", USER),
  journalRecord(3, "transcript_item", CALL),
  journalRecord(4, "transcript_item", OUTPUT),
  journalRecord(5, "transcript_item", DONE),
  journalRecord(6, "terminal", { reason: "completed" }),
  journalRecord(7, "compact", {
    windowId: "w1",
    replacedFromSequence: 2,
    replacedToSequence: 4,
    summary: "SUMMARY-MARKER",
    formatVersion: "1",
  }),
];

/** The stored window alone: the first three items, in journal sequences. */
const RESUMED_WINDOW: CompactWindow = {
  windowId: "w1",
  replacedFromSequence: 2,
  replacedToSequence: 4,
  summary: "SUMMARY-MARKER",
  formatVersion: "1",
};

// ---------------------------------------------------------------------------
// The crossing itself.
// ---------------------------------------------------------------------------

test("a stored window is adopted as a count of items, not as journal positions", () => {
  const ledger = createCompactionLedger();

  adoptResumedWindow(ledger, RESUMED_WINDOW, RESUMED_JOURNAL);
  assert.equal(ledger.replacedPrefix, 3);
  // Re-expressed into this numbering: `session_start` 0, the three replaced
  // items at 1..3. Keeping 2..4 here would point past the tail it stands for.
  assert.equal(ledger.resumed?.window.replacedFromSequence, 0);
  assert.equal(ledger.resumed?.window.replacedToSequence, 3);
  assert.equal(ledger.resumed?.afterItemCount, 3);
});

test("a window with no journal to stand on is not adopted", () => {
  // No journal at all: the bounds are positions in nothing, and a digest over
  // history nobody replaced would invent a past. The turn then sends the
  // transcript whole, which is what a run without compaction does.
  const bare = createCompactionLedger();

  adoptResumedWindow(bare, RESUMED_WINDOW, undefined);
  assert.equal(bare.window, undefined);
  assert.equal(bare.replacedPrefix, 0);
  assert.equal(bare.resumed, undefined);

  // A journal that holds no item the window could stand in for says the same.
  const empty = createCompactionLedger();

  adoptResumedWindow(empty, RESUMED_WINDOW, [journalRecord(0, "session_start", {})]);
  assert.equal(empty.window, undefined);
  assert.equal(empty.replacedPrefix, 0);
});

test("the adopted window is placed in the decision journal before the turn's own items", () => {
  const ledger = createCompactionLedger();

  adoptResumedWindow(ledger, RESUMED_WINDOW, RESUMED_JOURNAL);
  const view = journalView("s", RESUMED_ITEMS, ledger.entries, ledger.resumed);

  // `session_start` 0, three items, the window, then the fourth item: the window
  // sits where it was stored, so a second one added later still advances past it.
  assert.deepEqual(
    view.map((record) => record.type),
    [
      "session_start",
      "transcript_item",
      "transcript_item",
      "transcript_item",
      "compact",
      "transcript_item",
    ],
  );
  assert.equal(view[4]?.payload["windowId"], "w1");
});

test("a window decided in this numbering is placed back on the journal's", () => {
  // Authored here: the first three items (1..3, `session_start` at 0).
  const authored: CompactWindow = { ...RESUMED_WINDOW, replacedFromSequence: 0, replacedToSequence: 3 };
  const placed = windowOnJournal(authored, RESUMED_JOURNAL);

  assert.equal(placed?.replacedFromSequence, 2);
  assert.equal(placed?.replacedToSequence, 4);
  assert.equal(placed?.windowId, "w1");
  assert.equal(placed?.summary, "SUMMARY-MARKER");
});

test("a window no journal item falls inside cannot be placed", () => {
  const authored: CompactWindow = { ...RESUMED_WINDOW, replacedFromSequence: 40, replacedToSequence: 50 };
  assert.equal(windowOnJournal(authored, RESUMED_JOURNAL), undefined);
  assert.equal(windowOnJournal(RESUMED_WINDOW, []), undefined);
});

// ---------------------------------------------------------------------------
// Through the loop: a resumed turn that compacts again.
// ---------------------------------------------------------------------------

/** One tool-calling stream then a stop, so the gap after the tool can compact. */
const SECOND_TURN_SCRIPT: ReadonlyArray<ReadonlyArray<ProviderEvent>> = [
  [
    { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: { text: "hi" } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ],
  [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
];

function portsOf(provider: ProviderPort, compaction: FakeCompaction): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools: createFakeTools([toolResult({ echo: "hi" }, TOOL_OUTPUT)], [
      echoBinding({ needsApproval: false }),
    ]),
    provider,
    compaction: compaction.wiring,
  };
}

/** A provider that replays a fixed script and records what each stream was sent. */
function scripted(script: ReadonlyArray<ReadonlyArray<ProviderEvent>>): ProviderPort {
  let index = 0;
  return {
    async *stream() {
      const events = script[index] ?? [];
      index += 1;
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** The item at `index`, asserted present: the turn's shape is known here. */
function itemAt(transcript: Transcript, index: number): TranscriptItem {
  const found = transcript[index];
  assert.notEqual(found, undefined);
  return found as TranscriptItem;
}

test("a resumed turn that compacts again starts after the window it resumed under", async () => {
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000, estimatedAfterCompactionTokens: 500 });
  const result = await runTurn(portsOf(scripted(SECOND_TURN_SCRIPT), compaction), {
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "next",
    resumedTranscript: RESUMED_ITEMS,
    resumedWindow: RESUMED_WINDOW,
    resumedRecords: RESUMED_JOURNAL,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 1);
  const draft = result.compactions[0];

  // The journal the port was asked to decide over must already carry the resumed
  // window; without it `compact` sees no previous window and every bound starts over.
  const decision = compaction.compactRequests[0]?.records ?? [];

  assert.equal(decision.filter((record) => record.type === "compact").length, 1);
  assert.equal(draft?.payload.windowId, "w2");
  // Three of the four resumed items sit inside the stored window, so the new one
  // begins at the fourth: `session_start` is 0 and the seven items of the turn
  // are 1..7, of which the window replaced 1..3.
  assert.equal(draft?.payload.replacedFromSequence, 4);

  // And once placed on the journal it reads back as the item that really follows
  // the stored window. The host rebases after writing the turn's own records, so
  // the journal here carries the three items this turn added.
  const written: ReadonlyArray<SessionRecord> = [
    ...RESUMED_JOURNAL,
    journalRecord(8, "transcript_item", itemAt(result.transcript, 4)),
    journalRecord(9, "transcript_item", itemAt(result.transcript, 5)),
    journalRecord(10, "transcript_item", itemAt(result.transcript, 6)),
  ];
  const placed = windowOnJournal(draft?.payload as CompactWindow, written);

  assert.equal(placed?.replacedFromSequence, 5);
  // Only the old prefix is replaced. The current assistant/tool exchange
  // stays outside the partial window, including its call at journal 9.
  assert.equal(placed?.replacedToSequence, 8);
});

test("a turn with no resumed window compacts from the start, as it always did", async () => {
  const compaction = createFakeCompaction({ estimatedPromptTokens: 9_000, estimatedAfterCompactionTokens: 500 });
  const result = await runTurn(portsOf(scripted(SECOND_TURN_SCRIPT), compaction), {
    sessionId: "s",
    turnId: "t",
    correlationId: "c",
    text: "go",
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 1);
  assert.equal(result.compactions[0]?.payload.replacedFromSequence, 0);
  assert.equal(result.compactions[0]?.payload.windowId, "w1");
});
