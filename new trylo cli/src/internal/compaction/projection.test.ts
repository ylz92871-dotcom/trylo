import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import {
  COMPACTION_FORMAT_VERSION,
  type CompactWindow,
} from "../ports/compaction.js";
import { SESSION_FORMAT_VERSION, type SessionRecord } from "../ports/session.js";
import { listTranscript, projectForPrompt } from "./projection.js";
import { createCompactionService } from "./service.js";

/**
 * Read-time filtering, window validation and the compact draft itself.
 *
 * The load-bearing assertion is that one journal yields two different results:
 * `listTranscript` is the record of what happened, `projectForPrompt` is what
 * the model may still see. If they ever agree after a compaction, the filter did
 * not run and every cheap-looking context saving was imaginary.
 */

const service = createCompactionService();

function record(sequence: number, type: SessionRecord["type"], payload: JsonObject = {}): SessionRecord {
  return {
    formatVersion: SESSION_FORMAT_VERSION,
    sequence,
    type,
    sessionId: "s1",
    at: `2026-09-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload,
  };
}

function userItem(sequence: number, text: string): SessionRecord {
  return record(sequence, "transcript_item", { kind: "user", sequence: sequence * 100, text });
}

function window(sequence: number, payload: Partial<CompactWindow> = {}): SessionRecord {
  return record(sequence, "compact", {
    windowId: "w1",
    replacedFromSequence: 1,
    replacedToSequence: 2,
    summary: "earlier turn summarised",
    formatVersion: COMPACTION_FORMAT_VERSION,
    ...payload,
  });
}

/** Used for shapes an honest caller cannot produce, without casting them away. */
function rawWindow(sequence: number, payload: JsonObject): SessionRecord {
  return record(sequence, "compact", payload);
}

/** session_start, four messages, then whatever the caller appends. */
function journalWithFourItems(tail: readonly SessionRecord[] = []): readonly SessionRecord[] {
  return [
    record(0, "session_start"),
    userItem(1, "first"),
    userItem(2, "second"),
    userItem(3, "third"),
    userItem(4, "fourth"),
    ...tail,
  ];
}

test("without any window the prompt view is the whole transcript", () => {
  const projected = service.projectForPrompt({ records: journalWithFourItems() });
  assert.equal(projected.ok, true);
  if (projected.ok) {
    assert.equal(projected.view.items.length, 4);
    assert.equal(projected.view.window, undefined);
  }
});

test("a window removes the replaced segment from the prompt but not from the record", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    userItem(2, "second"),
    window(3, { replacedFromSequence: 1, replacedToSequence: 2, summary: "first two" }),
    userItem(4, "third"),
  ];
  const projected = service.projectForPrompt({ records });

  assert.equal(projected.ok, true);

  if (projected.ok) {
    // The model sees one live message plus the summary; the journal still knows
    // about all three. This inequality is the compaction contract.
    assert.equal(projected.view.items.length, 1);
    assert.equal(listTranscript(records).length, 3);
    assert.equal(projected.view.window?.summary, "first two");
  }
});

test("two consecutive windows leave only the newest one standing", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    userItem(2, "second"),
    window(3, { windowId: "w1", replacedFromSequence: 1, replacedToSequence: 2, summary: "first two" }),
    userItem(4, "third"),
    userItem(5, "fourth"),
    window(6, { windowId: "w2", replacedFromSequence: 3, replacedToSequence: 5, summary: "third and fourth" }),
    userItem(7, "fifth"),
  ];
  const projected = service.projectForPrompt({ records });

  assert.equal(projected.ok, true);

  if (projected.ok) {
    assert.equal(projected.view.window?.windowId, "w2");
    assert.equal(projected.view.items.length, 1);
    assert.equal(projected.view.items[0]?.sequence, 700);
  }
});

test("a prompt view after a reload matches the view taken before it", () => {
  // Reload is just re-reading the same bytes, so the property worth pinning is
  // that projection depends on nothing but the journal.
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    window(2, { replacedFromSequence: 1, replacedToSequence: 1, summary: "first" }),
    userItem(3, "second"),
  ];
  const before = service.projectForPrompt({ records });
  const after = service.projectForPrompt({ records });

  assert.deepEqual(before, after);
});

test("a compact record with an extra key is rejected rather than partially read", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    rawWindow(2, {
      windowId: "w1",
      replacedFromSequence: 1,
      replacedToSequence: 1,
      summary: "first",
      formatVersion: COMPACTION_FORMAT_VERSION,
      extraFutureField: "value",
    }),
  ];
  const projected = service.projectForPrompt({ records });

  assert.equal(projected.ok, false);

  if (!projected.ok) {
    assert.equal(projected.code, "compact_payload_malformed");
  }
});

test("a compact record with a missing key is rejected", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    record(2, "compact", { windowId: "w1", summary: "only half a window" }),
  ];
  const projected = service.projectForPrompt({ records });

  assert.equal(projected.ok, false);

  if (!projected.ok) {
    assert.equal(projected.code, "compact_payload_malformed");
  }
});

test("an unknown compact format version fails the whole projection", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    window(2, { replacedToSequence: 1, formatVersion: "99" }),
  ];
  const projected = service.projectForPrompt({ records });

  assert.equal(projected.ok, false);

  if (!projected.ok) {
    assert.equal(projected.code, "compact_format_unknown");
  }
});

test("overlapping windows are refused instead of adjudicated", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    userItem(2, "second"),
    window(3, { windowId: "w1", replacedFromSequence: 1, replacedToSequence: 2, summary: "two" }),
    userItem(4, "third"),
    window(5, { windowId: "w2", replacedFromSequence: 2, replacedToSequence: 4, summary: "overlap" }),
  ];
  const projected = service.projectForPrompt({ records });

  assert.equal(projected.ok, false);

  if (!projected.ok) {
    assert.equal(projected.code, "compact_window_not_monotonic");
  }
});

test("a rolled-back horizon hides transcript items after it and nothing else changes", () => {
  const records = journalWithFourItems();
  const rollback = service.rollbackTranscript({ records, sequence: 2 });

  assert.equal(rollback.ok, true);

  if (rollback.ok) {
    const projected = service.projectForPrompt({ records, horizonSequence: rollback.horizonSequence });

    assert.equal(projected.ok, true);

    if (projected.ok) {
      assert.deepEqual(
        projected.view.items.map((item) => item.sequence),
        [100, 200],
      );
      // The full record is untouched: a horizon is a way of looking, not a delete.
      assert.equal(listTranscript(records).length, 4);
    }
  }
});

test("rolling back to the newest record reports that there is nothing to roll back", () => {
  const records = journalWithFourItems();
  const rollback = service.rollbackTranscript({ records, sequence: 4 });
  assert.equal(rollback.ok, false);
  if (!rollback.ok) {
    assert.equal(rollback.code, "nothing_to_roll_back");
  }
});

test("rolling back to an unknown sequence is refused", () => {
  const records = journalWithFourItems();
  const rollback = service.rollbackTranscript({ records, sequence: 99 });
  assert.equal(rollback.ok, false);
  if (!rollback.ok) {
    assert.equal(rollback.code, "nothing_to_roll_back");
  }
});

test("rolling back below zero is refused", () => {
  const rollback = service.rollbackTranscript({ records: journalWithFourItems(), sequence: -1 });
  assert.equal(rollback.ok, false);
  if (!rollback.ok) {
    assert.equal(rollback.code, "sequence_unknown");
  }
});

test("compact builds the first window over everything written so far", () => {
  const outcome = service.compact({
    records: journalWithFourItems(),
    sessionId: "s1",
    at: "2026-09-14T00:01:00.000Z",
    summary: "four messages, nothing resolved yet",
  });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.record.type, "compact");
    assert.deepEqual(outcome.record.payload, {
      windowId: "w1",
      replacedFromSequence: 0,
      replacedToSequence: 4,
      summary: "four messages, nothing resolved yet",
      formatVersion: COMPACTION_FORMAT_VERSION,
    });
  }
});

test("a second compact starts where the first one ended", () => {
  const first = service.compact({
    records: journalWithFourItems(),
    sessionId: "s1",
    at: "2026-09-14T00:01:00.000Z",
    summary: "first four",
  });

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  const afterFirst: readonly SessionRecord[] = [
    ...journalWithFourItems().slice(0, 5),
    record(5, "compact", first.record.payload),
    userItem(6, "fifth"),
  ];
  const second = service.compact({
    records: afterFirst,
    sessionId: "s1",
    at: "2026-09-14T00:02:00.000Z",
    summary: "then a fifth",
  });

  assert.equal(second.ok, true);

  if (second.ok) {
    assert.equal(second.record.payload.windowId, "w2");
    assert.equal(second.record.payload.replacedFromSequence, 5);
    assert.equal(second.record.payload.replacedToSequence, 6);
  }
});

test("compact refuses a summary that would leak", () => {
  const outcome = service.compact({
    records: journalWithFourItems(),
    sessionId: "s1",
    at: "2026-09-14T00:01:00.000Z",
    summary: "the user pasted api_key=sk-example1234567 into the prompt",
  });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "summary_unsafe");
  }
});

test("compact refuses when there is nothing left to summarize", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    window(2, { replacedFromSequence: 1, replacedToSequence: 1, summary: "first" }),
  ];
  const outcome = service.compact({ records, sessionId: "s1", at: "now", summary: "nothing new" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "nothing_to_compact");
  }
});

test("a horizon suppresses compacting over transcript cut out of the prompt view", () => {
  const records = journalWithFourItems();
  const rollback = service.rollbackTranscript({ records, sequence: 2 });

  assert.equal(rollback.ok, true);

  if (!rollback.ok) {
    return;
  }

  const outcome = service.compact({
    records,
    sessionId: "s1",
    at: "2026-09-14T00:01:00.000Z",
    summary: "only the visible prefix",
    horizonSequence: rollback.horizonSequence,
  });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.record.payload.replacedToSequence, 2);
  }
});

test("compacting under a horizon that leaves nothing visible is refused", () => {
  const records = [
    record(0, "session_start"),
    userItem(1, "first"),
    userItem(2, "second"),
  ];
  const outcome = service.compact({
    records,
    sessionId: "s1",
    at: "2026-09-14T00:01:00.000Z",
    summary: "nothing visible",
    horizonSequence: 0,
  });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "nothing_to_compact");
  }
});

test("projectForPrompt agrees with the service regardless of entry point", () => {
  const records = journalWithFourItems([
    record(5, "compact", {
      windowId: "w1",
      replacedFromSequence: 1,
      replacedToSequence: 4,
      summary: "all four",
      formatVersion: COMPACTION_FORMAT_VERSION,
    }),
  ]);
  assert.deepEqual(projectForPrompt({ records }), service.projectForPrompt({ records }));
});

test("a foreign transcript_item payload fails the prompt view instead of being guessed", () => {
  // Same rule as the session store's recovery: a checksum-valid line whose
  // payload shape no writer of this format would produce. The model's view
  // must fail closed, never project a guess.
  const records = [record(1, "transcript_item", { kind: "user" })];
  const outcome = projectForPrompt({ records });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "compact_payload_malformed");
    assert.match(outcome.detail, /sequence 1/);
  }
});

test("listTranscript classifies a foreign payload out rather than showing a guess", () => {
  const records = [
    record(1, "transcript_item", { kind: "user", sequence: 100, text: "real" }),
    record(2, "transcript_item", { kind: "user" }),
  ];
  const items = listTranscript(records);

  assert.equal(items.length, 1);
  const first = items[0];

  assert.equal(first?.kind, "user");

  if (first?.kind === "user") {
    assert.equal(first.text, "real");
  }
});
