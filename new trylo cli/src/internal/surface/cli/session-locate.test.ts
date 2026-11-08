import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "../../ports/session.js";
import { locateUserMessage } from "./session-locate.js";

/**
 * WP11/F9: the shared user-message locator.
 *
 * Red evidence: new module (import fails pre-remedy). Behavioural red was
 * shown by skipping malformed payloads instead of failing: `corrupt
 * payloads fail the location` goes red — the location selects rollback and
 * fork points, so guessing a neighbour is the dangerous direction.
 */

const AT = "2026-10-05T00:00:00.000Z";

function user(turnId: string, sequence: number): SessionRecord {
  return {
    formatVersion: "1",
    sequence,
    type: "transcript_item",
    sessionId: "s1",
    turnId,
    at: AT,
    payload: { kind: "user", sequence: 0, text: "hi" },
  } as SessionRecord;
}

test("messages number the way a person counts", () => {
  const records = [user("t1", 0), user("t1", 1), user("t9", 2)];

  assert.deepEqual(locateUserMessage(records, 1), {
    ok: true,
    turnId: "t1",
    userMessageIndex: 1,
    firstSequence: 0,
  });
  assert.deepEqual(locateUserMessage(records, 3), {
    ok: true,
    turnId: "t9",
    userMessageIndex: 3,
    firstSequence: 2,
  });
});

test("out-of-range and non-positive indexes are refused with fork-identical wording", () => {
  const records = [user("t1", 0)];
  const out = locateUserMessage(records, 9);

  assert.equal(out.ok, false);

  if (!out.ok) {
    assert.equal(out.code, "message_not_found");
    assert.equal(out.detail, "user message 9 out of range (this session has 1, numbered 1-1)");
  }

  assert.equal(locateUserMessage(records, 0).ok, false);
});

test("corrupt payloads fail the location instead of skipping a neighbour", () => {
  const records: SessionRecord[] = [
    user("t1", 0),
    {
      formatVersion: "1",
      sequence: 1,
      type: "transcript_item",
      sessionId: "s1",
      turnId: "t1",
      at: AT,
      payload: { kind: "user" },
    } as SessionRecord,
  ];
  const located = locateUserMessage(records, 2);

  assert.equal(located.ok, false);

  if (!located.ok) {
    assert.equal(located.code, "parent_unreadable");
    assert.match(located.detail, /sequence 1/);
  }
});
