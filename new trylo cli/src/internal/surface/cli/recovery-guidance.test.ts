import assert from "node:assert/strict";
import { test } from "node:test";
import { projectEnvelopes } from "./projection.js";
import type { Envelope } from "../../protocol/envelope.js";

for (const cause of ["sent_unacked", "transport_fail", "disconnect"]) test(`${cause} guides the user to saved work instead of replaying a workflow`, () => {
  const event: Envelope = { protocolVersion: "0.0", eventId: "e", sequence: 1,
    timestamp: "2026-10-23T00:00:00.000Z", kind: "terminal", producerId: "fixture", producerSequence: 1,
    payload: { reason: "unknown", cause, sessionId: "saved", message: "disconnect" } };
  const message = projectEnvelopes([event]).filter(item => item.type === "warning").map(item => item.message).join("\n");
  assert.match(message, /same saved session/i);
  assert.match(message, /recorded tool results/i);
  assert.match(message, /do not repeat completed actions/i);
  assert.doesNotMatch(message, /retry the run/i);
});
