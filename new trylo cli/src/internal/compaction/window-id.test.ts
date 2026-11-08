import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPACT_WINDOW_KEYS, type CompactWindow } from "../ports/compaction.js";
import { SESSION_FORMAT_VERSION, type SessionRecord } from "../ports/session.js";
import type { JsonObject } from "../protocol/envelope.js";
import { createCompactionService } from "./service.js";

const AT = "2026-11-08T00:00:00.000Z";

function record(sequence: number, type: SessionRecord["type"], payload: JsonObject): SessionRecord {
  return { formatVersion: SESSION_FORMAT_VERSION, sequence, type, payload, sessionId: "window-id", at: AT };
}

function recordsWith(ids: readonly string[]): readonly SessionRecord[] {
  const records: SessionRecord[] = [record(0, "session_start", {})];

  for (const [index, windowId] of ids.entries()) {
    const sequence = index * 2 + 1;
    records.push(record(sequence, "transcript_item", { kind: "user", sequence: index, text: "Observed work." }));
    records.push(record(sequence + 1, "compact", { windowId, replacedFromSequence: index === 0 ? 0 : sequence - 1,
      replacedToSequence: sequence, summary: "Earlier observations.", formatVersion: "1" }));
  }

  records.push(record(ids.length * 2 + 1, "transcript_item", { kind: "user", sequence: ids.length, text: "Continue." }));

  return records;
}

function compact(ids: readonly string[]): CompactWindow {
  const outcome = createCompactionService().compact({ records: recordsWith(ids), sessionId: "window-id", at: AT,
    summary: "Observed progress; continue the current task." });
  assert.equal(outcome.ok, true);
  assert.deepEqual(Object.keys(outcome.record.payload).sort(), [...COMPACT_WINDOW_KEYS].sort());
  assert.equal(outcome.record.payload.formatVersion, "1");
  return outcome.record.payload;
}

test("a last-window-only resume allocates above its canonical numeric high-water mark", () => {
  assert.equal(compact(["w2"]).windowId, "w3");
  assert.equal(compact(["w17"]).windowId, "w18");
});

test("full and resumed histories use the same canonical high-water mark", () => {
  assert.equal(compact(["w1", "w7", "w7"]).windowId, "w8");
  assert.equal(compact(["w7"]).windowId, "w8");
  assert.equal(compact(["w9", "w3"]).windowId, "w10");
});

test("legacy noncanonical window IDs remain readable and do not hide a canonical high-water mark", () => {
  assert.equal(compact(["historical-window"]).windowId, "w2");
  assert.equal(compact(["w0", "w01", "custom"]).windowId, "w4");
  assert.equal(compact(["w17", "w0018", "custom"]).windowId, "w18");
});

test("window numbering remains exact across the Number safe-integer boundary", () => {
  assert.equal(compact(["w9007199254740991"]).windowId, "w9007199254740992");
  assert.equal(compact(["w9007199254740992"]).windowId, "w9007199254740993");
});

test("uncompacted and consecutive canonical histories retain their IDs", () => {
  assert.equal(compact([]).windowId, "w1");
  assert.equal(compact(["w1", "w2"]).windowId, "w3");
});
