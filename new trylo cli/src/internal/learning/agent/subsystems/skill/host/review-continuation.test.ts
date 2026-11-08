import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../../../ports/session.js";
import { decodeJournal, encodeLine } from "../../../../../adapters/session-store/ndjson.js";
import { skillAcceptedReviewCheckpoint } from "./review-continuation.js";

test("continuation reuses accepted receipts but never rejected calls, reasoning or an unreconciled suffix effect", () => {
  const sessionId = "review-session", turnId = "review-turn";
  const records: SessionRecord[] = [];
  const add = (type: SessionRecord["type"], payload: SessionRecord["payload"]) => records.push({ formatVersion: "1",
    sequence: records.length, type, sessionId, turnId, at: "2026-11-09T00:00:00.000Z", payload });
  add("session_start", { fingerprint: { schemaVersion: "1", providerId: "fixture", model: "fixture",
    toolCatalogHash: "tools", workspaceId: "workspace" } });
  add("transcript_item", { sequence: 0, kind: "user", text: "Review the observed task" });
  add("transcript_item", { sequence: 1, kind: "assistant_reasoning", blockId: "private", text: "Private reasoning", redacted: false });
  add("transcript_item", { sequence: 2, kind: "tool_call", toolCallId: "accepted", name: "skill_view", arguments: { name: "example" } });
  add("effect_issued", { key: "tool:accepted" });
  add("transcript_item", { sequence: 3, kind: "tool_result", toolCallId: "accepted", name: "skill_view",
    output: "Previously observed skill", outcome: "succeeded", truncated: false });
  add("effect_committed", { key: "tool:accepted", outcome: "succeeded" });
  add("envelope", { envelope: { kind: "stream_end", sessionId, turnId, payload: { reason: "tool_calls", requiresFollowUp: true } } });
  add("transcript_item", { sequence: 4, kind: "tool_call", toolCallId: "rejected", name: "skill_propose", arguments: { name: "example" } });
  add("transcript_item", { sequence: 5, kind: "tool_result", toolCallId: "rejected", name: "skill_propose",
    output: "stream_not_accepted", outcome: "failed", truncated: false });
  add("terminal", { reason: "failed", finishReason: "tool_calls" });
  const journal = decodeJournal(records.map(record => encodeLine(record.sequence, record)).join(""));
  assert.ok(journal.ok);
  const original = JSON.stringify(journal.records);
  const checkpoint = skillAcceptedReviewCheckpoint(journal.records, sessionId, turnId);
  assert.deepEqual(checkpoint.transcript.map(item => item.kind), ["tool_call", "tool_result"]);
  assert.deepEqual(checkpoint.excludedSuffixCallIds, ["rejected"]);
  assert.doesNotMatch(JSON.stringify(checkpoint.transcript), /Private reasoning|skill_propose|stream_not_accepted/);
  assert.equal(JSON.stringify(journal.records), original);
  const earlyFinish = [...records];
  const finish = earlyFinish.splice(7, 1)[0];
  assert.ok(finish);
  earlyFinish.splice(4, 0, finish);
  const ordered = earlyFinish.map((record, sequence) => ({ ...record, sequence }));
  assert.deepEqual(skillAcceptedReviewCheckpoint(ordered, sessionId, turnId).transcript, checkpoint.transcript,
    "the same accepted response may persist its confirmed tool effects after stream_end");
  assert.throws(() => skillAcceptedReviewCheckpoint(journal.records.map(record => record.type === "effect_committed"
    ? { ...record, type: "effect_failed" as const, payload: { key: "tool:accepted" } } : record), sessionId, turnId), /checkpoint_unsettled|tool_unconfirmed/);
  add("effect_issued", { key: "tool:rejected" });
  assert.throws(() => skillAcceptedReviewCheckpoint(records, sessionId, turnId), /reconciliation_required/);
});
