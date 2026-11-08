import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../ports/session.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { decodeFeedbackSource } from "./explanation-source.js";
import { readFeedbackExplanation } from "./explanation-reader.js";

const at = "2026-11-04T09:00:00.000Z";

function records(): SessionRecord[] {
  const envelope = (sequence: number, kind: string, payload: SessionRecord["payload"]): SessionRecord => ({
    formatVersion: "1", sequence, type: "envelope", sessionId: "reader-session", turnId: "t", at,
    payload: { envelope: { protocolVersion: "0.0", sequence, producerSequence: sequence, eventId: `evt-${sequence}`,
      producerId: "loop", timestamp: at, sessionId: "reader-session", turnId: "t", attemptId: "a", kind, payload } } });
  return [
    { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "reader-session", at,
      payload: { fingerprint: { schemaVersion: "1", workspaceId: "workspace", providerId: "fixture", model: "fixture", toolCatalogHash: "tools" } } },
    envelope(1, "tool_use", { toolCallId: "one", name: "read_file" }),
    envelope(2, "tool_use", { toolCallId: "two", name: "read_file" }),
    envelope(3, "observation", { toolCallId: "one", refused: true }),
    envelope(4, "tool_result", { toolCallId: "one", status: "failed" }),
    { formatVersion: "1", sequence: 5, type: "terminal", sessionId: "reader-session", turnId: "t", at, payload: { reason: "failed" } },
  ];
}

test("source keeps full registration population, first close, post-cohort pairing and unfinished units", async () => {
  const raw = records(), view = { records: raw, tornTail: true };
  const decoded = decodeFeedbackSource(view, "reader-session", 1);
  assert.ok(decoded.ok);
  assert.equal(decoded.source.observedThrough, 5);
  assert.equal(decoded.source.observedRequests, 2);
  assert.equal(decoded.source.bindings.length, 1);
  assert.equal(decoded.source.bindings[0]!.unit.status, "other");
  assert.equal(decoded.source.bindings[0]!.otherReason, "denied");
  const all = decodeFeedbackSource(view, "reader-session");
  assert.ok(all.ok);
  assert.equal(all.source.bindings[1]!.unit.status, "pending", "outer bookkeeping terminal is not a sensor close");
  const read = await readFeedbackExplanation({ enabled: () => true, sessionId: "reader-session", delta: 0.05,
    source: { readRecords: async () => ({ ok: true, view }) },
    board: { load: async () => ({ ok: false, reason: "board_unavailable", detail: "fixture" }) } });

  assert.ok(read.ok);
  assert.equal(read.reported.population, 2);
  assert.equal(read.reported.counts.pending, 1);
  assert.equal(read.legacy.status, "unavailable");
  assert.equal(read.questions[0]!.kind, "missing_qualifying_close");
  const duplicate = records();

  duplicate.push({ ...duplicate[1]!, sequence: 6, payload: { envelope: {
    protocolVersion: "0.0", producerId: "loop", producerSequence: 6, eventId: "new-address", sequence: 6,
    timestamp: at, sessionId: "reader-session", turnId: "t", attemptId: "a", kind: "tool_use",
    payload: { toolCallId: "one", name: "read_file" } } } });
  const refused = decodeFeedbackSource({ records: duplicate, tornTail: false }, "reader-session");

  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "source_duplicate_request");

  assert.equal(JSON.stringify(raw), JSON.stringify(records()), "analysis never changes its source view");
});

test("disabled and failed source reads do not manufacture empty cohorts or read the Board", async () => {
  let io = 0;
  const input = { enabled: () => false, sessionId: "reader-session", delta: 0.05,
    source: { readRecords: async () => {
      io++;
      return { ok: false as const, code: "checksum_mismatch" as const, detail: "fixture" };
    } },
    board: { load: async () => {
      io++;
      return { ok: true as const, state: emptyBoardState(), generation: 0 };
    } } };

  assert.deepEqual(await readFeedbackExplanation(input), { schemaVersion: 1, ok: false, reason: "feedback_read_disabled" });
  assert.equal(io, 0);
  assert.deepEqual(await readFeedbackExplanation({ ...input, enabled: () => true }),
    { schemaVersion: 1, ok: false, reason: "checksum_mismatch" });
  assert.equal(io, 1);
});
