/**
 * The wire format of the PTY sidecar.
 *
 * Frames are length-prefixed, never line-delimited:
 *
 * ```text
 * +--------+------------------+-------------------+
 * | 1 byte | 4 bytes LE u32   | N bytes           |
 * | type   | payload length   | payload           |
 * +--------+------------------+-------------------+
 * ```
 *
 * This exists because a terminal produces bytes that a string cannot carry
 * faithfully: ANSI escape sequences, NUL, and multi-byte characters split across
 * a read boundary. A frame carries raw bytes, so nothing on the hot path is ever
 * decoded and re-encoded, and the one thing that would corrupt output — passing
 * terminal bytes through a text encoding — cannot happen.
 *
 * Both directions are declared here rather than in the adapter, because the
 * frame layout is a contract between two programs: if the type numbers drift,
 * the sidecar will read a write as a kill and report success.
 */

/** Node -> sidecar. Mirrors the `OP_*` constants in `vendor-bin/pty/src/main.rs`. */
export const PTY_OP = {
  hello: 1,
  spawn: 2,
  write: 3,
  eof: 4,
  resize: 5,
  kill: 6,
} as const;

/** Sidecar -> Node. Mirrors the `EV_*` constants in the same file. */
export const PTY_EVENT = {
  hello: 1,
  ready: 2,
  data: 3,
  exit: 4,
  error: 5,
} as const;

/**
 * Bumped only when the frame layout or a payload's meaning changes.
 *
 * The handshake is checked rather than assumed: a helper from a different build
 * would otherwise be read with this build's field names, producing a session
 * that looks alive and reports nothing. A mismatch has to stop the work.
 *
 * Version 2 added the session id to `data` frames. Version 1 sent bare bytes, so
 * a parent running two terminals at once could not attribute output and each
 * session's buffer received the other's. A helper that still speaks 1 is refused
 * outright rather than accepted with its id-less frames: this build has no way
 * to use them correctly, and silently dropping the ones it cannot attribute
 * would be a quieter version of the same bug.
 */
export const PTY_PROTOCOL_VERSION = 2;

/**
 * Refuses a frame larger than this before allocating for it. The sidecar
 * applies the same ceiling on its side; a sender that ignores it should not be
 * able to make the reader reserve whatever it asked for.
 */
export const PTY_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32LE(payload.byteLength, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function encodeJsonFrame(type: number, value: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * A `write` payload is `[u32 idLen][id][raw bytes]`, not JSON.
 *
 * The bytes are what the user typed. They may be a partial escape sequence or a
 * half-written multi-byte character, and re-encoding them would corrupt exactly
 * the input that a terminal exists to carry. The id is length-prefixed rather
 * than NUL-separated so no id byte can be mistaken for the separator.
 */
export function encodeWriteFrame(type: number, sessionId: string, input: Uint8Array): Buffer {
  const idBytes = Buffer.from(sessionId, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(idBytes.byteLength, 0);
  return encodeFrame(type, Buffer.concat([prefix, idBytes, Buffer.from(input)]));
}

/**
 * Splits an id-prefixed payload. Used for `write` in both directions and for
 * `data` coming back, so there is one shape to get right rather than two.
 *
 * `undefined` when the frame is too short or its id runs past the payload, which
 * is a frame this build cannot attribute to a session and therefore must not
 * deliver to any.
 */
export function decodeIdPayload(
  payload: Uint8Array,
): { readonly sessionId: string; readonly body: Buffer } | undefined {
  if (payload.byteLength < 4) {
    return undefined;
  }

  const view = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const idLength = view.readUInt32LE(0);
  const end = 4 + idLength;
  if (view.byteLength < end) {
    return undefined;
  }

  return {
    sessionId: view.subarray(4, end).toString("utf8"),
    body: Buffer.from(view.subarray(end)),
  };
}

export type PtyFrame = {
  readonly type: number;
  readonly payload: Buffer;
};

/**
 * An incremental decoder over a byte stream that arrives in arbitrary chunks.
 *
 * A stream reader hands over whatever the pipe had, which is not a frame
 * boundary — one read can carry half a frame or three. This keeps the remainder
 * and emits only whole frames, so a caller never has to know how the read
 * happened to land.
 */
export function createFrameDecoder(
  onFrame: (frame: PtyFrame) => void,
  onProtocolViolation?: (reason: string) => void,
): (chunk: Uint8Array) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Uint8Array): void => {
    pending = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.byteLength < 5) {
        return;
      }

      const length = pending.readUInt32LE(1);
      if (length > PTY_MAX_FRAME_BYTES) {
        pending = Buffer.alloc(0);
        onProtocolViolation?.(
          `sidecar announced a ${length} byte frame, above the ${PTY_MAX_FRAME_BYTES} byte ceiling`,
        );
        return;
      }

      if (pending.byteLength < 5 + length) {
        return;
      }

      const type = pending[0] as number;
      const payload = Buffer.from(pending.subarray(5, 5 + length));

      pending = pending.subarray(5 + length);
      onFrame({ type, payload });
    }
  };
}

/** A sidecar error event. `id` is absent for failures that belong to no session. */
export type PtyErrorEvent = {
  readonly id?: string;
  readonly code: string;
  readonly message: string;
};

/**
 * Parse an error event. Returns `undefined` rather than throwing: an
 * unparseable error frame means the peer is not speaking this protocol, which
 * the caller reports as a lost sidecar — not as a session error.
 */
export function parsePtyError(payload: Uint8Array): PtyErrorEvent | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record["code"] !== "string" || typeof record["message"] !== "string") {
    return undefined;
  }

  return {
    ...(typeof record["id"] === "string" ? { id: record["id"] } : {}),
    code: record["code"],
    message: record["message"],
  };
}

export type PtyReadyEvent = { readonly id: string; readonly pid: number };

export type PtyExitEvent = { readonly id: string; readonly code: number };

export type PtyHelloEvent = { readonly protocol: number; readonly version: string };

function parseRecord(payload: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parsePtyReady(payload: Uint8Array): PtyReadyEvent | undefined {
  const record = parseRecord(payload);
  if (record === undefined) {
    return undefined;
  }
  const { id, pid } = record;
  return typeof id === "string" && typeof pid === "number" ? { id, pid } : undefined;
}

export function parsePtyExit(payload: Uint8Array): PtyExitEvent | undefined {
  const record = parseRecord(payload);
  if (record === undefined) {
    return undefined;
  }
  const { id, code } = record;
  return typeof id === "string" && typeof code === "number" ? { id, code } : undefined;
}

/**
 * The sidecar's half of the handshake.
 *
 * `version` is carried rather than checked, because "which build answered" is
 * the first thing anyone needs when a terminal behaves oddly. The `protocol`
 * number is the part that gates work.
 */
export function parsePtyHello(payload: Uint8Array): PtyHelloEvent | undefined {
  const record = parseRecord(payload);
  if (record === undefined) {
    return undefined;
  }

  const { protocol, version } = record;

  return typeof protocol === "number" && typeof version === "string"
    ? { protocol, version }
    : undefined;
}
