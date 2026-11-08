import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord, SessionRecordView } from "../../ports/session.js";
import { decodeJournal, encodeLine, recoverSessionRecordView } from "./ndjson.js";

const at = "2026-11-03T20:00:00.000Z";
const start: SessionRecord = { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "snapshot-session", at,
  payload: { fingerprint: { schemaVersion: "1", providerId: "fixture", model: "fixture", toolCatalogHash: "tools", workspaceId: "workspace" } } };
const item = (sequence: number, type: SessionRecord["type"], turnId: string, payload: SessionRecord["payload"]): SessionRecord =>
  ({ formatVersion: "1", sequence, type, sessionId: "snapshot-session", turnId, at, payload });
const raw = (records: readonly SessionRecord[]) => records.map(record => encodeLine(record.sequence, record)).join("");

function validated(records: readonly SessionRecord[]): SessionRecordView {
  const result = decodeJournal(raw(records));
  assert.ok(result.ok);
  return { records: result.records, tornTail: result.tornTail };
}

test("terminal identity and recovered content stay in one validated snapshot after a later journal append", () => {
  const original = [start,
    item(1, "transcript_item", "first", { sequence: 0, kind: "user", text: "Original task" }),
    item(2, "transcript_item", "first", { sequence: 1, kind: "assistant_text", blockId: "first-answer", text: "Original result" }),
    item(3, "terminal", "first", { reason: "completed", finishReason: "stop" }),
  ];
  const snapshot = validated(original);
  const later = validated([...original,
    item(4, "transcript_item", "later", { sequence: 2, kind: "user", text: "A later correction" }),
    item(5, "terminal", "later", { reason: "failed", finishReason: "error" }),
  ]);
  const recovered = recoverSessionRecordView(snapshot), appended = recoverSessionRecordView(later);

  assert.ok(recovered.ok && appended.ok);

  if (!recovered.ok || !appended.ok) throw new Error("snapshot recovery failed");

  assert.equal(snapshot.records.filter(record => record.type === "terminal").at(-1)?.turnId, "first");
  assert.deepEqual(recovered.session.transcript.map(entry => entry.sequence), [0, 1]);
  assert.doesNotMatch(JSON.stringify(recovered.session.transcript), /later correction/);
  assert.equal(later.records.filter(record => record.type === "terminal").at(-1)?.turnId, "later");
  assert.match(JSON.stringify(appended.session.transcript), /later correction/);
  assert.deepEqual(recoverSessionRecordView(snapshot), recovered, "a later append cannot change an already captured record view");
});

test("snapshot recovery keeps canonical unanswered-call cleanup and payload validation", () => {
  const snapshot = validated([start,
    item(1, "transcript_item", "turn", { sequence: 0, kind: "tool_call", toolCallId: "unanswered", name: "read_file", arguments: { path: "unknown.txt" } }),
    item(2, "transcript_item", "turn", { sequence: 1, kind: "tool_call", toolCallId: "settled", name: "read_file", arguments: { path: "known.txt" } }),
    item(3, "transcript_item", "turn", { sequence: 2, kind: "tool_result", toolCallId: "settled", name: "read_file", outcome: "failed", output: "Observed failure", truncated: false }),
    item(4, "terminal", "turn", { reason: "failed", finishReason: "error" }),
  ]);
  const result = recoverSessionRecordView(snapshot);
  assert.ok(result.ok);
  assert.deepEqual(result.session.transcript.map(entry => entry.sequence), [1, 2]);
  assert.equal(snapshot.records.length, 5, "read cleanup never mutates the validated journal records");
  const invalid = recoverSessionRecordView(validated([start,
    item(1, "transcript_item", "turn", { kind: "user", text: "Missing canonical sequence" }),
  ]));

  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "mid_file_corruption");
});
