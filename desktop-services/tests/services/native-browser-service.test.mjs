import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createNativeBrowserService, nativeBrowserScope } from '../../src/tooling/native-browser-service.mjs';

async function fixture(t) {
  const scope = nativeBrowserScope({ projectRoot: 'D:/native-test', conversationId: 'one' });
  const tabs = [{ id: 'root', label: 'native-root', marker: 'about:blank#trylo-native-native-root' }];
  const actions = [], native = [], events = [];
  let sequence = 0, activeLabel = 'native-root', zoom = 1, bounds = { x: 0, y: 0, width: 480, height: 640 };
  const dimensions = new Map(), emulationOwners = new Map();
  let metricsBarrier;
  const engine = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url?.startsWith('/json/version') ? { Browser: 'Chrome/test', webSocketDebuggerUrl: `ws://127.0.0.1:${engine.address().port}/browser` }
      : tabs.map(tab => ({ id: tab.id, type: 'page', title: tab.label, url: tab.marker, webSocketDebuggerUrl: `ws://127.0.0.1:${engine.address().port}/page/${tab.id}` }))));
  });
  const sockets = new WebSocketServer({ server: engine });
  sockets.on('connection', (ws, request) => {
    ws.once('close', () => { for (const [target, owner] of emulationOwners) if (owner === ws) { dimensions.delete(target); emulationOwners.delete(target); } });
    ws.on('message', async raw => {
    const command = JSON.parse(String(raw)); actions.push(command);
    if (command.method === 'Emulation.setDeviceMetricsOverride' && metricsBarrier) {
      const barrier = metricsBarrier; metricsBarrier = undefined; barrier.enter(); await barrier.wait;
    }
    const target = request.url?.split('/page/')[1] ?? 'root';
    if (command.method === 'Emulation.setDeviceMetricsOverride') { dimensions.set(target, { width: command.params.width, height: command.params.height }); emulationOwners.set(target, ws); }
    const result = command.method === 'Target.attachToTarget' ? { sessionId: 'attached-root' }
      : command.method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame-root' } } }
        : command.method === 'Page.createIsolatedWorld' ? { executionContextId: 7 }
          : command.method === 'Runtime.evaluate' ? { result: { value: command.params.expression.includes('innerWidth') ? dimensions.get(target) ?? { width: bounds.width, height: bounds.height } : 'native-root' } } : {};
    const failed = command.method === 'Input.dispatchMouseEvent' && command.params.type === 'invalid';
    ws.send(JSON.stringify({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), ...(failed ? { error: { message: 'invalid mouse event' } } : { result }) }));
    });
  });
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  const record = () => ({ scope, cdpPort: engine.address().port, tabs: tabs.map(({ label, marker }) => ({ label, marker })), activeLabel, bounds, zoom });
  const service = createNativeBrowserService({ emit: (topic, payload) => events.push({ topic, payload }), requestNative: async (key, operation, params) => {
    native.push({ key, operation, params });
    if (operation === 'layout' && params.bounds) bounds = params.bounds;
    if (operation === 'zoom') zoom = params.zoom;
    if (operation === 'create') { const id = `new-${++sequence}`; tabs.push({ id, label: id, marker: `about:blank#trylo-native-${id}` }); activeLabel = id; }
    if (operation === 'activate') activeLabel = params.label;
    if (operation === 'close') { const index = tabs.findIndex(tab => tab.label === params.label); tabs.splice(index, 1); if (activeLabel === params.label) activeLabel = tabs[0].label; }
    return record();
  } });
  t.after(async () => { await service.dispose(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve)); });
  const registration = await service.register({ projectRoot: 'D:/native-test', conversationId: 'one', record: record() });
  const endpoint = registration.endpoint;
  const post = async (route, value, signal) => {
    const result = await fetch(`${endpoint}/${route}`, { method: 'POST', body: JSON.stringify(value), signal });
    return { status: result.status, body: await result.json() };
  };
  return { service, scope, endpoint, record, native, actions, events, post,
    pauseMetrics: () => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
      metricsBarrier = { enter, wait }; return { entered, release };
    },
    dropMetrics: () => { for (const ws of new Set(emulationOwners.values())) ws.terminate(); } };
}
async function connect(endpoint) {
  const response = await fetch(`${endpoint}/json/version/`);
  const version = await response.json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  ws.on('message', raw => { const message = JSON.parse(String(raw)); pending.get(message.id)?.(message); pending.delete(message.id); });
  return { ws, send(method, params = {}, sessionId) { return new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); } };
}

test('Chrome gets a direct scoped WebSocket while unscoped discovery stays closed', async t => {
  const f = await fixture(t);
  const config = await f.service.configure({ packageId: 'chrome-devtools', projectRoot: 'D:/native-test', conversationId: 'one' });
  assert.deepEqual(config.args, ['--wsEndpoint', `${f.endpoint.replace('http:', 'ws:')}/cdp/browser`]);
  assert.equal((await fetch(`${new URL(f.endpoint).origin}/json/version`)).status, 404);
  const socket = new WebSocket(config.args[1]);
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const playwright = await f.service.configure({ packageId: 'playwright', projectRoot: 'D:/native-test', conversationId: 'one' });
  assert.deepEqual(playwright.args, ['--cdp-endpoint', `${f.endpoint}/`]);
  assert.equal(playwright.gate, config.gate);
});
test('takeover blocks new entire MCP calls and waits for the active lease to finish', async t => {
  const f = await fixture(t);
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  const { body: { leaseId } } = await f.post('lease/start', { clientId });
  assert.equal((await f.service.control({ scope: f.scope, heldByUser: true })).control, 'pending');
  let granted = false;
  const queued = f.post('lease/start', { clientId }).then(result => { granted = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(granted, false);
  await f.post('lease/end', { clientId, leaseId });
  assert.equal((await f.service.snapshot({ scope: f.scope })).control, 'user');
  assert.equal(granted, false, 'finishing an old call must not release the user hold');
  await f.service.control({ scope: f.scope, heldByUser: false });
  const next = await queued; assert.ok(next.body.leaseId);
  await f.post('lease/end', { clientId, leaseId: next.body.leaseId });
});

test('the agent cursor follows actual CDP input in an isolated world and clears at takeover', async t => {
  const f = await fixture(t), connection = await connect(f.endpoint); t.after(() => connection.ws.terminate());
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  const { body: { leaseId } } = await f.post('lease/start', { clientId });
  await connection.send('Target.attachToTarget', { targetId: 'root', flatten: true });
  const invalid = await connection.send('Input.dispatchMouseEvent', { type: 'invalid', x: 9, y: 8 }, 'attached-root');
  assert.match(invalid.error.message, /invalid mouse event/);
  assert.equal(f.actions.filter(action => action.method === 'Page.createIsolatedWorld').length, 0, 'failed input must not draw a successful interaction');
  const input = await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 90 }, 'attached-root');
  assert.ok(input.result, 'visual feedback must not block the real input response');
  const updates = () => f.actions.filter(action => action.method === 'Runtime.evaluate' && action.params.expression.includes('__tryloAgentCursorUpdate'));
  const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate()); };
  await waitFor(() => updates().length > 0);
  assert.match(updates()[0].params.expression, /"x":120,"y":90,"click":true/);
  assert.equal(updates()[0].params.contextId, 7);
  assert.equal(f.actions.find(action => action.method === 'Page.createIsolatedWorld').params.worldName, 'trylo-agent-cursor');
  await f.service.control({ scope: f.scope, heldByUser: true });
  await f.post('lease/end', { clientId, leaseId });
  await waitFor(() => updates().at(-1).params.expression.endsWith('(null)'));
  const before = updates().length;
  const rejected = await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 250 }, 'attached-root');
  assert.match(rejected.error.message, /已接管/);
  assert.equal(updates().length, before, 'rejected input must never manufacture a cursor movement');
});
test('tool failures and client disconnects settle leases without closing native contents', async t => {
  const f = await fixture(t);
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  await f.post('lease/start', { clientId });
  await f.service.control({ scope: f.scope, heldByUser: true });
  await f.post('client/close', { clientId });
  const snapshot = await f.service.snapshot({ scope: f.scope });
  assert.equal(snapshot.control, 'user'); assert.equal(snapshot.tabs.length, 1);
  assert.equal(f.native.some(action => action.operation === 'close'), false, 'an MCP exit must not close the Desktop-owned browser');
});
test('CDP creates, activates and closes the actual native targets instead of invisible pages', async t => {
  const f = await fixture(t), connection = await connect(f.endpoint); t.after(() => connection.ws.terminate());
  const created = await connection.send('Target.createTarget', { url: 'about:blank' });
  assert.equal(created.result.targetId, 'new-1');
  assert.equal(f.native.at(-1).operation, 'create');
  await connection.send('Target.activateTarget', { targetId: 'root' });
  assert.equal(f.native.at(-1).params.label, 'native-root');
  await connection.send('Target.closeTarget', { targetId: 'new-1' });
  assert.equal(f.native.at(-1).operation, 'close');
  assert.equal(f.actions.some(action => action.method === 'Target.createTarget'), false);
  const closed = await connection.send('Browser.close');
  assert.match(closed.error.message, /Trylo/);
  const emulated = await connection.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900 });
  assert.match(emulated.error.message, /不属于/);
});
test('unknown targets, foreign origins, wrong tokens and shared ports cannot cross conversation ownership', async t => {
  const f = await fixture(t), connection = await connect(f.endpoint); t.after(() => connection.ws.terminate());
  const result = await connection.send('Target.activateTarget', { targetId: 'other-task' });
  assert.match(result.error.message, /不属于/);
  assert.equal((await fetch(`${f.endpoint}/json/list`, { headers: { Origin: 'https://untrusted.test' } })).status, 403);
  assert.equal((await fetch(f.endpoint.replace(/\/[a-f0-9]+$/, '/wrong') + '/json/list')).status, 404);
  await assert.rejects(f.service.register({ projectRoot: 'D:/native-test', conversationId: 'other', record: { ...f.record(), scope: nativeBrowserScope({ projectRoot: 'D:/native-test', conversationId: 'other' }) } }), /另一个会话/);
});

test('the view follows the actual operated page and confirmed takeover rejects late input', async t => {
  const f = await fixture(t), connection = await connect(f.endpoint); t.after(() => connection.ws.terminate());
  await connection.send('Target.attachToTarget', { targetId: 'root', flatten: true });
  await connection.send('Target.createTarget', { url: 'about:blank' });
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  const { body: { leaseId } } = await f.post('lease/start', { clientId });
  await connection.send('Runtime.evaluate', { expression: 'document.title' }, 'attached-root');
  assert.equal(f.native.at(-1).operation, 'activate'); assert.equal(f.native.at(-1).params.label, 'native-root');
  assert.equal((await f.service.snapshot({ scope: f.scope })).activeLabel, 'native-root');
  await f.post('lease/end', { clientId, leaseId }); await f.service.control({ scope: f.scope, heldByUser: true });
  const before = f.actions.length;
  const input = await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 }, 'attached-root');
  assert.match(input.error.message, /已接管/); assert.equal(f.actions.length, before);
});
test('an aborted call waiting behind takeover is never granted later', async t => {
  const f = await fixture(t);
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  await f.service.control({ scope: f.scope, heldByUser: true });
  const abort = new AbortController();
  const waiting = f.post('lease/start', { clientId }, abort.signal).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 30)); abort.abort(); await waiting;
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.service.control({ scope: f.scope, heldByUser: false });
  assert.equal((await f.service.snapshot({ scope: f.scope })).inFlight, 0);
});

test('UI fixed viewport keeps page dimensions while fitting the same target to panel resizes', async t => {
  const f = await fixture(t);
  await f.service.layout({ scope: f.scope, bounds: { x: 10, y: 20, width: 480, height: 600 }, visible: true });
  const fixed = await f.service.viewport({ scope: f.scope, label: 'native-root', viewport: { mode: 'fixed', width: 1440, height: 900 } });
  assert.equal(fixed.viewport.mode, 'fixed'); assert.equal(fixed.viewport.width, 1440);
  assert.equal(fixed.viewport.scale, 1 / 3);
  const resized = await f.service.layout({ scope: f.scope, bounds: { x: 10, y: 20, width: 360, height: 500 }, visible: true });
  assert.equal(resized.viewport.width, 1440); assert.equal(resized.viewport.height, 900); assert.equal(resized.viewport.scale, 0.25);
  const reset = await f.service.viewport({ scope: f.scope, label: 'native-root', viewport: { mode: 'panel' } });
  assert.equal(reset.viewport.mode, 'panel'); assert.equal(reset.viewport.width, 360);
  assert.equal(f.native.some(action => action.operation === 'create'), false);
});

test('MCP resize reaches the same viewport owner and user takeover also rejects emulation', async t => {
  const f = await fixture(t), connection = await connect(f.endpoint); t.after(() => connection.ws.terminate());
  await f.service.layout({ scope: f.scope, bounds: { x: 0, y: 0, width: 400, height: 600 }, visible: true });
  await connection.send('Target.attachToTarget', { targetId: 'root', flatten: true });
  const resized = await connection.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, 'attached-root');
  assert.ok(resized.result, JSON.stringify(resized));
  assert.equal((await f.service.snapshot({ scope: f.scope })).viewport.width, 1440);
  await f.service.control({ scope: f.scope, heldByUser: true });
  const denied = await connection.send('Emulation.clearDeviceMetricsOverride', {}, 'attached-root');
  assert.match(denied.error.message, /已接管/);
  assert.equal((await f.service.snapshot({ scope: f.scope })).viewport.mode, 'fixed');
});

test('viewport changes are tab-scoped, bounded and refuse stale user targets', async t => {
  const f = await fixture(t);
  await f.service.layout({ scope: f.scope, bounds: { x: 0, y: 0, width: 480, height: 600 }, visible: true });
  await f.service.viewport({ scope: f.scope, label: 'native-root', viewport: { mode: 'fixed', width: 1440, height: 900 } });
  const created = await f.service.create({ scope: f.scope });
  assert.equal(created.viewport.mode, 'panel');
  await assert.rejects(f.service.viewport({ scope: f.scope, label: 'native-root', viewport: { mode: 'panel' } }), /已切换/);
  await assert.rejects(f.service.viewport({ scope: f.scope, label: created.activeLabel, viewport: { mode: 'fixed', width: NaN, height: 900 } }), /尺寸/);
  const selected = await f.service.select({ scope: f.scope, label: 'native-root' });
  assert.equal(selected.viewport.mode, 'fixed'); assert.equal(selected.viewport.width, 1440);
});

test('agent screenshot of another owned tab follows that actual native page', async t => {
  const f = await fixture(t), connection = await connect(f.endpoint); t.after(() => connection.ws.terminate());
  await connection.send('Target.attachToTarget', { targetId: 'root', flatten: true });
  await f.service.create({ scope: f.scope });
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  const { body: { leaseId } } = await f.post('lease/start', { clientId });
  assert.ok((await connection.send('Page.captureScreenshot', { format: 'png' }, 'attached-root')).result);
  assert.equal(f.record().activeLabel, 'native-root');
  await f.post('lease/end', { clientId, leaseId });
});

test('losing the metrics connection reports failure and a fresh sync restores the requested viewport', async t => {
  const f = await fixture(t);
  await f.service.viewport({ scope: f.scope, label: 'native-root', viewport: { mode: 'fixed', width: 1440, height: 900 } });
  f.dropMetrics();
  for (let i = 0; i < 100 && f.events.at(-1)?.payload.state !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.events.at(-1).payload.state, 'error');
  await fetch(`${f.endpoint}/json/list`);
  await f.service.control({ scope: f.scope, heldByUser: false });
  assert.equal(f.events.at(-1).payload.state, 'error', 'ordinary target discovery cannot clear an unapplied viewport failure');
  const recovered = await f.service.snapshot({ scope: f.scope });
  assert.equal(recovered.state, 'running'); assert.equal(recovered.viewport.width, 1440);
});

test('a new MCP call waits until a user viewport transaction has settled', async t => {
  const f = await fixture(t), barrier = f.pauseMetrics();
  const { body: { clientId } } = await f.post('client/open', { pid: process.pid });
  const changing = f.service.viewport({ scope: f.scope, label: 'native-root', viewport: { mode: 'fixed', width: 1440, height: 900 } });
  await barrier.entered;
  let granted = false;
  const lease = f.post('lease/start', { clientId }).then(result => { granted = true; return result.body.leaseId; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(granted, false);
  barrier.release(); await changing;
  const leaseId = await lease; assert.ok(leaseId);
  await f.post('lease/end', { clientId, leaseId });
});
