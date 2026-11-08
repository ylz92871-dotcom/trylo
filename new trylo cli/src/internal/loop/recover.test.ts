import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectCommand } from "../domain/command.js";
import { reduce } from "../domain/reduce.js";
import { initialState } from "../domain/state.js";
import { envelopeChecksum } from "./checksum.js";
import { PROTOCOL_VERSION } from "../protocol/envelope.js";
import { freezeEnvelope } from "../protocol/validate.js";
import { recover } from "./recover.js";

const start = {
  type: "start_turn" as const,
  eventId: "e1",
  sessionId: "ses-1",
  turnId: "trn-1",
  correlationId: "cor-1",
  text: "hi",
};

test("crash before commit reissues unfinished work", () => {
  const opened = reduce(initialState(), start);

  assert.equal(opened.ok, true);

  if (!opened.ok) {
    return;
  }

  const recovered = recover({
    inputs: [start],
    envelopes: [],
    checksums: [],
    issuedKeys: [],
    committedKeys: [],
  });

  assert.equal(recovered.ok, true);

  if (!recovered.ok) {
    return;
  }

  assert.equal(
    recovered.reissue.some((command) => command.idempotencyKey === opened.commands[0]?.idempotencyKey),
    true,
  );
});

test("crash after commit does not reissue", () => {
  const opened = reduce(initialState(), start);

  assert.equal(opened.ok, true);

  if (!opened.ok) {
    return;
  }

  const keys = opened.commands.map((command) => command.idempotencyKey);
  const recovered = recover({
    inputs: [start],
    envelopes: [],
    checksums: [],
    issuedKeys: keys,
    committedKeys: keys,
  });

  assert.equal(recovered.ok, true);

  if (!recovered.ok) {
    return;
  }

  assert.equal(recovered.reissue.length, 0);
});

/**
 * An effect that may already have run must never be replayed on recovery, and
 * its outcome must not be assumed. Tool execution is the real side effect here,
 * so the test drives the domain to the point where it is issued.
 */
test("issued but not committed does not guess success", () => {
  const inputs = [
    start,
    { type: "begin_stream", eventId: "e2" } as const,
    {
      type: "tool_request",
      eventId: "e3",
      toolCallId: "call-1",
      name: "echo",
      arguments: {},
      needsApproval: false,
    } as const,
  ];
  let state = initialState();
  const commands: EffectCommand[] = [];

  for (const input of inputs) {
    const result = reduce(state, input);

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    state = result.state;
    commands.push(...result.commands);
  }

  const tool = commands.find((command) => command.type === "execute_tool");

  assert.notEqual(tool, undefined);

  if (tool === undefined) {
    return;
  }

  const recovered = recover({
    inputs: [...inputs],
    envelopes: [],
    checksums: [],
    issuedKeys: [tool.idempotencyKey],
    committedKeys: [],
  });

  assert.equal(recovered.ok, true);

  if (!recovered.ok) {
    return;
  }

  assert.equal(
    recovered.reissue.some((command) => command.idempotencyKey === tool.idempotencyKey),
    false,
  );
  assert.notEqual(recovered.state.phase, "terminal");
});

test("tampered checksum fails closed", () => {
  const envelope = freezeEnvelope({
    protocolVersion: PROTOCOL_VERSION,
    eventId: "e1",
    sequence: 0,
    timestamp: "1970-01-01T00:00:00.000Z",
    kind: "text",
    payload: { text: "x" },
    producerId: "loop",
    producerSequence: 0,
  });
  const recovered = recover({
    inputs: [],
    envelopes: [envelope],
    checksums: [`tampered-${envelopeChecksum(envelope)}`],
    issuedKeys: [],
    committedKeys: [],
  });

  assert.equal(recovered.ok, false);

  if (recovered.ok) {
    return;
  }

  assert.equal(recovered.code, "checksum");
});
