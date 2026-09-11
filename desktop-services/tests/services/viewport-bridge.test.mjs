// Trylo Desktop Services — viewport bridge tests.
//
// The IDE-style embedded browser (fork of vscode-browser-preview's CDP
// screencast architecture). The network/spawn side is exercised live by the
// acceptance flows; here we pin the PURE pieces (target pick, coordinate
// mapping per the devtools-frontend InputModel math, URL normalization) and
// the failure contracts (no browser body → browser_not_installed; a dead
// CDP endpoint → start_failed, never a hang).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createViewportBridge,
  mapNormalizedPoint,
  normalizeNavigateUrl,
  pickPageTarget,
} from '../../src/tooling/viewport-bridge.mjs';

describe('pickPageTarget', () => {
  it('returns null for empty or malformed payloads', () => {
    assert.equal(pickPageTarget(null), null);
    assert.equal(pickPageTarget([]), null);
    assert.equal(pickPageTarget([{ type: 'iframe' }]), null);
    assert.equal(pickPageTarget([{ type: 'page', url: 'https://x' }]), null, 'missing ws url');
  });

  it('prefers a real page over devtools targets', () => {
    const target = pickPageTarget([
      { type: 'page', url: 'devtools://devtools/bundled', webSocketDebuggerUrl: 'ws://d' },
      { type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://p' },
    ]);
    assert.equal(target.url, 'https://example.com/');
  });

  it('accepts about:blank (the fresh tab this bridge opens)', () => {
    const target = pickPageTarget([
      { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://b' },
    ]);
    assert.equal(target.webSocketDebuggerUrl, 'ws://b');
  });
});

describe('mapNormalizedPoint (devtools-frontend InputModel math)', () => {
  const metadata = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 2 };

  it('scales normalized coordinates through deviceWidth / pageScaleFactor', () => {
    assert.deepEqual(mapNormalizedPoint(0.5, 0.5, metadata), { x: 320, y: 200 });
    assert.deepEqual(mapNormalizedPoint(0, 0, metadata), { x: 0, y: 0 });
    assert.deepEqual(mapNormalizedPoint(1, 1, metadata), { x: 640, y: 400 });
  });

  it('treats a missing pageScaleFactor as 1', () => {
    assert.deepEqual(
      mapNormalizedPoint(0.25, 0.75, { deviceWidth: 800, deviceHeight: 600 }),
      { x: 200, y: 450 },
    );
  });

  it('clamps out-of-range input and rejects dimensionless frames', () => {
    assert.equal(mapNormalizedPoint(0.5, 0.5, null), null);
    assert.equal(mapNormalizedPoint(0.5, 0.5, { deviceHeight: 10 }), null);
    const clamped = mapNormalizedPoint(-3, 9, metadata);
    assert.deepEqual(clamped, { x: 0, y: 400 });
  });
});

describe('normalizeNavigateUrl', () => {
  it('adds https to a bare domain', () => {
    assert.equal(normalizeNavigateUrl('example.com'), 'https://example.com');
  });

  it('keeps explicit schemes and about: pages', () => {
    assert.equal(normalizeNavigateUrl('http://a.b/'), 'http://a.b/');
    assert.equal(normalizeNavigateUrl('about:blank'), 'about:blank');
    assert.equal(normalizeNavigateUrl('file:///C:/x'), 'file:///C:/x');
  });

  it('rejects empties', () => {
    assert.equal(normalizeNavigateUrl(''), null);
    assert.equal(normalizeNavigateUrl('   '), null);
  });
});

describe('start failure contracts', () => {
  it('answers browser_not_installed (never throws) when no browser body exists', async () => {
    const events = [];
    const bridge = createViewportBridge({
      emit: (topic, payload) => events.push({ topic, payload }),
      probe: () => ({ ok: false, reasonCode: 'browser_not_installed', root: null, build: null }),
    });
    const result = await bridge.start();
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'browser_not_installed');
    assert.equal(bridge.state, 'error');
    assert.ok(events.some((e) => e.topic === 'viewportStatus' && e.payload.state === 'error'));
  });

  it('answers start_failed (never hangs) when the CDP endpoint is dead', async () => {
    const bridge = createViewportBridge({
      startTimeoutMs: 400,
      probe: () => ({ ok: true, reasonCode: 'browser_ok', root: 'R', build: 'chromium-1' }),
    });
    const result = await bridge.start({ cdpPort: 59999 });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, 'start_failed');
    assert.equal(bridge.state, 'error');
  });

  it('a failed start still allows a later stop (idempotent teardown)', async () => {
    const bridge = createViewportBridge({
      probe: () => ({ ok: false, reasonCode: 'browser_not_installed', root: null, build: null }),
    });
    await bridge.start();
    const stopped = await bridge.stop();
    assert.equal(stopped.ok, true);
    assert.equal(bridge.state, 'stopped');
  });
});
