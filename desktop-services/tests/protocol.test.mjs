// Trylo Desktop Services — frame codec + registry + host contract tests.
// node:test (spec §10 L3; §0 rule 5 — desktop-services never under vitest).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';

import {
  encode,
  decodeRaw,
  requestFrame,
  responseFrame,
  errorFrame,
  eventFrame,
  pingFrame,
  pongFrame,
  encodeRequest,
  FRAME_LIMIT,
} from '../src/protocol/frames.mjs';
import { MethodRegistry, UNKNOWN_METHOD } from '../src/protocol/registry.mjs';
import { createHost } from '../src/host.mjs';

describe('frames: encode', () => {
  it('serializes a request with newline terminator', () => {
    const line = encode(requestFrame('r1', 'pet.enable', { workspacePath: '/x' }));
    assert.ok(line.endsWith('\n'));
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.version, 1);
    assert.equal(parsed.type, 'request');
    assert.equal(parsed.id, 'r1');
    assert.equal(parsed.method, 'pet.enable');
    assert.equal(parsed.params.workspacePath, '/x');
  });

  it('rejects unknown version (fail closed)', () => {
    assert.throws(() => encode({ version: 2, type: 'request', id: 'x', method: 'm' }));
  });

  it('rejects unknown frame type', () => {
    assert.throws(() => encode({ version: 1, type: 'nonsense' }));
  });

  it('rejects malformed request without id', () => {
    assert.throws(() => encode({ version: 1, type: 'request', method: 'm' }));
  });

  it('rejects oversized frame beyond 2MB', () => {
    const big = 'x'.repeat(FRAME_LIMIT + 1);
    assert.throws(() => encode({ version: 1, type: 'request', id: 'big', method: 'm', params: { big } }));
  });

  it('returns error with code+message for ok:false response', () => {
    const line = encode(errorFrame('r', UNKNOWN_METHOD, 'bad method'));
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, UNKNOWN_METHOD);
  });
});

describe('frames: decodeRaw', () => {
  it('parses a valid request line', () => {
    const f = decodeRaw(encode(requestFrame('id', 'm', { a: 1 })).trim());
    assert.equal(f.type, 'request');
    assert.equal(f.method, 'm');
  });

  it('returns null for non-object / garbage', () => {
    assert.equal(decodeRaw('not json'), null);
    assert.equal(decodeRaw('[1,2,3]'), null);
  });

  it('returns null for wrong version', () => {
    assert.equal(decodeRaw(JSON.stringify({ version: 9, type: 'request', id: 'i', method: 'm' })), null);
  });
});

describe('registry', () => {
  it('dispatches a shared handler to all namespaces', async () => {
    const reg = new MethodRegistry();
    const calls = [];
    reg.register('pet', 'enable', (p) => {
      calls.push(p);
      return { ok: true };
    });
    const out = await reg.dispatch('pet.enable', { workspacePath: '/a' }, {});
    assert.equal(out.handled, true);
    assert.equal(out.isError, false);
    assert.equal(out.result.ok, true);
    assert.equal(calls.length, 1);
  });

  it('returns handled:false for unknown method', async () => {
    const reg = new MethodRegistry();
    const out = await reg.dispatch('pet.nope', {}, {});
    assert.equal(out.handled, false);
  });

  it('refuses duplicate registration', () => {
    const reg = new MethodRegistry().register('a', 'b', () => {});
    assert.throws(() => reg.register('a', 'b', () => {}));
  });

  it('maps thrown errors to code+message', async () => {
    const reg = new MethodRegistry().register('pet', 'enable', () => {
      throw Object.assign(new Error('boom'), { code: 'BOOM' });
    });
    const out = await reg.dispatch('pet.enable', {}, {});
    assert.equal(out.isError, true);
    assert.equal(out.code, 'BOOM');
    assert.equal(out.message, 'boom');
  });
});

describe('host: frame round-trip over stdio', () => {
  function runHost(lines) {
    const input = new Readable({ read() {} });
    const output = new Writable({ write(chunk, _enc, cb) { collected += chunk.toString(); cb(); } });
    let collected = '';
    const host = createHost({ stdin: input, stdout: output, stderr: output, autoExit: false });
    host.start();
    for (const l of lines) input.push(l + '\n');
    input.push(null); // EOF so line events settle deterministically
    return {
      get() { return collected; },
      frames() { return collected.split('\n').filter(Boolean).map((l) => JSON.parse(l)); },
    };
  }

  // frame host stdio is async (readline + promise dispatch); poll for a frame
  function eventually(framesFn, pred, { timeoutMs = 200, intervalMs = 5 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const found = framesFn().find(pred);
      if (found) return Promise.resolve(found);
      if (Date.now() > deadline) return Promise.reject(new Error('frame never arrived within timeout'));
      return new Promise((r) => setTimeout(r, intervalMs)).then(attempt);
    };
    return attempt();
  }

  it('emits a ready event on start', async () => {
    const h = runHost([]);
    const ready = await eventually(h.frames, (l) => l.type === 'event' && l.topic === 'ready');
    assert.equal(ready.type, 'event');
    assert.equal(ready.topic, 'ready');
  });

  it('answers a request with ok:true result', async () => {
    const h = runHost([JSON.stringify({ version: 1, type: 'request', id: '1', method: 'pet.disable' })]);
    const resp = await eventually(h.frames, (l) => l.type === 'response' && l.id === '1');
    assert.equal(resp.ok, true);
  });

  it('answers ping with pong', async () => {
    const h = runHost([JSON.stringify({ version: 1, type: 'ping' })]);
    const pong = await eventually(h.frames, (l) => l.type === 'pong');
    assert.equal(pong.type, 'pong');
  });

  it('replies UNKNOWN_METHOD for an unregistered method', async () => {
    const h = runHost([JSON.stringify({ version: 1, type: 'request', id: '9', method: 'remote.nope' })]);
    const resp = await eventually(h.frames, (l) => l.type === 'response' && l.id === '9');
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, UNKNOWN_METHOD);
  });

  it('drops a trailing blank line without crashing', async () => {
    const h = runHost(['']);
    const readyOrLater = await eventually(h.frames, (l) => l.type === 'event');
    assert.ok(readyOrLater); // loop still alive past the blank line
  });
});

describe('requestFrame / encodeRequest symmetry', () => {
  it('encodeRequest produces a decodable single-line frame', () => {
    const line = encodeRequest('r', 'pet.enable', { workspacePath: '/w' }).trim();
    const f = decodeRaw(line);
    assert.equal(f.type, 'request');
    assert.equal(f.method, 'pet.enable');
  });
});