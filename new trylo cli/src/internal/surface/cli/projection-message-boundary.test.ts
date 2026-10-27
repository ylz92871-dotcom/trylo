import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transcript, TranscriptItem } from "../../protocol/transcript.js";
import { lastMessageOf, projectRunResult } from "./projection.js";

const oldUser: TranscriptItem = { kind: "user", sequence: 0, text: "Append the first line." };
const oldReply: TranscriptItem = { kind: "assistant_text", sequence: 1, blockId: "old", text: "Completed: the old file had 21 bytes." };
const newUser: TranscriptItem = { kind: "user", sequence: 2, text: "Append a different UTF-8 line and verify it." };
const resumed: Transcript = [oldUser, oldReply, newUser];

for (const status of ["unknown", "failed", "cancelled", "completed"] as const) {
  test(`${status}: a resumed turn without assistant text cannot report a previous reply`, () => {
    const result = projectRunResult(resumed, { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { sessionId: "same-session", turnId: "new-turn", providerId: "fixture", model: "fixture", iterations: 1, durationMs: 1 },
      { status, finishReason: status === "completed" ? "stop" : "tool_calls" });
    assert.equal(result.lastMessage, "");
    assert.equal(result.status, status);
    assert.equal(resumed[1], oldReply, "history remains available for provider context and durable recovery");
  });
}

test("a reply after the latest user input is still reported", () => {
  assert.equal(lastMessageOf([...resumed,
    { kind: "assistant_text", sequence: 3, blockId: "new", text: "Verified the new line." },
  ]), "Verified the new line.");
});

test("a new user correction cannot reuse text answering the superseded input", () => {
  assert.equal(lastMessageOf([oldUser, oldReply, newUser,
    { kind: "assistant_text", sequence: 3, blockId: "plan", text: "I will use the initial value." },
    { kind: "user", sequence: 4, text: "Use the corrected value instead." },
  ]), "");
});

test("non-user facts after a current reply do not erase that reply", () => {
  assert.equal(lastMessageOf([...resumed,
    { kind: "assistant_text", sequence: 3, blockId: "new", text: "Current reply." },
    { kind: "system", sequence: 4, text: "Recorded verification facts." },
  ]), "Current reply.");
});

test("legacy assistant-only transcript projection remains supported", () => {
  assert.equal(lastMessageOf([oldReply]), oldReply.text);
});
