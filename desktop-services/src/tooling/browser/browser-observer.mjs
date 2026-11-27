import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { createViewportBridge, viewportMetrics } from './viewport-bridge.mjs';

function scopeKey(scope) {
  return JSON.stringify([path.resolve(scope.projectRoot || '.').replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''), scope.conversationId || '']);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** The MCP process owns its browser. This observer only attaches to its scoped endpoint. */
export function createBrowserObserver({ storageRoot, emit, allocatePort = freePort, bridgeFactory = createViewportBridge }) {
  const endpoints = new Map();
  const providers = new Map();
  let selected = '';
  let timer;
  let generation = 0;
  let bridge;
  let connectedPort = 0;
  let readyTarget = '';
  const report = (state, detail = '') => emit?.('viewportStatus', { state, detail, scope: selected });
  const currentBridge = () => bridge;
  const endpointFile = key => path.join(storageRoot, 'browser-observer', `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.endpoint.json`);

  async function restoreEndpoint(key) {
    if (providers.has(key)) return;
    try {
      const saved = JSON.parse(await fsp.readFile(endpointFile(key), 'utf8'));
      if (!['playwright', 'chrome-devtools'].includes(saved.packageId)
        || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) return;
      if (providers.has(key)) return;
      providers.set(key, saved.packageId);
      endpoints.set(`${key}:${saved.packageId}`, Promise.resolve(saved.port));
    } catch { /* A conversation without a browser has no endpoint yet. */ }
  }

  async function configure({ packageId, projectRoot, conversationId }) {
    if (!['playwright', 'chrome-devtools'].includes(packageId)) return [];
    const key = scopeKey({ projectRoot, conversationId });
    const id = `${key}:${packageId}`;
    providers.set(key, packageId);
    if (!endpoints.has(id)) endpoints.set(id, Promise.resolve(allocatePort()));
    const port = await endpoints.get(id);
    await fsp.mkdir(path.dirname(endpointFile(key)), { recursive: true });
    await fsp.writeFile(endpointFile(key), JSON.stringify({ packageId, port }));
    if (packageId === 'chrome-devtools') {
      return ['--headless', '--viewport=1440x900', `--chromeArg=--remote-debugging-port=${port}`, '--chromeArg=--remote-debugging-address=127.0.0.1'];
    }
    const digest = crypto.createHash('sha256').update(`${id}:${port}`).digest('hex').slice(0, 24);
    const configFile = path.join(storageRoot, 'browser-observer', `${digest}.json`);
    await fsp.mkdir(path.dirname(configFile), { recursive: true });
    await fsp.writeFile(configFile, JSON.stringify({ browser: {
      browserName: 'chromium',
      launchOptions: { headless: true, channel: 'chromium', args: [
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      ] },
      contextOptions: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    } }));
    return ['--config', configFile];
  }

  async function watch(scope = {}) {
    const key = scopeKey(scope);
    if (selected === key && bridge?.state !== 'error') return { ok: true, alreadyRunning: true, cdpPort: bridge?.state === 'running' ? connectedPort : undefined };
    const stopping = stop();
    const version = generation;
    await stopping;
    if (version !== generation) return { ok: true };
    selected = key;
    // The panel's own box. The MCP launches its browser at its own landscape
    // size, so we re-emulate the page per session to make the frame match the
    // sidebar instead of letterboxing inside it.
    const bootViewport = viewportMetrics(scope.viewportWidth, scope.viewportHeight);
    await restoreEndpoint(key);
    if (version !== generation) return { ok: true };
    const observerBridge = bridgeFactory({ startTimeoutMs: 1500, emit: (topic, payload) => {
      if (version === generation) return emit?.(topic, { ...payload, scope: key });
    } });
    bridge = observerBridge;
    report('starting', '等待当前任务打开浏览器');
    const poll = async () => {
      if (version !== generation) return;
      if (observerBridge.terminalError) return;
      try {
        const candidates = [...endpoints.entries()].filter(([id]) => id === `${key}:${providers.get(key)}`);
        for (const [, portPromise] of candidates) {
          try {
          const port = await portPromise;
          const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
          const pages = await response.json();
          if (!response.ok || !pages.some(p => p.type === 'page')) continue;
          const page = pages.find(p => p.type === 'page' && p.url !== 'about:blank');
          if (!page) continue;
          if (!connectedPort && readyTarget !== page.id) { readyTarget = page.id; continue; }
          if (version !== generation) return;
          if (connectedPort !== port || observerBridge.state !== 'running') {
            await observerBridge.stop();
            const result = await observerBridge.start({ cdpPort: port, viewportWidth: bootViewport?.width, viewportHeight: bootViewport?.height });
            if (version !== generation) { await observerBridge.stop(); return; }
            if (result.ok) connectedPort = port;
          } else {
            await observerBridge.refreshTarget(pages);
          }
          break;
          } catch { /* Another configured provider may be the one in use. */ }
        }
      } catch { /* The MCP launches lazily; an absent endpoint is a waiting state. */ }
      if (version === generation) timer = setTimeout(poll, 650);
    };
    void poll();
    return { ok: true, scope: key };
  }
  async function stop() {
    generation++;
    clearTimeout(timer);
    selected = '';
    connectedPort = 0;
    readyTarget = '';
    const oldBridge = bridge;
    bridge = undefined;
    await oldBridge?.stop();
    return { ok: true };
  }
  async function resize(params = {}) {
    return (bridge?.state === 'running' ? bridge.resize(params) : { ok: false, reasonCode: 'not_running', error: 'observed browser is not running' });
  }
  return { configure, watch, stop, resize, currentBridge, scopeKey };
}
