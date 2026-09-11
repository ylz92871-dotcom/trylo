// Trylo Desktop Services — pet channel status tests (audit §4.2 PET-P0-2).
//
// The regression this locks down: `pet.status` used to report
// `exeFound: platform === 'win32'` — a guess that said "found" on every
// Windows box even when TryloDesktopPet.exe was missing, so a pet that
// never appeared looked identical to a healthy one. Status must now be
// read back from the vendor bridge's own launch bookkeeping.
//
// These tests run the REAL host over in-memory stdio (no exe, no ports).
// node:test (spec §0 rule 5 — desktop-services never under vitest).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
// The sidecars dir must be pointed at a tree WITHOUT the companion exe so
// the "exe missing" branch is deterministic in CI.
const EMPTY_SIDECARS = path.join(repoRoot, 'desktop-services', 'tests', 'fixtures', 'empty-sidecars');

/** Run the real host on in-memory stdio with a controlled sidecars dir. */
function runHost({ sidecarsDir = EMPTY_SIDECARS, lines = [] } = {}) {
  const input = new Readable({ read() {} });
  let collected = '';
  const output = new Writable({
    write(chunk, _enc, cb) {
      collected += chunk.toString();
      cb();
    },
  });
  const originalSidecars = process.env.TRYLO_SIDECARS_DIR;
  if (sidecarsDir === null) delete process.env.TRYLO_SIDECARS_DIR;
  else process.env.TRYLO_SIDECARS_DIR = sidecarsDir;

  const host = createHost({ stdin: input, stdout: output, stderr: output, autoExit: false });
  host.start();
  for (const l of lines) input.push(`${l}\n`);

  const frames = () =>
    collected
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

  return {
    frames,
    push(line) {
      input.push(`${line}\n`);
    },
    restore() {
      if (originalSidecars === undefined) delete process.env.TRYLO_SIDECARS_DIR;
      else process.env.TRYLO_SIDECARS_DIR = originalSidecars;
    },
  };
}

async function eventually(framesFn, pred, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = framesFn().find(pred);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('frame never arrived within timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Imported lazily: `createHost` binds process.env at call time, and the
// learning services configure Hermes env on module load.
let createHost;
let PET_REASON;

const STATUS_KEYS = ['enabled', 'exeFound', 'launched', 'chatConnected', 'exePath', 'reasonCode'];

// The bridge only launches on win32; elsewhere it reports the platform. Both
// branches must be HONEST — that is what these tests lock down.
const ON_WINDOWS = process.platform === 'win32';

describe('pet.status: a real projection, not a platform guess', () => {
  beforeEach(async () => {
    ({ createHost } = await import('../src/host.mjs'));
    ({ PET_REASON } = await import('../src/pet/pet-channel.mjs'));
  });

  it('reports every status field on a failed bind', async () => {
    const h = runHost({
      lines: [JSON.stringify({ version: 1, type: 'request', id: 'e1', method: 'pet.enable', params: { workspacePath: '/w' } })],
    });
    try {
      const event = await eventually(h.frames, (f) => f.type === 'event' && f.topic === 'pet.status');
      for (const key of STATUS_KEYS) {
        assert.ok(key in event.payload, `pet.status is missing '${key}'`);
      }
      // No exe in the fixture tree: the status must SAY SO, not claim success.
      assert.equal(event.payload.exeFound, false);
      assert.equal(event.payload.launched, false);
      assert.equal(
        event.payload.reasonCode,
        ON_WINDOWS ? PET_REASON.EXE_NOT_FOUND : PET_REASON.UNSUPPORTED_PLATFORM,
      );
    } finally {
      h.restore();
    }
  });

  it('the enable response carries the same real status', async () => {
    const h = runHost({
      lines: [JSON.stringify({ version: 1, type: 'request', id: 'e2', method: 'pet.enable', params: { workspacePath: '/w' } })],
    });
    try {
      const response = await eventually(h.frames, (f) => f.type === 'response' && f.id === 'e2');
      assert.equal(response.ok, true);
      assert.equal(response.result.exeFound, false);
      assert.equal(
        response.result.reasonCode,
        ON_WINDOWS ? PET_REASON.EXE_NOT_FOUND : PET_REASON.UNSUPPORTED_PLATFORM,
      );
    } finally {
      h.restore();
    }
  });

  it('never claims launched:true without an exe', async () => {
    // The exact lie the audit found: `exeFound: platform === 'win32'`.
    const h = runHost({
      lines: [JSON.stringify({ version: 1, type: 'request', id: 'e3', method: 'pet.enable', params: { workspacePath: '/w' } })],
    });
    try {
      const event = await eventually(h.frames, (f) => f.type === 'event' && f.topic === 'pet.status');
      assert.equal(event.payload.launched, false, 'must not claim a launch that did not happen');
      assert.equal(event.payload.chatConnected, false);
    } finally {
      h.restore();
    }
  });

  it('a missing sidecars dir is reported as its own reason code', async () => {
    const h = runHost({
      sidecarsDir: null,
      lines: [JSON.stringify({ version: 1, type: 'request', id: 'e4', method: 'pet.enable', params: { workspacePath: '/w' } })],
    });
    try {
      const event = await eventually(h.frames, (f) => f.type === 'event' && f.topic === 'pet.status');
      assert.equal(event.payload.reasonCode, PET_REASON.NO_SIDECARS_DIR);
      // The enable RESPONSE must carry the same real cause — a generic
      // `bridge_unavailable` would hide why nothing launched.
      const response = await eventually(h.frames, (f) => f.type === 'response' && f.id === 'e4');
      assert.equal(response.result.reasonCode, PET_REASON.NO_SIDECARS_DIR);
    } finally {
      h.restore();
    }
  });

  it('pet.status is a QUERY, not just an event (audit PET-P0-1)', async () => {
    const h = runHost();
    try {
      h.push(JSON.stringify({ version: 1, type: 'request', id: 'q1', method: 'pet.status' }));
      const response = await eventually(h.frames, (f) => f.type === 'response' && f.id === 'q1');
      assert.equal(response.ok, true, 'pet.status must be queryable without a pet.enable first');
      for (const key of STATUS_KEYS) assert.ok(key in response.result, `missing '${key}'`);
      // Nothing has been enabled yet in this host instance.
      assert.equal(response.result.launched, false);
    } finally {
      h.restore();
    }
  });

  it('pet.disable resets the status to not_attempted', async () => {
    const h = runHost({
      lines: [
        JSON.stringify({ version: 1, type: 'request', id: 'd1', method: 'pet.enable', params: { workspacePath: '/w' } }),
      ],
    });
    try {
      await eventually(h.frames, (f) => f.type === 'event' && f.topic === 'pet.status');
      h.push(JSON.stringify({ version: 1, type: 'request', id: 'd2', method: 'pet.status' }));
      const afterEnable = await eventually(h.frames, (f) => f.type === 'response' && f.id === 'd2');
      // The bridge IS enabled even though the exe is missing (win32 only);
      // disable must flip that back so the UI never shows a stale "on".
      assert.equal(afterEnable.result.enabled, ON_WINDOWS);
      h.push(JSON.stringify({ version: 1, type: 'request', id: 'd3', method: 'pet.disable' }));
      h.push(JSON.stringify({ version: 1, type: 'request', id: 'd4', method: 'pet.status' }));
      const afterDisable = await eventually(h.frames, (f) => f.type === 'response' && f.id === 'd4');
      assert.equal(afterDisable.result.enabled, false);
      assert.equal(afterDisable.result.reasonCode, PET_REASON.NOT_ATTEMPTED);
    } finally {
      h.restore();
    }
  });
});

describe('host heartbeat (audit SH-P0-4): the shell owns the ping', () => {
  beforeEach(async () => {
    ({ createHost } = await import('../src/host.mjs'));
  });

  afterEach(() => {
    delete process.env.TRYLO_SERVICEHOST_SIDECAR_PING;
  });

  it('answers the shell ping with a pong', async () => {
    const h = runHost({ lines: [JSON.stringify({ version: 1, type: 'ping' })] });
    try {
      const pong = await eventually(h.frames, (f) => f.type === 'pong');
      assert.equal(pong.type, 'pong');
    } finally {
      h.restore();
    }
  });

  it('stays silent by default so only one side owns the heartbeat', async () => {
    // Two ping owners meant neither could detect the other's death: our
    // pings refreshed the shell's liveness timer even when we were wedged.
    const h = runHost();
    try {
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(
        h.frames().some((f) => f.type === 'ping'),
        false,
        'the sidecar must not self-ping unless explicitly opted in',
      );
    } finally {
      h.restore();
    }
  });
});
