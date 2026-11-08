import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope } from "./envelope.js";
import { parseEnvelope } from "./validate.js";
import { createPublicToolResultReader, publicToolResultFrames, PublicToolResultError } from "./public-tool-result.js";

function wire() {
  const identity = { protocolVersion: "0.0", producerId: "loop", sessionId: "s", turnId: "t", attemptId: "a", correlationId: "c" };
  const payload = { toolCallId: "original-call", status: "succeeded", value: { content: "x".repeat(80000) }, output: "separate", truncated: false };
  const frames = publicToolResultFrames(payload, identity, 10);
  assert.ok(frames);
  return frames.map((frame, index): Envelope => ({ ...identity, ...frame, eventId: `event-${index}`, sequence: index,
    producerSequence: 10 + index, timestamp: "2026-11-08T04:00:00.000Z" }));
}

const consume = (events: readonly Envelope[]) => {
  const reader = createPublicToolResultReader();
  try { for (const event of events) reader.push(event); } finally { reader.close(); }
};

test("public result assembly rejects missing fragments, other original turns and changed bytes", () => {
  const original = wire();
  assert.ok(original.every(event => parseEnvelope(event).ok));
  assert.throws(() => consume(original.slice(1)), error => error instanceof PublicToolResultError && error.code === "public_tool_result_missing");
  assert.throws(() => consume(original.map((event, index) => index === 0 ? { ...event, turnId: "other-turn" } : event)),
    error => error instanceof PublicToolResultError && error.code === "public_tool_result_binding");
  const serialized = JSON.stringify(original[0]), changed = serialized.replace('"text":"{', '"text":"!');
  assert.notEqual(changed, serialized);
  const corrupt = parseEnvelope(JSON.parse(changed));
  assert.ok(corrupt.ok, "the tampered frame itself is still protocol-valid");
  assert.throws(() => consume([corrupt.envelope, ...original.slice(1)]),
    error => error instanceof PublicToolResultError && error.code === "public_tool_result_hash");
  assert.equal(publicToolResultFrames({ toolCallId: "small", status: "succeeded", value: { ok: true } }, original[0]!, 10), undefined,
    "small frames keep their original wire without manifests or extra events");
});
