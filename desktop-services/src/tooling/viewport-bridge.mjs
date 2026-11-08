// Trylo Desktop Services — Viewport bridge (IDE-style embedded browser panel).
//
// Architecture forked from auchenberg/vscode-browser-preview (MIT, deprecated
// but the closest open-source twin of this feature): a Trylo-managed Chromium
// driven over the DevTools protocol, `Page.startScreencast` frames streamed
// to the renderer canvas, input events forwarded back as CDP `Input` domain
// calls. Coordinate/zoom math follows Chromium's own
// devtools-frontend/front_end/panels/screencast/InputModel.ts (BSD).
//
// With cdpPort this bridge only observes the MCP-owned browser. Disconnecting
// never kills it. The unscoped legacy start still owns its separate browser.
//
// Failure policy: never throws across the RPC surface; every failure is
// `{ ok:false, reasonCode }` plus a `viewportStatus` event the panel shows.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { stopViewportProcess } from './stop-viewport-process.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { probePlaywrightChromium } from './tool-browser-condition.mjs';
import { activePageTarget } from './browser-target.mjs';
import { createBrowserActivity } from './browser-activity.mjs';
import { createScreencastStream } from './screencast-stream.mjs';

const START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

/** Resolve the chrome.exe inside a probed build — the platform folder name
 *  depends on the playwright generation (1.49+ ships `chrome-win64/`,
 *  older releases `chrome-win/`), so check both. */
function chromiumExecutable(root, build) {
  for (const platformDir of ['chrome-win64', 'chrome-win']) {
    const exe = path.join(root, build, platformDir, 'chrome.exe');
    try {
      if (fs.statSync(exe).isFile()) return exe;
    } catch { /* try the next layout */ }
  }
  return null;
}

/** Pure: pick the first usable page target from a /json/list payload. */
export function pickPageTarget(targets) {
  if (!Array.isArray(targets)) return null;
  const pages = targets.filter(
    (t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string' && t.webSocketDebuggerUrl !== '',
  );
  // Prefer a real page over devtools/extension targets; about:blank (the
  // fresh tab this bridge opens) is a fine first target.
  return pages.find((t) => !String(t.url).startsWith('devtools://')) ?? pages[0] ?? null;
}

/** Pure: panel-normalized [0..1] coordinates + screencast metadata → CDP
 *  `Input` domain CSS-pixel coordinates. The frame covers the visual
 *  viewport: cssWidth = deviceWidth / pageScaleFactor. */
export function mapNormalizedPoint(nx, ny, metadata) {
  const deviceWidth = Number(metadata?.deviceWidth) || 0;
  const deviceHeight = Number(metadata?.deviceHeight) || 0;
  const scale = Number(metadata?.pageScaleFactor) || 1;
  if (deviceWidth <= 0 || deviceHeight <= 0) return null;
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  return {
    x: (clamp01(nx) * deviceWidth) / scale,
    y: (clamp01(ny) * deviceHeight) / scale,
  };
}

/** Pure: a user-typed URL. A missing scheme gets https — a bare "example.com"
 *  must not resolve as a search or a file:// path. */
export function normalizeNavigateUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('about:') || value.startsWith('file:')) {
    return value;
  }
  return `https://${value}`;
}

/** Pure: the panel's CSS-pixel size → a `setDeviceMetricsOverride` payload.
 *  The screencast frame must match the panel's aspect, otherwise "fit"
 *  letterboxes the page inside the panel instead of filling it. A hardcoded
 *  landscape window made a portrait sidebar mostly empty, so the panel
 *  reports its own size and the page is emulated to match exactly. */
export function viewportMetrics(width, height, deviceScaleFactor = 1) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  const scale = Number(deviceScaleFactor) > 0 ? Number(deviceScaleFactor) : 1;
  return {
    width: Math.min(w, 16384),
    height: Math.min(h, 16384),
    deviceScaleFactor: scale,
    mobile: false,
    screenWidth: Math.min(w, 16384),
    screenHeight: Math.min(h, 16384),
  };
}

export function createViewportBridge({ log = null, emit = null, storageRoot = '', probe = probePlaywrightChromium, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  let state = 'stopped'; // stopped | starting | running | error
  let child = null;
  let childStop = null;
  let ws = null;
  let cdpPort = 0;
  let currentUrl = '';
  let startingPromise = null;
  let cdpNextId = 1;
  let profileDir = null;
  const pendingCdp = new Map();
  let lastFrameMetadata = null;
  let currentTargetId = '';
  let reconnecting = false;
  let activity = null;
  let screencast = null;
  let terminalError = false;
  let lastViewport = null;

  const logLine = (message) => { try { log?.(`viewport: ${message}`); } catch { /* best effort */ } };

  function report(nextState, detail = '') {
    state = nextState;
    try {
      emit?.('viewportStatus', { state, detail, url: currentUrl, targetId: currentTargetId || undefined });
    } catch { /* best effort */ }
  }

  /** One free TCP port (tiny race between close and chrome's bind is
   *  acceptable for a local panel; the DevTools poll below is the gate). */
  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
  }

  function cdpSend(method, params = {}) {
    return new Promise((resolve, reject) => {
      // readyState — NOT the bridge state: Page.enable/startScreencast are
      // sent while the bridge itself is still 'starting', before
      // report('running') flips the state machine.
      if (!ws || ws.readyState !== 1) {
        reject(new Error('viewport ws not connected'));
        return;
      }
      const id = cdpNextId++;
      pendingCdp.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pendingCdp.delete(id);
        reject(error);
      }
    });
  }

  function handleCdpMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = pendingCdp.get(message.id);
      if (!pending) return;
      pendingCdp.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'cdp error'));
      else pending.resolve(message.result);
      return;
    }
    activity?.handle(message);
    switch (message.method) {
      case 'Page.screencastFrame': {
        lastFrameMetadata = message.params?.metadata ?? null;
        void screencast?.receive(message.params);
        break;
      }
      case 'Page.frameNavigated': {
        const url = message.params?.frame?.url;
        if (typeof url === 'string' && !message.params?.frame?.parentId) {
          currentUrl = url;
          if (!terminalError) report('running');
        }
        break;
      }
      default:
        break;
    }
  }

  function closeWebSocket() {
    screencast?.dispose();
    screencast = null;
    activity?.dispose();
    activity = null;
    if (ws) {
      try { ws.close(); } catch { /* already gone */ }
      ws = null;
    }
    for (const pending of pendingCdp.values()) pending.reject(new Error('viewport stopped'));
    pendingCdp.clear();
  }

  async function connectToPageTarget(port, suppliedTarget) {
    const list = suppliedTarget ? [] : await fetchJson(`http://127.0.0.1:${port}/json/list`, START_TIMEOUT_MS);
    const target = suppliedTarget ?? await activePageTarget(list);
    if (!target) throw new Error('no page target on the DevTools endpoint');
    currentTargetId = target.id;
    currentUrl = String(target.url ?? 'about:blank');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('viewport ws connect timeout')), 5_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('viewport ws connect failed')); }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      if (ws !== socket) return;
      const data = event.data;
      if (typeof data === 'string') handleCdpMessage(data);
      else if (data instanceof ArrayBuffer) handleCdpMessage(new TextDecoder().decode(data));
      else if (typeof Blob !== 'undefined' && data instanceof Blob) data.text().then(raw => {
        if (ws === socket) handleCdpMessage(raw);
      }).catch(() => {});
    });
    socket.addEventListener('close', () => {
      if (ws === socket && state === 'running') report('stopped', '浏览器会话已关闭');
    });
    ws = socket;

    await cdpSend('Page.enable');
    activity = createBrowserActivity({ emit, log: logLine });
    await activity.install(cdpSend).catch(error => logLine(`activity unavailable: ${error?.message ?? error}`));
    screencast = createScreencastStream({
      send: cdpSend,
      emit: (topic, payload) => emit?.(topic, { ...payload, targetId: target.id, url: currentUrl }),
      isCurrent: () => ws === socket && socket.readyState === 1,
      ack: sessionId => {
        try { socket.send(JSON.stringify({ id: 0, method: 'Page.screencastFrameAck', params: { sessionId } })); } catch { /* Disconnected. */ }
      },
      onError: detail => { terminalError = true; report('error', detail); },
    });
    await screencast.start();
  }

  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function killChild() {
    const processToKill = child;
    if (!processToKill) return;
    if (childStop) return childStop;
    const stopping = stopViewportProcess(processToKill).then(() => {
      if (child === processToKill) child = null;
    });
    childStop = stopping;
    try { await stopping; }
    finally { if (childStop === stopping) childStop = null; }
  }

  /** `tooling.viewportStart`. Idempotent: a running bridge answers with its
   *  current coordinates instead of spawning a second browser. */
  async function start(params = {}) {
    if (state === 'running') return { ok: true, cdpPort, url: currentUrl, alreadyRunning: true };
    if (state === 'starting') return startingPromise ?? { ok: false, reasonCode: 'start_failed', error: 'start already in flight' };
    if (child) return { ok: false, reasonCode: 'start_failed', error: 'Previous browser stop is unconfirmed; retry Stop.' };

    terminalError = false;
    report('starting');
    startingPromise = (async () => {
      try {
        const attachPort = Number(params.cdpPort) || 0;
        if (attachPort > 0) {
          cdpPort = attachPort;
        } else {
          const browser = probe();
          if (!browser.ok || !browser.root || !browser.build) {
            report('error', 'browser_not_installed');
            return {
              ok: false,
              reasonCode: 'browser_not_installed',
              error: 'panel browser (Chromium) is not installed — install the Playwright browser body first',
            };
          }
          const executable = chromiumExecutable(browser.root, browser.build);
          if (!executable) {
            report('error', 'browser_binary_missing');
            return {
              ok: false,
              reasonCode: 'browser_binary_missing',
              error: 'the probed chromium build has no chrome.exe — reinstall the Playwright browser body',
            };
          }
          cdpPort = await freePort();
          // A PER-SESSION profile dir: a stale browser left on a shared dir
          // would make the new chrome delegate-and-exit (silent start
          // death). Sweep the dir again on stop.
          profileDir = path.join(storageRoot || '.', `viewport-profile-${process.pid}-${Date.now()}`);
          await fsp.mkdir(profileDir, { recursive: true });
          const ownedChild = spawn(executable, [
            `--remote-debugging-port=${cdpPort}`,
            `--user-data-dir=${profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            // The panel streams screencast frames: without these, Chrome
            // throttles/occludes the (possibly unfocused) window and the
            // damage-driven stream goes silent after the first paint.
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-features=CalculateNativeWinOcclusion',
            '--window-size=1280,800',
            'about:blank',
          ], { stdio: 'ignore', windowsHide: true });
          child = ownedChild;
          ownedChild.on('exit', () => {
            if (child !== ownedChild) return;
            child = null;
            if (state === 'running' || state === 'starting') {
              closeWebSocket();
              report('stopped', '浏览器已退出');
            }
          });
          ownedChild.on('error', (error) => logLine(`spawn failed: ${error?.message ?? error}`));
        }

        // The DevTools HTTP endpoint is the real readiness gate.
        const deadline = Date.now() + startTimeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`, POLL_INTERVAL_MS);
            ready = true;
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        }
        if (!ready) throw new Error('DevTools endpoint did not come up in time');

        await connectToPageTarget(cdpPort);
        // Emulate the panel's own size so the frame's aspect matches the box it
        // is shown in. Without this the page keeps the spawn window's landscape
        // aspect and "fit" leaves the sidebar mostly empty.
        const bootMetrics = viewportMetrics(params.viewportWidth, params.viewportHeight);
        if (bootMetrics) {
          try {
            await cdpSend('Emulation.setDeviceMetricsOverride', bootMetrics);
            lastViewport = bootMetrics;
          } catch (error) {
            logLine(`viewport metrics override failed: ${String(error?.message ?? error).slice(0, 120)}`);
          }
        }
        if (!terminalError) report('running');
        return { ok: true, cdpPort, url: currentUrl };
      } catch (error) {
        closeWebSocket();
        try { await killChild(); }
        catch (cleanup) {
          report('error', String(cleanup?.message ?? cleanup).slice(0, 200));
          return { ok: false, reasonCode: 'start_failed', error: String(error?.message ?? error).slice(0, 200),
            cleanupError: String(cleanup?.message ?? cleanup).slice(0, 200) };
        }
        report('error', String(error?.message ?? error).slice(0, 200));
        return { ok: false, reasonCode: 'start_failed', error: String(error?.message ?? error).slice(0, 200) };
      } finally {
        startingPromise = null;
      }
    })();
    return startingPromise;
  }

  /** `tooling.viewportResize` — the panel changed size (drag-resize, window
   *  resize, sidebar width change). Re-emulating the page to the new box is
   *  what makes the picture fill the panel instead of letterboxing. No-op
   *  when the size is unchanged or the browser is not up yet. */
  async function resize(params = {}) {
    if (state !== 'running') return { ok: false, reasonCode: 'not_running', error: 'panel browser is not running' };
    const metrics = viewportMetrics(params.width, params.height, params.deviceScaleFactor);
    if (!metrics) return { ok: false, reasonCode: 'bad_size', error: 'a positive width/height is required' };
    if (lastViewport && lastViewport.width === metrics.width && lastViewport.height === metrics.height) {
      return { ok: true, ...metrics, unchanged: true };
    }
    try {
      await cdpSend('Emulation.setDeviceMetricsOverride', metrics);
      lastViewport = metrics;
      return { ok: true, ...metrics };
    } catch (error) {
      return { ok: false, reasonCode: 'resize_failed', error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /** `tooling.viewportNavigate`. */
  async function navigate(params = {}) {
    if (state !== 'running') return { ok: false, reasonCode: 'not_running', error: 'panel browser is not running' };
    const url = normalizeNavigateUrl(params.url);
    if (!url) return { ok: false, reasonCode: 'bad_url', error: 'a url is required' };
    try {
      await cdpSend('Page.navigate', { url });
      return { ok: true, url };
    } catch (error) {
      return { ok: false, reasonCode: 'navigate_failed', error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /** `tooling.viewportInput` — the USER's hand on the panel browser (the
   *  human is the authority here; agent input keeps going through the MCP
   *  approval pipeline). Coordinates arrive normalized to the latest frame. */
  async function input(params = {}) {
    if (state !== 'running') return { ok: false, reasonCode: 'not_running', error: 'panel browser is not running' };
    const metadata = lastFrameMetadata;
    if (!metadata) return { ok: false, reasonCode: 'no_frame', error: 'no frame received yet' };
    try {
      switch (params.kind) {
        case 'mouse': {
          const point = mapNormalizedPoint(params.x, params.y, metadata);
          if (!point) return { ok: false, reasonCode: 'no_frame', error: 'frame has no dimensions' };
          const button = params.button === 'right' ? 'right' : 'left';
          const action = params.action === 'moved' ? 'mouseMoved' : params.action === 'released' ? 'mouseReleased' : 'mousePressed';
          await cdpSend('Input.dispatchMouseEvent', {
            type: action,
            x: point.x,
            y: point.y,
            button: action === 'mouseMoved' ? 'none' : button,
            ...(action !== 'mouseMoved' ? { clickCount: 1 } : {}),
          });
          return { ok: true };
        }
        case 'wheel': {
          const point = mapNormalizedPoint(params.x, params.y, metadata);
          if (!point) return { ok: false, reasonCode: 'no_frame', error: 'frame has no dimensions' };
          const factor = (Number(metadata.deviceWidth) || 0) / (Number(metadata.pageScaleFactor) || 1);
          await cdpSend('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: point.x,
            y: point.y,
            deltaX: -(Number(params.deltaY) || 0) * 0.05 * factor,
            deltaY: -(Number(params.deltaY) || 0) * 0.05 * factor,
          });
          return { ok: true };
        }
        case 'key': {
          const text = String(params.text ?? '');
          if (text.length === 0 || text.length > 16) return { ok: false, reasonCode: 'bad_key', error: 'text must be 1..16 chars' };
          for (const ch of text) {
            await cdpSend('Input.dispatchKeyEvent', { type: 'char', text: ch });
          }
          return { ok: true };
        }
        default:
          return { ok: false, reasonCode: 'bad_input', error: `unknown input kind '${String(params.kind)}'` };
      }
    } catch (error) {
      return { ok: false, reasonCode: 'input_failed', error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /** `tooling.viewportStop`. */
  async function stop() {
    closeWebSocket();
    try { await killChild(); }
    catch (error) {
      terminalError = true;
      report('error', String(error?.message ?? error).slice(0, 200));
      return { ok: false, reasonCode: 'stop_failed', error: String(error?.message ?? error).slice(0, 200) };
    }
    if (profileDir) {
      const dir = profileDir;
      profileDir = null;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    currentUrl = '';
    currentTargetId = '';
    terminalError = false;
    lastFrameMetadata = null;
    lastViewport = null;
    report('stopped');
    return { ok: true };
  }

  return {
    async refreshTarget(pages) {
      if (reconnecting) return;
      const target = await activePageTarget(pages);
      if (!target || target.id === currentTargetId) return;
      reconnecting = true;
      try {
        closeWebSocket();
        await connectToPageTarget(cdpPort, target);
        // Device-metrics overrides are per-target, so a new page starts at the
        // window's own aspect until we put the panel's size back.
        if (lastViewport) {
          try { await cdpSend('Emulation.setDeviceMetricsOverride', lastViewport); } catch { /* next resize will retry */ }
        }
        if (!terminalError) report('running');
      } finally { reconnecting = false; }
    },
    start,
    stop,
    navigate,
    input,
    resize,
    /** Bounded teardown on host exit (host.mjs rl.close → tooling.dispose). */
    dispose: stop,
    get state() { return state; },
    get cdpPort() { return cdpPort; },
    get terminalError() { return terminalError; },
  };
}

export default createViewportBridge;
