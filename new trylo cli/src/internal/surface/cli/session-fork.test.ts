import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "../../ports/session.js";
import { planFork } from "./session-fork.js";

/**
 * WP02.2 fork planner contract (red-first).
 *
 * The planner is pure: it decides *which* settled prefix of a parent journal
 * may start a child session, and refuses everything else. Copying unsettled
 * effects or half-received partials into a child would replay-or-lose real
 * side effects, so those inputs fail closed here instead of in the writer.
 */

function record(
  sequence: number,
  type: SessionRecord["type"],
  payload: SessionRecord["payload"],
  extra?: { turnId?: string },
): SessionRecord {
  return {
    formatVersion: "1",
    sequence,
    type,
    sessionId: "parent",
    ...(extra?.turnId === undefined ? {} : { turnId: extra.turnId }),
    at: "2026-10-04T00:00:00.000Z",
    payload,
  };
}

const FINGERPRINT = {
  schemaVersion: "1",
  providerId: "fixture",
  model: "m",
  toolCatalogHash: "h",
  workspaceId: "w",
};

function settledJournal(): Array<SessionRecord> {
  return [
    record(0, "session_start", { fingerprint: FINGERPRINT }),
    record(1, "transcript_item", { kind: "user", sequence: 0, text: "first" }),
    record(2, "transcript_item", { kind: "assistant_text", sequence: 1, blockId: "b1", text: "answer" }),
    record(3, "transcript_item", { kind: "user", sequence: 2, text: "second" }),
  ];
}

const BASE = {
  parentSessionId: "parent",
  childSessionId: "child",
  at: "2026-10-04T01:00:00.000Z",
};

test("a settled journal forks whole, without session_start and under the child id", () => {
  const planned = planFork({ records: settledJournal(), tornTail: false, snapshot: { mode: "settled-prefix" }, ...BASE });

  assert.equal(planned.ok, true);

  if (!planned.ok) return;

  assert.equal(planned.records.length, 3);

  for (const copied of planned.records) {
    assert.equal(copied.sessionId, "child");
  }

  assert.deepEqual(planned.provenance, {
    parentSessionId: "parent",
    parentLastSequence: 3,
    snapshot: "settled-prefix",
    at: BASE.at,
    droppedPending: 0,
    droppedPartials: 0,
    copiedRecords: 3,
  });
});

test("an unsettled effect refuses the default fork instead of crossing into the child", () => {
  const records = [
    ...settledJournal(),
    record(4, "effect_issued", { key: "tool:write" }, { turnId: "t2" }),
  ];
  const planned = planFork({ records, tornTail: false, snapshot: { mode: "settled-prefix" }, ...BASE });

  assert.equal(planned.ok, false);

  if (planned.ok) return;

  assert.equal(planned.code, "unsettled_effects");
});

test("stream debris does not refuse the default fork: it is dropped and counted", () => {
  const records = [
    ...settledJournal(),
    record(4, "stream_partial", { kind: "assistant_text", blockId: "p1", text: "half" }),
  ];
  const planned = planFork({ records, tornTail: false, snapshot: { mode: "settled-prefix" }, ...BASE });

  assert.equal(planned.ok, true);

  if (!planned.ok) return;

  assert.equal(planned.records.length, 3);
  assert.equal(planned.provenance.droppedPartials, 1);
  assert.equal(planned.provenance.droppedPending, 0);
});

test("--interrupted drops the unfinished suffix and records the drop", () => {
  const records = [
    ...settledJournal(),
    record(4, "effect_issued", { key: "tool:write" }, { turnId: "t2" }),
    record(5, "stream_partial", { kind: "assistant_text", blockId: "p1", text: "half" }),
  ];
  const planned = planFork({ records, tornTail: false, snapshot: { mode: "interrupted" }, ...BASE });

  assert.equal(planned.ok, true);

  if (!planned.ok) return;

  assert.equal(planned.records.length, 3);
  assert.equal(planned.provenance.droppedPending, 1);
  assert.equal(planned.provenance.droppedPartials, 1);
  assert.equal(planned.provenance.snapshot, "interrupted");
});

test("a settled effect pair crosses the fork: only the unknown is dropped", () => {
  const records = [
    ...settledJournal(),
    record(4, "effect_issued", { key: "tool:a" }, { turnId: "t2" }),
    record(5, "effect_committed", { key: "tool:a" }, { turnId: "t2" }),
  ];
  const planned = planFork({ records, tornTail: false, snapshot: { mode: "interrupted" }, ...BASE });

  assert.equal(planned.ok, true);

  if (!planned.ok) return;

  assert.equal(planned.records.length, 5);
  assert.equal(planned.provenance.droppedPending, 0);
});

test("before-user-message cuts strictly before the nth user message", () => {
  const planned = planFork({
    records: settledJournal(),
    tornTail: false,
    snapshot: { mode: "before-user-message", n: 2 },
    ...BASE,
  });

  assert.equal(planned.ok, true);

  if (!planned.ok) return;

  assert.equal(planned.records.length, 2);
  assert.equal(planned.provenance.snapshot, "before-user-message");
  assert.equal(planned.provenance.beforeUserMessage, 2);
});

test("an out-of-range message index refuses with the usable range", () => {
  const planned = planFork({
    records: settledJournal(),
    tornTail: false,
    snapshot: { mode: "before-user-message", n: 9 },
    ...BASE,
  });

  assert.equal(planned.ok, false);

  if (planned.ok) return;

  assert.equal(planned.code, "message_not_found");
  assert.match(planned.detail, /1-2/);
});

test("a torn tail refuses the fork: the parent moved mid-read", () => {
  const planned = planFork({ records: settledJournal(), tornTail: true, snapshot: { mode: "settled-prefix" }, ...BASE });
  assert.equal(planned.ok, false);
  if (planned.ok) return;
  assert.equal(planned.code, "torn_tail");
});

test("a journal without session_start is not a fork source", () => {
  const planned = planFork({
    records: [record(0, "transcript_item", { kind: "user", sequence: 0, text: "orphan" })],
    tornTail: false,
    snapshot: { mode: "settled-prefix" },
    ...BASE,
  });

  assert.equal(planned.ok, false);

  if (planned.ok) return;

  assert.equal(planned.code, "parent_unreadable");
});
