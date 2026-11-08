import assert from "node:assert/strict";
import test from "node:test";
import type { PromptInputCheckpoint } from "../ports/prompt-input.js";
import type { SessionRecord } from "../ports/session.js";
import type { JsonObject } from "../protocol/envelope.js";
import { recoverPromptInputCheckpoint } from "../loop/prompt-input-records.js";
import { sessionPayload } from "../surface/cli/session-payload.js";

const hash = "a".repeat(64);
const checkpoint: PromptInputCheckpoint = { version: 1, sessionId: "s", turnId: "t", attemptId: "a", streamIndex: 1,
  basis: { version: 1, model: "synthetic", input: { kind: "complete_prompt", source: "provider_complete_input", tokens: 0 },
    inputBindingDigest: hash, settingsDigest: hash, toolDigest: hash, windowDigest: hash, nativeMode: "none",
    nonSystem: { count: 1, digest: hash }, systems: { count: 0, digest: hash, nativeDigest: hash } } };

function row(type: SessionRecord["type"], turnId: string, payload: JsonObject): SessionRecord {
  return { formatVersion: "1", sequence: 0, sessionId: "s", turnId, at: "now", type, payload };
}

function stream(turnId = "t", streamIndex = 1, value: unknown = checkpoint): SessionRecord[] {
  const event = (kind: string) => ({ kind, sessionId: "s", turnId, attemptId: "a", payload: { reason: "stop" } });
  return [row("envelope", turnId, { envelope: event("api_call") }), row("envelope", turnId, {
    envelope: event("stream_end"), ...(value === null ? {} : { promptInputCheckpoint: { ...sessionPayload(value), turnId, streamIndex } }),
  })];
}

const start = row("turn_start", "t", {});

test("a committed zero-valued complete checkpoint restores with a defensive fixed-size copy", () => {
  const records = [start, ...stream()];
  const result = recoverPromptInputCheckpoint(records, "s");

  assert.equal(result.kind, "available");

  if (result.kind === "available") {
    assert.deepEqual(result.checkpoint, checkpoint);
    assert.notEqual(result.checkpoint, records[2]?.payload.promptInputCheckpoint);
  }
});

test("old journals and later missing usage preserve absence or the last proven request", () => {
  assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream("t", 1, null)], "s"), { kind: "absent" });
  const result = recoverPromptInputCheckpoint([start, ...stream(), ...stream("t", 2, null)], "s");
  assert.equal(result.kind, "available");
  if (result.kind === "available") assert.equal(result.checkpoint.streamIndex, 1);
});

for (const [label, override] of [
  ["session", { sessionId: "foreign" }], ["attempt", { attemptId: "foreign" }],
] as const) test(`foreign ${label} metadata is unavailable instead of restored`, () => {
  assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream("t", 1, { ...checkpoint, ...override })], "s"),
    { kind: "unavailable", reason: "checkpoint_binding_mismatch" });
});

test("a checkpoint needs the same canonical API call count and a real provider completion", () => {
  assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream("t", 2)], "s"),
    { kind: "unavailable", reason: "checkpoint_stream_mismatch" });
  const records = [start, ...stream()];
  records[2] = row("envelope", "t", { envelope: { kind: "stream_end", sessionId: "s", turnId: "t", attemptId: "a",
    payload: { reason: "", requiresFollowUp: true } }, promptInputCheckpoint: sessionPayload(checkpoint) });
  assert.deepEqual(recoverPromptInputCheckpoint(records, "s"), { kind: "unavailable", reason: "checkpoint_completion_missing" });
});

test("a latest damaged extension cannot silently borrow an older valid checkpoint", () => {
  const corrupt = { ...checkpoint, version: 9 };
  assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream(), ...stream("t", 2, corrupt)], "s"),
    { kind: "unavailable", reason: "invalid_checkpoint" });
  const recovered = recoverPromptInputCheckpoint([start, ...stream(), ...stream("t", 2, corrupt), ...stream("t", 3)], "s");
  assert.equal(recovered.kind, "available");
  if (recovered.kind === "available") assert.equal(recovered.checkpoint.streamIndex, 3);
});

test("stream ordinals are scoped to their persisted turn and do not borrow another turn's start", () => {
  const second = "later", result = recoverPromptInputCheckpoint([start, ...stream(), row("turn_start", second, {}), ...stream(second)], "s");
  assert.equal(result.kind, "available");
  if (result.kind === "available") {
    assert.equal(result.checkpoint.turnId, second);
    assert.equal(result.checkpoint.streamIndex, 1);
  }
  assert.deepEqual(recoverPromptInputCheckpoint(stream(second), "s"), { kind: "unavailable", reason: "checkpoint_binding_mismatch" });
});

test("non-completion placement, repeated completion, and unknown fields never become valid basis", () => {
  assert.deepEqual(recoverPromptInputCheckpoint([start, row("transcript_item", "t", { promptInputCheckpoint: sessionPayload(checkpoint) })], "s"),
    { kind: "unavailable", reason: "checkpoint_binding_mismatch" });
  const completed = stream();

  assert.deepEqual(recoverPromptInputCheckpoint([start, ...completed, completed[1]!], "s"),
    { kind: "unavailable", reason: "checkpoint_completion_missing" });
  assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream("t", 1, { ...checkpoint, invented: true })], "s"),
    { kind: "unavailable", reason: "invalid_checkpoint" });
});

test("checksum-valid external payload shapes remain typed unavailable without throwing", () => {
  for (const payload of [null, [], "not-an-object"]) {
    const malformed: SessionRecord = JSON.parse(JSON.stringify({ ...start, type: "envelope", payload }));
    assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream(), malformed], "s"),
      { kind: "unavailable", reason: "invalid_checkpoint" });
  }

  const foreign = stream().map(record => ({ ...record, sessionId: "other-session" }));

  assert.deepEqual(recoverPromptInputCheckpoint([start, ...stream(), ...foreign], "s"),
    { kind: "unavailable", reason: "checkpoint_binding_mismatch" });
});
