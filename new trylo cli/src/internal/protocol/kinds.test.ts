import assert from "node:assert/strict";
import { test } from "node:test";
import { consume } from "./compat.js";
import { parseEnvelope } from "./validate.js";
import { EVENT_KINDS, isEventKind } from "./kinds.js";

test("observation is a first-class understood kind", () => {
  assert.equal(isEventKind("observation"), true);
  assert.equal(EVENT_KINDS.includes("observation"), true);
  const parsed = parseEnvelope({
    protocolVersion: "0.0",
    eventId: "evt-obs",
    sequence: 0,
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "observation",
    payload: { late: true },
    producerId: "cli",
    producerSequence: 0,
  });

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(consume(parsed.envelope).status, "accepted");
});

test("unknown future kind is ignored without dropping eventId", () => {
  const parsed = parseEnvelope({
    protocolVersion: "0.0",
    eventId: "evt-future",
    sequence: 2,
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "future_vendor_blob",
    payload: {},
    producerId: "cli",
    producerSequence: 2,
  });

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const result = consume(parsed.envelope);

  assert.equal(result.status, "ignored_unknown_kind");
  assert.equal(result.eventId, "evt-future");
});
