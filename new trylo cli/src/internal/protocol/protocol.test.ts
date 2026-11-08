import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { consume } from "./compat.js";
import { decodeEnvelope, encodeEnvelope } from "./codec.js";
import { MAX_PAYLOAD_BYTES } from "./envelope.js";
import { redactEnvelope } from "./redact.js";
import { createAttemptSequencer } from "./sequencer.js";
import { appendLateObservation, readTerminalReason } from "./terminal.js";
import { parseEnvelope } from "./validate.js";

function loadFixture(name: string): unknown {
  const path = join(process.cwd(), "testdata", "protocol", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

function terminalEnvelope(reason: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: "0.0",
    eventId: `evt-${reason}`,
    sequence: 1,
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "terminal",
    payload: { reason, ...extra },
    producerId: "cli",
    producerSequence: 1,
  };
}

test("valid fixture round-trips", () => {
  const parsed = parseEnvelope(loadFixture("valid.json"));

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(parsed.envelope.producerId, "cli");
  assert.equal(parsed.envelope.producerSequence, 1);
  const again = decodeEnvelope(encodeEnvelope(parsed.envelope));

  assert.equal(again.ok, true);

  if (!again.ok) {
    return;
  }

  assert.deepEqual(again.envelope, parsed.envelope);
});

test("missing eventId is rejected", () => {
  const result = parseEnvelope(loadFixture("invalid-no-id.json"));
  assert.deepEqual(result, { ok: false, code: "missing_event_id" });
});

test("unknown kind does not throw and keeps eventId", () => {
  const parsed = parseEnvelope(loadFixture("unknown-kind.json"));

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const result = consume(parsed.envelope);

  assert.equal(result.status, "ignored_unknown_kind");
  assert.equal(result.eventId, "evt-unknown-kind-1");
  assert.equal(result.eventId, parsed.envelope.eventId);
});

test("completed cancelled and unknown are distinct", () => {
  const completed = parseEnvelope(terminalEnvelope("completed"));
  const cancelled = parseEnvelope(terminalEnvelope("cancelled"));
  const unknown = parseEnvelope(terminalEnvelope("unknown"));

  assert.equal(completed.ok, true);
  assert.equal(cancelled.ok, true);
  assert.equal(unknown.ok, true);

  if (!completed.ok || !cancelled.ok || !unknown.ok) {
    return;
  }

  const reasons = [
    readTerminalReason(completed.envelope),
    readTerminalReason(cancelled.envelope),
    readTerminalReason(unknown.envelope),
  ];

  assert.deepEqual(reasons, ["completed", "cancelled", "unknown"]);
  assert.notEqual(reasons[0], reasons[1]);
  assert.notEqual(reasons[0], reasons[2]);
  assert.notEqual(reasons[1], reasons[2]);
});

test("verified is not a terminal reason", () => {
  const parsed = parseEnvelope(terminalEnvelope("verified"));

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(readTerminalReason(parsed.envelope), undefined);
  assert.notEqual(parsed.envelope.payload.reason, "completed");
});

test("verified flag does not mix into completed", () => {
  const parsed = parseEnvelope(terminalEnvelope("completed", { verified: true }));

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(readTerminalReason(parsed.envelope), "completed");
  assert.equal(parsed.envelope.payload.verified, true);
  assert.notEqual(readTerminalReason(parsed.envelope), "verified");
});

test("missing sequence is rejected", () => {
  const result = parseEnvelope(loadFixture("invalid-no-sequence.json"));
  assert.deepEqual(result, { ok: false, code: "missing_sequence" });
});

test("oversized payload is rejected", () => {
  const result = parseEnvelope({
    protocolVersion: "0.0",
    eventId: "evt-big",
    sequence: 0,
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "text",
    payload: { blob: "x".repeat(MAX_PAYLOAD_BYTES) },
    producerId: "cli",
    producerSequence: 0,
  });
  assert.deepEqual(result, { ok: false, code: "payload_too_large" });
});

test("failed is distinct from completed", () => {
  const parsed = parseEnvelope(loadFixture("failed.json"));

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.equal(readTerminalReason(parsed.envelope), "failed");
  assert.notEqual(readTerminalReason(parsed.envelope), "completed");
});

test("sequencer assigns monotonic sequence after binding attempt", () => {
  const sequencer = createAttemptSequencer("att-9");
  const first = sequencer.bind({
    protocolVersion: "0.0",
    eventId: "evt-a",
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "text",
    payload: { text: "a" },
    producerId: "cli",
    producerSequence: 7,
  });
  const second = sequencer.bind({
    protocolVersion: "0.0",
    eventId: "evt-b",
    timestamp: "2026-09-12T00:00:01.000Z",
    kind: "text",
    payload: { text: "b" },
    producerId: "cli",
    producerSequence: 8,
  });

  assert.equal(first.attemptId, "att-9");
  assert.equal(second.attemptId, "att-9");
  assert.equal(first.sequence, 0);
  assert.equal(second.sequence, 1);
});

test("terminal is immutable and late observation is a new event", () => {
  const parsed = parseEnvelope(terminalEnvelope("cancelled"));

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  assert.throws(() => {
    (parsed.envelope.payload as { reason: string }).reason = "completed";
  }, TypeError);
  assert.equal(readTerminalReason(parsed.envelope), "cancelled");
  const sequencer = createAttemptSequencer("att-1");
  const late = appendLateObservation(
    parsed.envelope,
    {
      protocolVersion: "0.0",
      eventId: "evt-late-1",
      timestamp: "2026-09-12T00:00:01.000Z",
      kind: "observation",
      payload: { text: "arrived late" },
      producerId: "cli",
      producerSequence: 99,
    },
    sequencer,
  );

  assert.equal(late.ok, true);

  if (!late.ok) {
    return;
  }

  assert.notEqual(late.envelope.eventId, parsed.envelope.eventId);
  assert.equal(late.envelope.kind, "observation");
  assert.equal(late.envelope.correlationId, parsed.envelope.eventId);
  assert.equal(readTerminalReason(parsed.envelope), "cancelled");
});

test("redact strips path and secret shapes but keeps role error and reason", () => {
  const parsed = parseEnvelope({
    protocolVersion: "0.0",
    eventId: "evt-redact-1",
    sequence: 0,
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "terminal",
    payload: {
      role: "assistant",
      reason: "failed",
      error: "cannot read D:\\CC\\trylo\\secret.txt token=abcd",
    },
    producerId: "cli",
    producerSequence: 1,
  });

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const redacted = redactEnvelope(parsed.envelope);

  assert.equal(redacted.eventId, parsed.envelope.eventId);
  assert.equal(redacted.sequence, parsed.envelope.sequence);
  assert.equal(redacted.payload.role, "assistant");
  assert.equal(redacted.payload.reason, "failed");
  assert.match(String(redacted.payload.error), /cannot read/);
  assert.equal(String(redacted.payload.error).includes("[path]"), true);
  assert.equal(String(redacted.payload.error).includes("[secret]"), true);
});

test("bad protocol version is rejected", () => {
  const result = parseEnvelope({
    protocolVersion: "9.9",
    eventId: "evt-ver",
    sequence: 0,
    timestamp: "2026-09-12T00:00:00.000Z",
    kind: "text",
    payload: {},
    producerId: "cli",
    producerSequence: 0,
  });
  assert.deepEqual(result, { ok: false, code: "invalid_protocol_version" });
});

test("valid fixture has every schema required field", () => {
  const schema = loadFixture("envelope.schema.json") as {
    required: string[];
  };
  const raw = loadFixture("valid.json") as Record<string, unknown>;

  for (const key of schema.required) {
    assert.equal(key in raw, true, key);
  }
});

test("redact keeps correlation role reason and order", () => {
  const parsed = parseEnvelope({
    protocolVersion: "0.0",
    eventId: "evt-redact-2",
    sequence: 4,
    timestamp: "2026-09-12T00:00:00.000Z",
    correlationId: "cor-keep",
    kind: "terminal",
    payload: {
      role: "assistant",
      reason: "failed",
      order: 2,
      error: "token=abcd",
    },
    producerId: "cli",
    producerSequence: 4,
  });

  assert.equal(parsed.ok, true);

  if (!parsed.ok) {
    return;
  }

  const redacted = redactEnvelope(parsed.envelope);

  assert.equal(redacted.correlationId, "cor-keep");
  assert.equal(redacted.sequence, 4);
  assert.equal(redacted.payload.role, "assistant");
  assert.equal(redacted.payload.reason, "failed");
  assert.equal(redacted.payload.order, 2);
});

