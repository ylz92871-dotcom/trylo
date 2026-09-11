// Trylo Desktop Services — NDJSON frame codec for the Service Host stdio
// protocol. See docs/TRYLO-MIGRATION-EXECUTION-SPEC-2026-08-28.md §5.1.
//
// Frame (single JSON line, ≤ MAX_FRAME_BYTES):
//   { version:1, type:'request',  id, method, params? }
//   { version:1, type:'response', id, ok:true,  result? }
//   { version:1, type:'response', id, ok:false, error:{code,message} }
//   { version:1, type:'event',    topic, payload }
//   { version:1, type:'ping' | 'pong' }
//
// Ownership: the wire boundary. All frames entering/leaving the sidecar pass
// through here exactly once. Unknown version / malformed shape fail-closed.
//
// Failure policy: encode() throws on un-serializable or oversized payloads;
// decode() returns null for malformed SQL single-line frames so the caller can
// keep the stream alive (a hostile/mangling peer must not take the loop down).

const VERSION = 1;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

// request/response/event/ping/pong — the closed set of types the speaker owns.
const FRAME_TYPES = new Set(['request', 'response', 'event', 'ping', 'pong']);

export const FRAME_LIMIT = MAX_FRAME_BYTES;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateRequest(f) {
  return (
    typeof f.id === 'string' &&
    f.id.length > 0 &&
    typeof f.method === 'string' &&
    f.method.length > 0
  );
}

function validateResponse(f) {
  if (typeof f.id !== 'string' || f.id.length === 0) return false;
  if (f.ok === true) return true; // result optional
  if (f.ok === false) {
    return (
      f.error &&
      typeof f.error === 'object' &&
      typeof f.error.code === 'string' &&
      typeof f.error.message === 'string'
    );
  }
  return false;
}

function validateEvent(f) {
  return typeof f.topic === 'string' && f.topic.length > 0;
}

/// Assert shape, version, and size. Returns the frame or throws a descriptive
/// Error. Decode-only data that failed validation should be dropped, not thrown,
/// so this returns the validated frame to the caller after a successful check.
export function assertValid(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('protocol: frame must be an object');
  }
  if (frame.version !== VERSION) {
    throw new Error(`protocol: unsupported version ${String(frame.version)}`);
  }
  const type = frame.type;
  if (!FRAME_TYPES.has(type)) {
    throw new Error(`protocol: unknown frame type '${String(type)}'`);
  }
  if (type === 'request' && !validateRequest(frame)) {
    throw new Error('protocol: malformed request frame');
  }
  if (type === 'response' && !validateResponse(frame)) {
    throw new Error('protocol: malformed response frame');
  }
  if (type === 'event' && !validateEvent(frame)) {
    throw new Error('protocol: malformed event frame');
  }
  if (type === 'request' || type === 'response') {
    if (typeof frame.id !== 'string' || frame.id.length > 4096) {
      throw new Error('protocol: oversized id');
    }
  }
}

/// Serialize a frame to a single newline-terminated line. Throws if the frame
/// is invalid, too large, or contains values JSON cannot represent.
export function encode(frame) {
  assertValid(frame);
  let line;
  try {
    line = JSON.stringify(frame);
  } catch {
    throw new Error('protocol: frame not JSON-serializable');
  }
  if (line === undefined) throw new Error('protocol: frame not JSON-serializable');
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_FRAME_BYTES) {
    throw new Error(
      `protocol: frame exceeds ${MAX_FRAME_BYTES} bytes (actual ${bytes})`,
    );
  }
  return `${line}\n`;
}

/// Parse one complete NDJSON line, or return null if it is not a valid,
/// version-1, well-shaped frame. Non-throwing: hostile/mangled input drops
/// silently so the read loop continues.
export function decodeRaw(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  try {
    assertValid(parsed);
  } catch {
    return null;
  }
  return parsed;
}

/// Sessions: build a request frame (sender side).
export function requestFrame(id, method, params) {
  const frame = { version: VERSION, type: 'request', id, method };
  if (params !== undefined) frame.params = params;
  return frame;
}

/// Sessions: build a response frame (replier side).
export function responseFrame(id, result) {
  return { version: VERSION, type: 'response', id, ok: true, result };
}

export function errorFrame(id, code, message) {
  return { version: VERSION, type: 'response', id, ok: false, error: { code, message } };
}

export function eventFrame(topic, payload) {
  return { version: VERSION, type: 'event', topic, payload };
}

export function pingFrame() {
  return { version: VERSION, type: 'ping' };
}

export function pongFrame() {
  return { version: VERSION, type: 'pong' };
}

/// Build a request frame and encode it. Convenience for the host/registry loop.
export function encodeRequest(id, method, params) {
  return encode(requestFrame(id, method, params));
}