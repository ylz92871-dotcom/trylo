import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PTY_EVENT,
  PTY_MAX_FRAME_BYTES,
  PTY_OP,
  PTY_PROTOCOL_VERSION,
  createFrameDecoder,
  decodeIdPayload,
  encodeFrame,
  encodeJsonFrame,
  encodeWriteFrame,
  parsePtyError,
  parsePtyExit,
  parsePtyHello,
  parsePtyReady,
} from "./pty-protocol.js";

/**
 * The frame layout is a contract between two programs that were compiled
 * separately. These tests exist because a mismatch here does not throw — it
 * reads a `write` as a `kill`, and the symptom is a session that appears to work
 * while the user's input is discarded.
 */
/** Mirrors the sidecar's `with_id`: [u32 idLen][id][body]. */
function encodeIdPrefixed(id: string, body: Buffer): Buffer {
  const idBytes = Buffer.from(id, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(idBytes.byteLength, 0);
  return Buffer.concat([prefix, idBytes, body]);
}

describe("pty sidecar frames", () => {
  it("puts the type first and the length little-endian", () => {
    const frame = encodeFrame(PTY_OP.hello, Buffer.from("hi", "utf8"));
    assert.equal(frame.byteLength, 7);
    assert.equal(frame[0], PTY_OP.hello);
    assert.equal(frame.readUInt32LE(1), 2);
    assert.equal(frame.subarray(5).toString("utf8"), "hi");
  });

  it("carries a payload that is not valid utf-8 without altering it", () => {
    // Terminal output contains ANSI escapes, NUL, and half-written multi-byte
    // characters. Anything that routes these through a string corrupts them.
    const raw = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0xff, 0xfe]);
    const decoded = encodeFrame(PTY_EVENT.data, raw).subarray(5);
    assert.deepEqual([...decoded], [...raw]);
  });

  it("emits whole frames from a stream that arrives in arbitrary chunks", () => {
    const seen: Array<{ type: number; text: string }> = [];
    const decode = createFrameDecoder((frame) => {
      seen.push({ type: frame.type, text: frame.payload.toString("utf8") });
    });
    const whole = Buffer.concat([
      encodeJsonFrame(PTY_EVENT.hello, { protocol: 1, version: "0.1.0" }),
      encodeFrame(PTY_EVENT.data, Buffer.from("one", "utf8")),
      encodeFrame(PTY_EVENT.data, Buffer.from("two", "utf8")),
    ]);

    // One byte at a time: no read boundary may be assumed to be a frame boundary.
    for (const byte of whole) {
      decode(Buffer.from([byte]));
    }

    assert.equal(seen.length, 3);
    assert.equal(seen[1]?.text, "one");
    assert.equal(seen[2]?.text, "two");
  });

  it("refuses a frame claiming more than the ceiling instead of allocating it", () => {
    let violation = "";
    const seen: number[] = [];
    const decode = createFrameDecoder(
      (frame) => seen.push(frame.type),
      (reason) => {
        violation = reason;
      },
    );
    const lying = Buffer.alloc(5);

    lying[0] = PTY_EVENT.data;
    lying.writeUInt32LE(PTY_MAX_FRAME_BYTES + 1, 1);
    decode(lying);
    assert.notEqual(violation, "", "an oversized frame must be reported");
    assert.match(violation, /ceiling/);
    assert.equal(seen.length, 0, "nothing is delivered from a stream that lied");
  });

  it("round-trips a write payload as raw bytes with a length-prefixed id", () => {
    const input = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xe4, 0xb8]);
    const frame = encodeWriteFrame(PTY_OP.write, "ps_abc", input);
    const decoded = decodeIdPayload(frame.subarray(5));
    assert.ok(decoded !== undefined);
    assert.equal(decoded.sessionId, "ps_abc");
    assert.deepEqual([...decoded.body], [...input]);
  });

  it("rejects a write payload whose id runs past the frame", () => {
    const frame = encodeWriteFrame(PTY_OP.write, "ps_abc", Buffer.from("x", "utf8"));
    assert.equal(decodeIdPayload(frame.subarray(5, 6)), undefined);
  });

  it("speaks protocol 2, the version whose data frames name their session", () => {
    // Version 1 sent data frames with no session id, so a parent could not tell
    // two live terminals apart. The constant and the sidecar's PROTOCOL_VERSION
    // are asserted equal elsewhere; this pins the number so a change to either
    // one has to be deliberate rather than a side effect.
    assert.equal(PTY_PROTOCOL_VERSION, 2);
  });

  it("carries the session id in a data frame, so output is attributable", () => {
    // The shape the sidecar writes: [u32 idLen][id][raw bytes]. Without the id
    // there is no way to tell which of several terminals produced a byte.
    const output = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00]);
    const frame = encodeFrame(PTY_EVENT.data, encodeIdPrefixed("ps_alpha", output));
    const decoded = decodeIdPayload(frame.subarray(5));

    assert.ok(decoded !== undefined, "a data frame must be decodable");
    assert.equal(decoded.sessionId, "ps_alpha");
    assert.deepEqual([...decoded.body], [...output], "the bytes after the id are untouched");
  });

  it("refuses a data frame whose id runs past the payload rather than guessing", () => {
    // A truncated header means the bytes cannot be attributed to anyone.
    const lying = Buffer.alloc(4);
    lying.writeUInt32LE(999, 0);
    assert.equal(decodeIdPayload(lying), undefined);
    assert.equal(decodeIdPayload(Buffer.alloc(0)), undefined);
  });

  it("parses each event shape and refuses the ones it cannot use", () => {
    assert.deepEqual(parsePtyHello(encodeJsonFrame(PTY_OP.hello, { protocol: 1, version: "0.1.0" }).subarray(5)), {
      protocol: 1,
      version: "0.1.0",
    });
    assert.deepEqual(parsePtyReady(encodeJsonFrame(PTY_OP.spawn, { id: "ps_1", pid: 42 }).subarray(5)), {
      id: "ps_1",
      pid: 42,
    });
    assert.deepEqual(parsePtyExit(encodeJsonFrame(PTY_OP.kill, { id: "ps_1", code: 7 }).subarray(5)), {
      id: "ps_1",
      code: 7,
    });
    assert.deepEqual(
      parsePtyError(
        encodeJsonFrame(PTY_OP.write, { id: "ps_1", code: "pty_write_failed", message: "no" }).subarray(5),
      ),
      { id: "ps_1", code: "pty_write_failed", message: "no" },
    );
  });

  it("returns undefined rather than throwing on an unparseable payload", () => {
    // An unparseable event means the peer is not speaking this protocol, and
    // the caller reports that as a lost sidecar. Throwing here would turn a
    // protocol difference into a crash with no explanation.
    assert.equal(parsePtyHello(Buffer.from("not json", "utf8")), undefined);
    assert.equal(parsePtyError(Buffer.from([0xff, 0xfe])), undefined);
    assert.equal(parsePtyReady(encodeJsonFrame(PTY_OP.spawn, { id: 5 }).subarray(5)), undefined);
  });

  it("accepts an error event with no session id", () => {
    assert.deepEqual(
      parsePtyError(encodeJsonFrame(PTY_OP.hello, { code: "pty_protocol_mismatch", message: "x" }).subarray(5)),
      { code: "pty_protocol_mismatch", message: "x" },
    );
  });
});
