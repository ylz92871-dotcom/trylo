import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createViewportBridge } from '../../src/tooling/browser/viewport-bridge.mjs';

it('exposes terminal transport failure and resets it only on a fresh start', async () => {
  const originalSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  class Socket {
    readyState = 1;
    handlers = new Map();
    constructor() { queueMicrotask(() => this.fire('open', {})); }
    addEventListener(name, callback) {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(callback);
      this.handlers.set(name, handlers);
    }
    fire(name, event) { for (const handler of this.handlers.get(name) ?? []) handler(event); }
    send(raw) {
      const message = JSON.parse(raw);
      const result = message.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } }
        : message.method === 'Runtime.evaluate' ? { result: { value: true } } : {};
      queueMicrotask(() => this.fire('message', { data: JSON.stringify({ id: message.id, result }) }));
      if (message.method === 'Page.startScreencast') {
        queueMicrotask(() => this.fire('message', { data: JSON.stringify({ method: 'Page.screencastFrame', params: {
          data: 'iVBOR-small-frame', metadata: { deviceWidth: 100, deviceHeight: 100 }, sessionId: 1,
        } }) }));
      }
    }
    close() { this.readyState = 3; this.fire('close', {}); }
  }
  let fail = true;
  const bridge = createViewportBridge({ emit: async topic => {
    if (topic === 'viewportFrame' && fail) throw new Error('host transport closed');
  } });
  globalThis.WebSocket = Socket;
  globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('/json/list')
    ? [{ id: 'page', type: 'page', url: 'https://fixture.test/', webSocketDebuggerUrl: 'ws://mock' }] : {} });
  try {
    assert.equal(bridge.terminalError, false);
    assert.equal((await bridge.start({ cdpPort: 1111 })).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge.terminalError, true);
    assert.equal(bridge.state, 'error');
    fail = false;
    assert.equal((await bridge.start({ cdpPort: 1111 })).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge.terminalError, false);
    assert.equal(bridge.state, 'running');
  } finally {
    await bridge.stop();
    globalThis.WebSocket = originalSocket;
    globalThis.fetch = originalFetch;
  }
});
