import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope } from "../../protocol/envelope.js";
import { projectEnvelopeSequence } from "./stream-projection.js";

for (const cause of ["output_tokens_exhausted", "iterations_exhausted"]) {
  test(`${cause} does not promise that an arbitrary execution session was saved`, () => {
    const terminal: Envelope = {
      protocolVersion: "0.0", eventId: "terminal", sequence: 1,
      timestamp: "2026-11-03T00:00:00.000Z", kind: "terminal", producerId: "fixture", producerSequence: 1,
      payload: { reason: "failed", cause, sessionId: "eph-unsaved", budgetUsed: 10, budgetLimit: 10 },
    };
    const warning = projectEnvelopeSequence([terminal]).find(event => event.type === "warning");

    assert.equal(warning?.type, "warning");

    if (warning?.type !== "warning") return;

    assert.doesNotMatch(warning.message, /--resume eph-unsaved/);
    assert.match(warning.message, /unsaved runs cannot be resumed/i);
    assert.match(warning.message, /--session/);
    assert.match(warning.message, /--resume <saved-session>/);
    assert.match(warning.message, /partial effects/i);
  });
}
