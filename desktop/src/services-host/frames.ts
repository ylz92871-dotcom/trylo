// Trylo Desktop — Service Host frame codec (renderer side).
//
// TS mirror of `desktop-services/src/protocol/frames.mjs` (migration spec
// §5.1 / §5.4). The wire is NDJSON over the Tauri `servicehost://frame`
// event (S) and the `servicehost_send` command (D). Raw JSON is touched
// only here and re-encoded once — everything above this file works with
// typed frames (spec §11: raw JSON 只出现在 adapter 边界一次).

export type RequestFrame = {
  readonly version: 1;
  readonly type: 'request';
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
};

export type SuccessResponseFrame = {
  readonly version: 1;
  readonly type: 'response';
  readonly id: string;
  readonly ok: true;
  readonly result?: unknown;
};

export type ErrorResponseFrame = {
  readonly version: 1;
  readonly type: 'response';
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
};

export type EventFrame = {
  readonly version: 1;
  readonly type: 'event';
  readonly topic: string;
  readonly payload?: unknown;
};

export type PingFrame = { readonly version: 1; readonly type: 'ping' };
export type PongFrame = { readonly version: 1; readonly type: 'pong' };

export type Frame =
  | RequestFrame
  | SuccessResponseFrame
  | ErrorResponseFrame
  | EventFrame
  | PingFrame
  | PongFrame;

/** Single-frame cap, mirrored from the sidecar's frames.mjs. */
export const FRAME_LIMIT_BYTES = 2 * 1024 * 1024;

// `Buffer` is a Node global and does NOT exist in the Tauri webview — using
// it here made EVERY encodeFrame throw `ReferenceError: Buffer is not
// defined` in the real app (vitest never caught it: it runs in Node where
// Buffer exists). TextEncoder is standard in browsers and Node >= 11.
const utf8Encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

const FRAME_TYPES: ReadonlySet<string> = new Set([
  'request',
  'response',
  'event',
  'ping',
  'pong',
]);

/** Serializes a frame to one NDJSON line (with trailing newline).
 *  Throws on unknown version/type, missing required fields, or frames
 *  beyond the 2MB cap — fail closed, matching the sidecar. */
export function encodeFrame(frame: Frame): string {
  if (!frame || typeof frame !== 'object') throw new Error('frame must be an object');
  if (frame.version !== 1) throw new Error('unsupported frame version');
  if (!FRAME_TYPES.has(frame.type)) throw new Error(`unknown frame type: ${String(frame['type'])}`);
  if (frame.type === 'request') {
    const f = frame as RequestFrame;
    if (typeof f.id !== 'string' || f.id === '') throw new Error('request frame requires id');
    if (typeof f.method !== 'string' || f.method === '') throw new Error('request frame requires method');
  } else if (frame.type === 'response') {
    const f = frame as SuccessResponseFrame | ErrorResponseFrame;
    if (typeof f.id !== 'string' || f.id === '') throw new Error('response frame requires id');
    if (typeof f.ok !== 'boolean') throw new Error('response frame requires ok');
    if (!f.ok) {
      const err = (f as ErrorResponseFrame).error;
      if (!err || typeof err.code !== 'string' || typeof err.message !== 'string') {
        throw new Error('error response requires { code, message }');
      }
    }
  } else if (frame.type === 'event') {
    const f = frame as EventFrame;
    if (typeof f.topic !== 'string' || f.topic === '') throw new Error('event frame requires topic');
  }
  const line = JSON.stringify(frame);
  if (utf8ByteLength(line) > FRAME_LIMIT_BYTES) {
    throw new Error('frame exceeds 2MB limit');
  }
  return `${line}\n`;
}

/** Parses one NDJSON line. Returns null for anything malformed — a bad
 *  line never throws into the caller's loop (mirrors decodeRaw). */
export function decodeFrameLine(line: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const frame = parsed as Record<string, unknown>;
  if (frame['version'] !== 1) return null;
  if (typeof frame['type'] !== 'string' || !FRAME_TYPES.has(frame['type'])) return null;
  if (frame['type'] === 'request') {
    if (typeof frame['id'] !== 'string' || typeof frame['method'] !== 'string') return null;
  } else if (frame['type'] === 'response') {
    if (typeof frame['id'] !== 'string' || typeof frame['ok'] !== 'boolean') return null;
  } else if (frame['type'] === 'event') {
    if (typeof frame['topic'] !== 'string') return null;
  }
  return parsed as Frame;
}

let requestCounter = 0;

/** Monotonic per-renderer request id: `<pid-less-monotonic>-<counter>`. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}
