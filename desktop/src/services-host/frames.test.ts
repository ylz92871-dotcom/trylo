// Trylo Desktop — services-host frame codec tests (mirrors the sidecar's
// protocol.test.mjs expectations, migration spec §5.1 / §10 L3).

import { describe, expect, it } from 'vitest';

import { decodeFrameLine, encodeFrame, FRAME_LIMIT_BYTES, nextRequestId } from './frames';
import type { Frame } from './frames';

describe('encodeFrame', () => {
  it('serializes a request with a trailing newline', () => {
    const line = encodeFrame({ version: 1, type: 'request', id: 'r1', method: 'pet.enable', params: { workspacePath: '/w' } });
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ version: 1, type: 'request', id: 'r1', method: 'pet.enable' });
  });

  it('rejects unknown version / type (fail closed)', () => {
    expect(() => encodeFrame({ version: 2, type: 'request', id: 'x', method: 'm' } as unknown as Frame)).toThrow();
    expect(() => encodeFrame({ version: 1, type: 'nonsense' } as unknown as Frame)).toThrow();
  });

  it('rejects requests without id / method', () => {
    // @ts-expect-error — intentionally malformed
    expect(() => encodeFrame({ version: 1, type: 'request', method: 'm' })).toThrow();
    // @ts-expect-error — intentionally malformed
    expect(() => encodeFrame({ version: 1, type: 'request', id: 'x' })).toThrow();
  });

  it('rejects error responses without { code, message }', () => {
    expect(() =>
      encodeFrame({ version: 1, type: 'response', id: 'x', ok: false, error: { code: 'C', message: 'm' } }),
    ).not.toThrow();
    // @ts-expect-error — intentionally malformed
    expect(() => encodeFrame({ version: 1, type: 'response', id: 'x', ok: false })).toThrow();
  });

  it('rejects frames beyond the 2MB cap', () => {
    const big = 'x'.repeat(FRAME_LIMIT_BYTES);
    expect(() =>
      encodeFrame({ version: 1, type: 'request', id: 'big', method: 'm', params: { big } }),
    ).toThrow(/2MB/);
  });

  it('encodes without Node-only globals (regression: Buffer is not defined in the Tauri webview)', () => {
    // The renderer runs in a browser-like webview where Node's `Buffer`
    // global does NOT exist. Deleting it here reproduces that environment so
    // a future reintroduction of `Buffer` fails the test (vitest normally
    // hides this bug because it runs in Node).
    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    (globalThis as { Buffer?: unknown }).Buffer = undefined;
    try {
      const line = encodeFrame({ version: 1, type: 'request', id: 'r1', method: 'pet.status' });
      expect(line.endsWith('\n')).toBe(true);
      // And the 2MB cap still works without Buffer.
      expect(() =>
        encodeFrame({ version: 1, type: 'request', id: 'big', method: 'm', params: { big: 'x'.repeat(FRAME_LIMIT_BYTES) } }),
      ).toThrow(/2MB/);
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }
  });
});

describe('decodeFrameLine', () => {
  it('parses a valid request line', () => {
    const frame = decodeFrameLine('{"version":1,"type":"request","id":"a","method":"pet.disable"}');
    expect(frame).toMatchObject({ type: 'request', id: 'a', method: 'pet.disable' });
  });

  it('returns null for garbage / wrong version / missing fields', () => {
    expect(decodeFrameLine('not json')).toBeNull();
    expect(decodeFrameLine('[1,2,3]')).toBeNull();
    expect(decodeFrameLine('{"version":9,"type":"request","id":"a","method":"m"}')).toBeNull();
    expect(decodeFrameLine('{"version":1,"type":"request"}')).toBeNull();
    expect(decodeFrameLine('{"version":1,"type":"event"}')).toBeNull();
  });

  it('round-trips an event frame through encode/decode', () => {
    const line = encodeFrame({ version: 1, type: 'event', topic: 'pet.status', payload: { enabled: true } });
    expect(decodeFrameLine(line.trim())).toMatchObject({ type: 'event', topic: 'pet.status' });
  });
});

describe('nextRequestId', () => {
  it('produces unique monotonic ids', () => {
    const a = nextRequestId();
    const b = nextRequestId();
    expect(a).not.toBe(b);
    expect(a.startsWith('req-')).toBe(true);
  });
});
