// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { allowPreviewRequest } from './request-origin';
function req(host: string, origin?: string, encrypted = false): Pick<IncomingMessage, 'headers' | 'socket'> {
  return { headers: { host, ...(origin === undefined ? {} : { origin }) }, socket: { encrypted } as unknown as IncomingMessage['socket'] };
}
describe('local preview API origin boundary', () => {
  it('accepts the app’s own local HTTP/TLS origin and local requests without an Origin', () => {
    expect(allowPreviewRequest(req('127.0.0.1:15282', 'http://127.0.0.1:15282'))).toBe(true);
    expect(allowPreviewRequest(req('localhost:1420'))).toBe(true);
    expect(allowPreviewRequest(req('[::1]:1420', 'http://[::1]:1420'))).toBe(true);
    expect(allowPreviewRequest(req('localhost:1420', 'https://localhost:1420', true))).toBe(true);
  });
  it('rejects opaque/malformed/cross-origin requests without throwing', () => {
    for (const origin of ['null', 'not a URL', 'https://outside.example', 'http://localhost:1', 'http://127.0.0.1:1420', 'https://localhost:1420', 'http://user@localhost:1420', 'http://localhost:1420/path']) {
      expect(allowPreviewRequest(req('localhost:1420', origin)), origin).toBe(false);
    }
  });
  it('rejects non-loopback Host even if Origin matches that hostname', () => {
    expect(allowPreviewRequest(req('rebind.example:1420', 'http://rebind.example:1420'))).toBe(false);
    expect(allowPreviewRequest(req('127.0.0.1.evil.example:1420'))).toBe(false);
    expect(allowPreviewRequest(req('localhost:1420/path'))).toBe(false);
  });
});
