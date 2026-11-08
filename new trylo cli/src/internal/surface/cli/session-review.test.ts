import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { locateTurnByUserMessage, previewRollback, reviewSession } from "./session-review.js";

/**
 * WP11.3 (C38): per-turn review from the durable journal.
 *
 * Red evidence: new module (import fails pre-WP11). Behavioural red was
 * shown by grouping envelopes under `record.turnId` only and ignoring the
 * nested envelope's own `turnId`: `envelope turn ids win over record turn ids`
 * goes red.
 */

const AT = "2026-10-05T00:00:00.000Z";

function record(partial: Partial<SessionRecord> & { type: SessionRecord["type"] }, sequence: number): SessionRecord {
  return {
    formatVersion: "1",
    sequence,
    sessionId: "s1",
    at: AT,
    payload: {},
    ...partial,
  } as SessionRecord;
}

function user(turnId: string, text: string, sequence: number): SessionRecord {
  return record({ type: "transcript_item", turnId, payload: { kind: "user", sequence: 0, text } }, sequence);
}

function toolResult(turnId: string, outcome: string, sequence: number): SessionRecord {
  return record(
    {
      type: "transcript_item",
      turnId,
      payload: { kind: "tool_result", sequence: 1, toolCallId: "c1", name: "apply_patch", output: "ok", truncated: false, outcome },
    },
    sequence,
  );
}

function envelope(turnId: string | undefined, kind: string, payload: JsonObject, sequence: number): SessionRecord {
  return record(
    {
      type: "envelope",
      ...(turnId === undefined ? {} : { turnId }),
      payload: { envelope: { kind, payload, ...(turnId === undefined ? {} : { turnId }) } },
    },
    sequence,
  );
}

test("turns group transcript, files, checkpoints and problems", () => {
  const records = [
    record({ type: "session_start", payload: {} }, 0),
    user("t1", "fix the bug", 1),
    toolResult("t1", "failed", 2),
    envelope("t1", "file_write", { path: "a.ts", mode: "patched", bytes: 12 }, 3),
    envelope("t1", "observation", { component: "checkpoint", status: "ok", checkpointId: "cp-1" }, 4),
    record({ type: "effect_unknown", turnId: "t1", payload: { key: "tool:c9" } }, 5),
    user("t2", "next", 6),
  ];
  const review = reviewSession(records);

  assert.equal(review.turns.length, 2);
  assert.deepEqual(review.prologueSequences, [0]);
  const first = review.turns[0];

  assert.equal(first?.turnId, "t1");
  assert.deepEqual(first?.userTexts, ["fix the bug"]);
  assert.deepEqual(first?.fileWrites, [{ path: "a.ts", mode: "patched", bytes: 12 }]);
  assert.deepEqual(first?.checkpointIds, ["cp-1"]);
  assert.equal(first?.toolCalls.length, 1);
  assert.equal(first?.toolCalls[0]?.outcome, "failed");
  assert.ok((first?.problems.length ?? 0) >= 2);
  assert.equal(review.turns[1]?.turnId, "t2");
});

test("envelope turn ids win over record turn ids", () => {
  const records = [
    user("t1", "hi", 0),
    envelope("t2", "file_write", { path: "b.ts", mode: "created", bytes: 3 }, 1),
  ];
  const review = reviewSession(records);
  const second = review.turns.find((turn) => turn.turnId === "t2");

  assert.deepEqual(second?.fileWrites, [{ path: "b.ts", mode: "created", bytes: 3 }]);
});

test("malformed payloads are classified out, never guessed", () => {
  const records = [
    record({ type: "transcript_item", turnId: "t1", payload: { kind: "user" } }, 0),
    envelope("t1", "file_write", { path: "b.ts" }, 1),
    envelope("t1", "observation", { component: "checkpoint", status: "failed", code: "x" }, 2),
  ];
  const review = reviewSession(records);

  assert.equal(review.turns.length, 1);
  assert.deepEqual(review.turns[0]?.userTexts, []);
  assert.deepEqual(review.turns[0]?.fileWrites, []);
  assert.deepEqual(review.turns[0]?.checkpointIds, []);
});

test("rollback preview validates the horizon without touching the journal", () => {
  const records = [record({ type: "session_start", payload: {} }, 0), user("t1", "hi", 1), user("t2", "yo", 2)];
  const preview = previewRollback(records, 1);

  assert.equal(preview.ok, true);

  if (preview.ok) {
    assert.equal(preview.horizonSequence, 1);
    assert.equal(preview.journalUntouched, true);
    assert.equal(preview.visibleItems + preview.hiddenItems, 2);
  }

  assert.equal(previewRollback(records, 99).ok, false);
  assert.equal(previewRollback(records, -1).ok, false);
});

test("turns locate by user message number", () => {
  const records = [user("t1", "first", 0), user("t1", "second", 1), user("t9", "third", 2)];
  const located = locateTurnByUserMessage(records, 3);

  assert.equal(located.ok, true);

  if (located.ok) {
    assert.equal(located.turnId, "t9");
  }

  assert.equal(locateTurnByUserMessage(records, 9).ok, false);
  assert.equal(locateTurnByUserMessage(records, 0).ok, false);
});

test("F7 the cap keeps the newest turns and reports the hidden oldest", () => {
  const records: SessionRecord[] = [];

  for (let index = 0; index < 205; index += 1) {
    records.push(user(`t${index}`, `message ${index}`, index));
  }

  const review = reviewSession(records);

  assert.equal(review.turns.length, 200);
  assert.equal(review.truncatedTurns, 5);
  assert.equal(review.turns[0]?.turnId, "t5");
  assert.equal(review.turns[review.turns.length - 1]?.turnId, "t204");
});
