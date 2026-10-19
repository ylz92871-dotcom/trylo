// Desktop owns the native views. This is a CDP adapter and an MCP-call gate,
// never a pixel transport. A held gate waits for whole tool calls to finish.
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createNativeBrowserCursor } from './native-browser-cursor.mjs';
import { createWorkspacePagePreview } from './workspace-page-preview.mjs';
import { createNativeViewport, viewportRequest } from './native-browser-viewport.mjs';
import { createViewportCdp } from './native-browser-cdp.mjs';
import { nativeDisplayInput } from './native-browser-input.mjs';

export function nativeBrowserScope({ projectRoot = '', conversationId = '' } = {}) {
  return JSON.stringify([path.resolve(projectRoot || '.').replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''), conversationId]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
async function body(request) {
  let data = '';
  for await (const part of request) {
    data += part;
    if (data.length > 65536) throw new Error('request too large');
  }
  return data ? JSON.parse(data) : {};
}
async function cdp(url, method, params = {}) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`CDP ${method} timed out`)); }, 5000);
    const finish = (error, result) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(result); };
    socket.once('error', error => finish(error));
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.id === 1) finish(message.error ? new Error(message.error.message) : null, message.result); });
  });
}

export function createNativeBrowserService({ emit, requestNative: injectedRequest } = {}) {
  const sessions = new Map(), pendingCommands = new Map(), preparations = new Map();
  let nextCommand = 0;
  const requestNative = injectedRequest ?? ((scope, operation, params = {}) => new Promise((resolve, reject) => {
    const id = `native-${++nextCommand}`;
    const timer = setTimeout(() => { pendingCommands.delete(id); reject(new Error('原生浏览器操作超时')); }, 20000);
    pendingCommands.set(id, { resolve, reject, timer });
    emit?.('nativeBrowserCommand', { id, scope, operation, ...params });
  }));
  function commandResult({ id, result, error } = {}) {
    const pending = pendingCommands.get(id);
    if (!pending) return { ok: false };
    pendingCommands.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error)); else pending.resolve(result);
    return { ok: true };
  }
  function state(session) {
    const failure = session.failed || session.viewport.error();
    return { ok: true, scope: session.scope, revision: session.revision = (session.revision ?? 0) + 1, state: failure ? 'error' : 'running', detail: failure || '',
      control: session.held ? session.leases.size ? 'pending' : 'user' : 'agent', inFlight: session.leases.size,
      activeLabel: session.record.activeLabel,
      viewport: session.viewport.snapshot(),
      tabs: [...session.targets].map(([id, tab]) => ({ id, label: tab.label, title: tab.title || '新标签页', url: tab.url || '', popup: session.record.tabs.find(native => native.label === tab.label)?.popup === true })) };
  }
  function report(session) {
    if (!session.leases.size && (session.held || !session.clients.size)) for (const cursor of session.cursors.values()) cursor.hide();
    emit?.('nativeBrowserState', state(session));
  }
  async function pages(session) {
    const response = await fetch(`http://127.0.0.1:${session.record.cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return (await response.json()).filter(page => page.type === 'page');
  }
  async function refresh(session) {
    const list = await pages(session);
    for (const page of list) {
      let label = session.targets.get(page.id)?.label;
      if (!label) {
        label = session.record.tabs.find(tab => tab.marker === page.url)?.label;
        if (!label) {
          try { label = (await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'globalThis.__tryloNativeView', returnByValue: true }))?.result?.value; } catch { /* target may be navigating */ }
        }
      }
      if (label && !session.record.tabs.some(tab => tab.label === label)) session.record = await requestNative(session.scope, 'ensure');
      if (session.record.tabs.some(tab => tab.label === label)) session.targets.set(page.id, { label, title: page.title, url: page.url, socket: page.webSocketDebuggerUrl });
    }
    const alive = new Set(list.map(page => page.id));
    for (const [id, target] of session.targets) if (!alive.has(id) || !session.record.tabs.some(tab => tab.label === target.label)) {
      session.targets.delete(id); void session.cursors.get(id)?.dispose(); session.cursors.delete(id);
    }
    session.failed = '';
    session.viewport?.retain(session.record.tabs.map(tab => tab.label));
    session.viewportCdp?.retain([...session.targets.values()].map(tab => tab.socket));
    return list;
  }
  async function nativeOperation(session, operation, params = {}) {
    const record = await requestNative(session.scope, operation, params);
    if (!record || record.scope !== session.scope || record.cdpPort !== session.record.cdpPort) throw new Error('原生浏览器会话不匹配');
    session.record = record;
    const deadline = Date.now() + 5000;
    do {
      await refresh(session);
      if (session.targets.size >= record.tabs.length) break;
      await pause(50);
    } while (Date.now() < deadline);
    if (!record.tabs.every(tab => [...session.targets.values()].some(target => target.label === tab.label))) throw new Error('原生标签页尚未连接');
    report(session);
    return record;
  }
  function serial(session, operation) {
    const task = (session.operations ?? Promise.resolve()).then(operation);
    session.operations = task.catch(() => { /* The initiating RPC/CDP request receives the failure. */ });
    return task;
  }
  function wake(session) {
    if (session.held) return;
    for (const waiter of [...session.waiters]) waiter();
  }
  async function serve(session, request, response) {
    if (request.headers.origin) return json(response, 403, { error: 'browser origins are not permitted' });
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    if (!route.startsWith(`/${session.token}/`)) return json(response, 404, { error: 'not found' });
    const action = route.slice(session.token.length + 2).replace(/\/+$/, '');
    if (request.method === 'GET' && ['json/version', 'json/list', 'json'].includes(action)) {
      if (action === 'json/version') {
        const version = await (await fetch(`http://127.0.0.1:${session.record.cdpPort}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
        return json(response, 200, { ...version, webSocketDebuggerUrl: `${session.wsBase}/browser` });
      }
      await refresh(session);
      return json(response, 200, [...session.targets].map(([id, tab]) => ({ id, type: 'page', title: tab.title, url: tab.url, webSocketDebuggerUrl: `${session.wsBase}/page/${id}` })));
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'not found' });
    const value = await body(request);
    if (action === 'client/open') {
      if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('invalid client pid');
      const clientId = crypto.randomUUID(); session.clients.set(clientId, value.pid);
      return json(response, 200, { clientId });
    }
    if (!session.clients.has(value.clientId)) return json(response, 403, { error: 'unknown MCP client' });
    if (action === 'preview/resolve') {
      if (session.leases.get(value.leaseId) !== value.clientId) return json(response, 403, { error: 'local preview requires an active MCP call' });
      return json(response, 200, { url: await session.preview.open(value.url) });
    }
    if (action === 'client/close') {
      session.clients.delete(value.clientId);
      for (const [id, owner] of session.leases) if (owner === value.clientId) session.leases.delete(id);
      report(session); return json(response, 200, { ok: true });
    }
    if (action === 'lease/end') {
      if (session.leases.get(value.leaseId) === value.clientId) session.leases.delete(value.leaseId);
      report(session); return json(response, 200, { ok: true });
    }
    if (action === 'lease/start') {
      const grant = () => {
        if (session.held || session.viewportChanging || response.destroyed || !session.clients.has(value.clientId)) return;
        session.waiters.delete(grant);
        const leaseId = crypto.randomUUID(); session.leases.set(leaseId, value.clientId);
        report(session); json(response, 200, { leaseId });
      };
      response.once('close', () => session.waiters.delete(grant));
      session.waiters.add(grant); grant(); return;
    }
    return json(response, 404, { error: 'not found' });
  }
  async function upgrade(session, request, socket, head) {
    if (request.headers.origin) { socket.destroy(); return; }
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    const prefix = `/${session.token}/cdp/`;
    if (!route.startsWith(prefix)) { socket.destroy(); return; }
    const target = route.slice(prefix.length);
    let upstreamUrl, defaultTarget;
    if (target === 'browser') {
      upstreamUrl = (await (await fetch(`http://127.0.0.1:${session.record.cdpPort}/json/version`, { signal: AbortSignal.timeout(3000) })).json()).webSocketDebuggerUrl;
    } else if (target.startsWith('page/')) {
      defaultTarget = target.slice(5); await refresh(session); upstreamUrl = session.targets.get(defaultTarget)?.socket;
    }
    if (!upstreamUrl) { socket.destroy(); return; }
    session.websockets.handleUpgrade(request, socket, head, downstream => {
      const upstream = new WebSocket(upstreamUrl, { maxPayload: 64 * 1024 * 1024 });
      session.connections.add(downstream); session.connections.add(upstream);
      const queue = [], pending = new Map(), attached = new Map(), inputReceipts = new Map();
      let interceptTail = Promise.resolve();
      const write = message => { if (downstream.readyState === WebSocket.OPEN) downstream.send(JSON.stringify(message)); };
      const feedback = message => {
        const targetId = attached.get(message.sessionId) ?? defaultTarget;
        const target = session.targets.get(targetId);
        const point = message.method === 'Input.dispatchMouseEvent' ? message.params : undefined;
        if (session.leases.size && target && Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
          for (const [id, cursor] of session.cursors) if (id !== targetId) cursor.hide();
          let cursor = session.cursors.get(targetId);
          if (!cursor) { cursor = createNativeBrowserCursor(target.socket); session.cursors.set(targetId, cursor); }
          cursor.show({ x: point.x, y: point.y, click: point.type === 'mousePressed' });
        }
      };
      const forward = message => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(message)); else queue.push(message); };
      upstream.once('open', () => { for (const message of queue.splice(0)) forward(message); });
      const finish = () => { for (const settle of inputReceipts.values()) settle(); inputReceipts.clear(); session.connections.delete(downstream); session.connections.delete(upstream); downstream.close(); upstream.close(); };
      upstream.once('error', finish); downstream.once('error', finish); upstream.once('close', finish); downstream.once('close', finish);
      upstream.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.method === 'Target.attachedToTarget') attached.set(message.params.sessionId, message.params.targetInfo.targetId);
        if (message.id !== undefined) {
          const sent = pending.get(message.id); pending.delete(message.id);
          inputReceipts.get(message.id)?.(); inputReceipts.delete(message.id);
          if (sent?.method === 'Target.attachToTarget' && message.result?.sessionId) attached.set(message.result.sessionId, sent.params.targetId);
          if (sent && !message.error) feedback(sent);
        }
        write(message);
      });
      downstream.on('message', raw => {
        let message; try { message = JSON.parse(String(raw)); } catch { return; }
        if (!Number.isInteger(message.id) || typeof message.method !== 'string') return;
        const metrics = ['Emulation.setDeviceMetricsOverride', 'Page.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride', 'Page.clearDeviceMetricsOverride'].includes(message.method);
        const mutating = metrics || /^(Input\.|Page\.(navigate.*|reload|stopLoading|handleJavaScriptDialog|setDocumentContent)$)/.test(message.method)
          || ['Target.createTarget', 'Target.closeTarget', 'Target.activateTarget', 'Page.bringToFront'].includes(message.method);
        if (mutating && session.held && session.leases.size === 0) {
          write({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: '你已接管浏览器，等待交回控制权' } }); return;
        }
        const intercept = metrics || ['Page.captureScreenshot', 'Target.createTarget', 'Target.closeTarget', 'Target.activateTarget', 'Page.bringToFront', 'Browser.close'].includes(message.method);
        if (!intercept) {
          // Reads and input after a resize must observe the committed dimensions.
          // Recheck takeover when the queued operation actually executes.
          interceptTail = interceptTail.then(() => serial(session, async () => {
            if (mutating && session.held && session.leases.size === 0) throw new Error('你已接管浏览器，等待交回控制权');
            const target = session.targets.get(attached.get(message.sessionId) ?? defaultTarget);
            if (session.leases.size && target && target.label !== session.record.activeLabel) {
              await nativeOperation(session, 'activate', { label: target.label });
              await session.viewport.sync(target.label);
            }
            if (target && session.viewport.error()) await session.viewport.sync(target.label);
            pending.set(message.id, message);
            const receipt = message.method.startsWith('Input.') ? new Promise(resolve => {
              const timer = setTimeout(() => { inputReceipts.delete(message.id); resolve(); }, 5000);
              inputReceipts.set(message.id, () => { clearTimeout(timer); resolve(); });
            }) : undefined;
            forward(nativeDisplayInput(message, session.viewport.snapshot(target?.label)));
            if (receipt) await receipt;
          })).catch(error => write({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: String(error.message ?? error) } }));
          return;
        }
        interceptTail = interceptTail.then(() => serial(session, async () => {
          let result;
          if (mutating && session.held && session.leases.size === 0) throw new Error('你已接管浏览器，等待交回控制权');
          if (message.method === 'Browser.close') throw new Error('浏览器由 Trylo 持有，请关闭对应标签页');
          if (message.method === 'Page.captureScreenshot') {
            const tab = session.targets.get(attached.get(message.sessionId) ?? defaultTarget);
            if (!tab) throw new Error('页面不属于当前原生浏览器会话');
            if (session.leases.size && tab.label !== session.record.activeLabel) {
              await nativeOperation(session, 'activate', { label: tab.label });
              await session.viewport.sync(tab.label);
            }
            result = await session.viewport.capture(tab.label, message.params);
          } else if (metrics) {
            const tab = session.targets.get(attached.get(message.sessionId) ?? defaultTarget);
            if (!tab) throw new Error('页面不属于当前原生浏览器会话');
            const input = message.method.endsWith('clearDeviceMetricsOverride') || message.params?.width === 0 && message.params?.height === 0
              ? { mode: 'panel' } : { ...message.params, mode: 'fixed' };
            viewportRequest(input);
            if (tab.label !== session.record.activeLabel) await nativeOperation(session, 'activate', { label: tab.label });
            await session.viewport.set(tab.label, input); report(session); result = {};
          } else if (message.method === 'Target.createTarget') {
            // Create an actual native view first. Never let CDP create an invisible tab.
            const record = await nativeOperation(session, 'create');
            await session.viewport.sync(record.activeLabel);
            const created = [...session.targets].find(([, tab]) => tab.label === record.activeLabel);
            if (!created) throw new Error('新原生标签页未连接');
            if (message.params?.url && message.params.url !== 'about:blank') await cdp(created[1].socket, 'Page.navigate', { url: message.params.url });
            result = { targetId: created[0] };
          } else {
            const id = message.params?.targetId ?? attached.get(message.sessionId) ?? defaultTarget;
            await refresh(session);
            const tab = session.targets.get(id);
            if (!tab) throw new Error('页面不属于当前原生浏览器会话');
            await nativeOperation(session, message.method === 'Target.closeTarget' ? 'close' : 'activate', { label: tab.label });
            await session.viewport.sync(session.record.activeLabel);
            result = message.method === 'Target.closeTarget' ? { success: true } : {};
          }
          write({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result });
        })).catch(error => write({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: String(error.message ?? error) } }));
      });
    });
  }
  async function register({ projectRoot, conversationId, record } = {}) {
    const scope = nativeBrowserScope({ projectRoot, conversationId });
    if (!conversationId || record?.scope !== scope || !Number.isInteger(record?.cdpPort) || record.cdpPort < 1 || record.cdpPort > 65535 || !record.tabs?.length) throw new Error('原生浏览器注册参数无效');
    if ([...sessions.values()].some(session => session.scope !== scope && session.record.cdpPort === record.cdpPort)) throw new Error('浏览器端口已属于另一个会话');
    let session = sessions.get(scope);
    if (session && session.record.cdpPort === record.cdpPort) { session.record = record; await refresh(session); report(session); return { ...state(session), endpoint: session.base }; }
    if (session) await disposeSession(session);
    session = { scope, record, preview: createWorkspacePagePreview(path.resolve(projectRoot)), targets: new Map(), cursors: new Map(), held: false, leases: new Map(), waiters: new Set(), clients: new Map(), token: crypto.randomBytes(24).toString('hex'), failed: '', connections: new Set() };
    session.viewportCdp = createViewportCdp({ onDisconnect: () => { session.viewport.invalidate(); report(session); } });
    session.viewport = createNativeViewport({ record: () => session.record,
      target: label => [...session.targets.values()].find(tab => tab.label === label),
      native: (operation, params) => nativeOperation(session, operation, params), cdp: session.viewportCdp.send });
    session.server = http.createServer((request, response) => void serve(session, request, response).catch(error => { if (!response.headersSent) json(response, 500, { error: String(error.message ?? error) }); else response.destroy(); }));
    session.websockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    session.server.on('upgrade', (request, socket, head) => void upgrade(session, request, socket, head).catch(() => socket.destroy()));
    await new Promise((resolve, reject) => { session.server.once('error', reject); session.server.listen(0, '127.0.0.1', resolve); });
    session.base = `http://127.0.0.1:${session.server.address().port}/${session.token}`;
    session.wsBase = session.base.replace('http:', 'ws:') + '/cdp';
    sessions.set(scope, session);
    try {
      const deadline = Date.now() + 10000;
      let lastError;
      do {
        try { await refresh(session); if (session.targets.size) break; } catch (error) { lastError = error; }
        await pause(100);
      } while (Date.now() < deadline);
      if (!session.targets.size) throw new Error(lastError?.message ?? '原生浏览器页面未连接');
    }
    catch (error) { await disposeSession(session); sessions.delete(scope); throw error; }
    session.timer = setInterval(() => {
      for (const [clientId, pid] of session.clients) {
        try { process.kill(pid, 0); } catch (error) {
          if (error.code !== 'ESRCH') continue;
          session.clients.delete(clientId);
          for (const [id, owner] of session.leases) if (owner === clientId) session.leases.delete(id);
          report(session);
        }
      }
    }, 1000);
    session.timer.unref(); report(session);
    return { ...state(session), endpoint: session.base };
  }
  function get(scope) { const session = sessions.get(scope); if (!session) throw new Error('原生浏览器尚未连接'); return session; }
  async function control({ scope, heldByUser } = {}) {
    const session = get(scope); session.held = heldByUser === true; report(session); wake(session); return state(session);
  }
  async function snapshot({ scope } = {}) { const session = get(scope); return serial(session, async () => {
    try { session.record = await requestNative(scope, 'ensure'); await refresh(session); await session.viewport.sync(session.record.activeLabel); }
    catch (error) { session.failed = String(error.message ?? error); }
    return state(session);
  }); }
  async function configure({ packageId, projectRoot, conversationId } = {}) {
    const scope = nativeBrowserScope({ projectRoot, conversationId });
    if (preparations.has(scope)) await preparations.get(scope);
    if (!sessions.has(scope)) {
      const preparing = (async () => {
        const record = await requestNative(scope, 'ensure');
        await register({ projectRoot, conversationId, record });
      })();
      preparations.set(scope, preparing);
      try { await preparing; } finally { preparations.delete(scope); }
    }
    const session = get(scope);
    // Puppeteer resolves /json/version at the origin, discarding our scoped
    // token path. Its direct WebSocket option preserves the session boundary.
    return { endpoint: session.base + '/', gate: session.base, args: packageId === 'playwright' ? ['--cdp-endpoint', session.base + '/'] : ['--wsEndpoint', `${session.wsBase}/browser`] };
  }
  async function open(params = {}) { await configure({ ...params, packageId: 'playwright' }); return snapshot({ scope: nativeBrowserScope(params) }); }
  async function select({ scope, label } = {}) { const session = get(scope); return serial(session, async () => { await nativeOperation(session, 'activate', { label }); await session.viewport.sync(label); report(session); return state(session); }); }
  async function create({ scope } = {}) { const session = get(scope); return serial(session, async () => { await nativeOperation(session, 'create'); await session.viewport.sync(session.record.activeLabel); report(session); return state(session); }); }
  async function layout({ scope, bounds, visible } = {}) { const session = get(scope); return serial(session, async () => {
    if (typeof visible !== 'boolean') throw new Error('浏览器显示状态无效');
    try { await session.viewport.layout(bounds, visible); } finally { report(session); }
    return state(session);
  }); }
  async function viewport({ scope, label, viewport: input } = {}) { const session = get(scope); return serial(session, async () => {
    if (session.record.activeLabel !== label) throw new Error('页面已切换，请在当前标签页重新设置尺寸');
    if (session.leases.size > 0) throw new Error('等待当前浏览器操作结束后再设置页面尺寸');
    session.viewportChanging = true;
    try { await session.viewport.set(label, input); } finally { session.viewportChanging = false; report(session); wake(session); }
    return state(session);
  }); }
  async function disposeSession(session) {
    session.viewportCdp.dispose();
    await session.preview.dispose();
    clearInterval(session.timer); session.held = true;
    await Promise.all([...session.cursors.values()].map(cursor => cursor.dispose()));
    for (const connection of session.connections) connection.terminate();
    session.server.closeAllConnections(); session.websockets.close();
    await new Promise(resolve => session.server.close(resolve));
  }
  async function dispose() {
    for (const pending of pendingCommands.values()) { clearTimeout(pending.timer); pending.reject(new Error('原生浏览器服务已停止')); }
    pendingCommands.clear(); await Promise.all([...sessions.values()].map(disposeSession)); sessions.clear();
  }
  return { register, configure, open, control, snapshot, select, create, layout, viewport, commandResult, dispose, nativeBrowserScope };
}
