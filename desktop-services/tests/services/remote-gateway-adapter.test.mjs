// node:test — remote gateway adapter (migration spec §8.1, arch §7.2/§7.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteAdapter, REMOTE_HANDLER_TIMEOUT_MS } from '../../src/remote/gateway-adapter.mjs';

/** Fake vendored gateway: records the createRemoteGateway options and exposes
 *  the registered handlers so tests can drive them exactly like the real
 *  gateway does. */
function fakeGatewayFactory() {
  let instance = null;
  const instances = [];
  const createRemoteGateway = (options) => {
    const created = {
      options,
      handlers: options.handlers || {},
      started: false,
      stopped: false,
      published: [],
      start: async () => {
        created.started = true;
        return { port: options.port };
      },
      stop: async () => {
        created.stopped = true;
      },
      publish: (payload) => created.published.push(payload),
      getPairingInfo: (publicUrl = '') => ({
        protocol: 1,
        service: 'trylo-remote',
        deviceId: 'dev1',
        deviceName: 'TEST-PC',
        workspaceName: options.workspaceName,
        baseUrl: publicUrl || `http://127.0.0.1:${options.port}`,
        token: options.authToken,
      }),
      get listening() {
        return created.started && !created.stopped;
      },
    };
    instances.push(created);
    instance = created;
    return created;
  };
  return { createRemoteGateway, get instance() { return instance; }, get instances() { return instances; } };
}

function fakeTunnel() {
  let running = false;
  return {
    start: async ({ mode, port }) => {
      running = true;
      return { mode, publicUrl: `https://quick-${port}.trycloudflare.com`, running: true };
    },
    stop: async () => {
      running = false;
      return { ok: true };
    },
    status: () => ({ running }),
  };
}

function fakeIdentity(token = 'identity-token-32-bytes-xxxxxxxxxxxxx') {
  let created = false;
  return {
    filePath: '/tmp/identity.json',
    loadOrCreate: async () => {
      created = true;
      return { version: 1, pairingToken: token, deviceSeed: 'MY-PC', updatedAt: 0 };
    },
    importLegacy: async () => ({ imported: false, skipped: true }),
    get created() { return created; },
  };
}

function fakeQRCode() {
  return { toDataURL: async () => 'data:image/png;base64,AAA' };
}

function adapterHarness(options = {}) {
  const events = [];
  const factory = fakeGatewayFactory();
  const tunnel = fakeTunnel();
  const identity = fakeIdentity(options.token);
  const adapter = createRemoteAdapter({
    identity,
    tunnel,
    emit: (topic, payload) => events.push({ topic, payload }),
    seam: { gateway: { createRemoteGateway: factory.createRemoteGateway }, qrcode: fakeQRCode() },
    handlerTimeoutMs: options.handlerTimeoutMs ?? 200,
    ...(options.extra ? options.extra : {}),
  });
  return { adapter, factory, tunnel, identity, events };
}

test('enable starts the gateway with the identity token and registered handlers', async () => {
  const { adapter, factory, identity } = adapterHarness();
  const status = await adapter.enable({ port: 49380, workspaceName: 'Trylo Code', tunnelMode: 'off' });
  assert.equal(status.ok, true);
  assert.equal(status.running, true);
  assert.equal(identity.created, true);
  const created = factory.instance;
  assert.equal(created.options.authToken, 'identity-token-32-bytes-xxxxxxxxxxxxx');
  assert.equal(created.options.host, '127.0.0.1');
  assert.equal(created.options.workspaceName, 'Trylo Code');
  assert.equal(created.options.deviceSeed, 'MY-PC');
  for (const name of ['projects', 'project', 'session', 'task', 'cancel', 'permission', 'chat', 'handoff', 'fun']) {
    assert.equal(typeof created.options.handlers[name], 'function', `handler ${name}`);
  }
});

test('a forwarded handler emits host.remoteRequest and resolves via remote.respond', async () => {
  const { adapter, factory, events } = adapterHarness();
  await adapter.enable({ tunnelMode: 'off' });
  const promise = factory.instance.options.handlers.projects({}, () => {});
  // The forward must have emitted an S→D request.
  const request = events.find((e) => e.topic === 'host.remoteRequest');
  assert.ok(request, 'host.remoteRequest emitted');
  assert.equal(request.payload.name, 'projects');
  assert.ok(request.payload.requestId);
  // Desktop answers.
  const respond = await adapter.respond({ requestId: request.payload.requestId, ok: true, result: { projects: [], activeProjectId: '' } });
  assert.equal(respond.ok, true);
  const result = await promise;
  assert.deepEqual(result, { projects: [], activeProjectId: '' });
});

test('a forwarded handler rejects when the Desktop answers with an error', async () => {
  const { adapter, factory, events } = adapterHarness();
  await adapter.enable({ tunnelMode: 'off' });
  const promise = factory.instance.options.handlers.task({ type: 'task_send', text: 'x' }, () => {});
  const request = events.find((e) => e.topic === 'host.remoteRequest');
  await adapter.respond({ requestId: request.payload.requestId, ok: false, error: { code: 'E', message: 'boom' } });
  await assert.rejects(() => promise, /boom/);
});

test('a forwarded handler times out when the Desktop never answers', async () => {
  const { adapter, factory, events } = adapterHarness({ handlerTimeoutMs: 50 });
  await adapter.enable({ tunnelMode: 'off' });
  const promise = factory.instance.options.handlers.cancel({}, () => {});
  assert.ok(events.find((e) => e.topic === 'host.remoteRequest'));
  await assert.rejects(() => promise, /timed out/);
});

test('fun handler always rejects with 501 (capability unavailable)', async () => {
  const { adapter, factory } = adapterHarness();
  await adapter.enable({ tunnelMode: 'off' });
  await assert.rejects(
    () => factory.instance.options.handlers.fun({ type: 'fun_state_request' }, () => {}),
    (err) => err.statusCode === 501,
  );
});

test('handoff stops the gateway (releases the port)', async () => {
  const { adapter, factory } = adapterHarness();
  await adapter.enable({ tunnelMode: 'off' });
  const result = await factory.instance.options.handlers.handoff({}, () => {});
  assert.equal(result.ok, true);
  // Stopped asynchronously (after the response frame flushes).
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(factory.instance.stopped, true);
  assert.equal(adapter.enabled, false);
});

test('publish forwards projection events to the gateway; fails when not running', async () => {
  const { adapter, factory } = adapterHarness();
  assert.equal((await adapter.publish({ type: 'agentState', state: 'idle' })).ok, false);
  await adapter.enable({ tunnelMode: 'off' });
  const ok = await adapter.publish({ type: 'agentState', state: 'idle' });
  assert.equal(ok.ok, true);
  assert.equal(factory.instance.published[0].state, 'idle');
});

test('pairingInfo returns pairing + QR data URL; fails when not running', async () => {
  const { adapter } = adapterHarness();
  await assert.rejects(() => adapter.pairingInfo(), /not running/);
  await adapter.enable({ tunnelMode: 'off' });
  const info = await adapter.pairingInfo();
  assert.equal(info.pairing.protocol, 1);
  assert.equal(info.pairing.service, 'trylo-remote');
  assert.equal(info.pairing.token, 'identity-token-32-bytes-xxxxxxxxxxxxx');
  assert.equal(info.pairing.baseUrl, 'http://127.0.0.1:49380');
  assert.equal(info.qrDataUrl, 'data:image/png;base64,AAA');
});

test('enable with a tunnel starts the tunnel and exposes its public URL', async () => {
  const { adapter, tunnel } = adapterHarness();
  const status = await adapter.enable({ port: 49380, tunnelMode: 'quick' });
  assert.equal(status.tunnelRunning, true);
  assert.equal(status.publicUrl, 'https://quick-49380.trycloudflare.com');
  assert.equal(tunnel.status().running, true);
  const info = await adapter.pairingInfo();
  assert.equal(info.pairing.baseUrl, 'https://quick-49380.trycloudflare.com');
});

test('disable stops the tunnel and the gateway, releasing the port', async () => {
  const { adapter, factory, tunnel } = adapterHarness();
  await adapter.enable({ tunnelMode: 'quick' });
  await adapter.disable();
  assert.equal(factory.instance.stopped, true);
  assert.equal(tunnel.status().running, false);
  assert.equal(adapter.enabled, false);
});

test('emitToHandler streams action_event payloads back on behalf of an in-flight handler', async () => {
  const { adapter, factory, events } = adapterHarness();
  await adapter.enable({ tunnelMode: 'off' });
  const received = [];
  const promise = factory.instance.options.handlers.task(
    { type: 'task_send', text: 'hi' },
    (payload) => received.push(payload),
  );
  const request = events.find((e) => e.topic === 'host.remoteRequest');
  assert.ok(request, 'forward emitted');
  const emitResult = await adapter.emitToHandler({
    requestId: request.payload.requestId,
    payload: { type: 'chat_delta', delta: 'hel' },
  });
  assert.equal(emitResult.ok, true);
  assert.deepEqual(received, [{ type: 'chat_delta', delta: 'hel' }]);
  // Unknown requestId is dropped, never thrown.
  assert.deepEqual(await adapter.emitToHandler({ requestId: 'nope', payload: {} }), { ok: false });
  // Resolve the in-flight handler so the test exits cleanly.
  await adapter.respond({ requestId: request.payload.requestId, ok: true, result: { accepted: true } });
  assert.deepEqual(await promise, { accepted: true });
});

test('unknown requestId in respond is reported, not thrown', async () => {
  const { adapter } = adapterHarness();
  const result = await adapter.respond({ requestId: 'nope', ok: true, result: {} });
  assert.deepEqual(result, { ok: false, error: 'unknown requestId' });
});
