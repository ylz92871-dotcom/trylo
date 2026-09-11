// Trylo Desktop Services — Viewport bridge (IDE-style embedded browser panel).
//
// Architecture forked from auchenberg/vscode-browser-preview (MIT, deprecated
// but the closest open-source twin of this feature): a Trylo-managed Chromium
// driven over the DevTools protocol, `Page.startScreencast` frames streamed
// to the renderer canvas, input events forwarded back as CDP `Input` domain
// calls. Coordinate/zoom math follows Chromium's own
// devtools-frontend/front_end/panels/screencast/InputModel.ts (BSD).
//
// Ownership (tool-extension spec §3.1): this bridge owns ONE panel browser
// for the sidecar lifetime. MCP servers keep owning THEIR browsers — v1 does
// NOT attach the panel to the agent's browser: that needs a profile-service
// arg-injection decision and reconciles badly with acceptance B06 (browser
// subprocesses must exit on Stop). `start({ cdpPort })` already supports
// attaching to an external CDP endpoint for that future step.
//
// Failure policy: never throws across the RPC surface; every failure is
// `{ ok:false, reasonCode }` plus a `viewportStatus` event the panel shows.

import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { probePlaywrightChromium } from './tool-browser-condition.mjs';

const START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const MAX_FRAME_WIDTH = 1600;
const MAX_FRAME_HEIGHT = 1000;
const JPEG_QUALITY = 60;

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

export function createViewportBridge({ log = null, emit = null, storageRoot = '', probe = probePlaywrightChromium, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  let state = 'stopped'; // stopped | starting | running | error
  let child = null;
  let ws = null;
  let cdpPort = 0;
  let currentUrl = '';
  let startingPromise = null;
  let cdpNextId = 1;
  let profileDir = null;
  const pendingCdp = new Map();
  let lastFrameMetadata = null;

  const logLine = (message) => { try { log?.(`viewport: ${message}`); } catch { /* best effort */ } };

  function report(nextState, detail = '') {
    state = nextState;
    try {
      emit?.('viewportStatus', { state, detail, url: currentUrl });
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
    switch (message.method) {
      case 'Page.screencastFrame': {
        const { data, metadata, sessionId } = message.params ?? {};
        lastFrameMetadata = metadata ?? null;
        try {
          if (typeof sessionId === 'string') {
            ws?.send(JSON.stringify({ id: 0, method: 'Page.screencastFrameAck', params: { sessionId } }));
          }
        } catch { /* the stream self-heals on the next frame */ }
        if (typeof data === 'string' && metadata) {
          try {
            emit?.('viewportFrame', {
              data,
              deviceWidth: metadata.deviceWidth,
              deviceHeight: metadata.deviceHeight,
              pageScaleFactor: metadata.pageScaleFactor,
            });
          } catch { /* renderer may be gone; keep streaming */ }
        }
        break;
      }
      case 'Page.frameNavigated': {
        const url = message.params?.frame?.url;
        if (typeof url === 'string' && !url.startsWith('about:')) {
          currentUrl = url;
          report('running');
        }
        break;
      }
      default:
        break;
    }
  }

  function closeWebSocket() {
    if (ws) {
      try { ws.close(); } catch { /* already gone */ }
      ws = null;
    }
    for (const pending of pendingCdp.values()) pending.reject(new Error('viewport stopped'));
    pendingCdp.clear();
  }

  async function connectToPageTarget(port) {
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, START_TIMEOUT_MS);
    const target = pickPageTarget(list);
    if (!target) throw new Error('no page target on the DevTools endpoint');
    currentUrl = String(target.url ?? 'about:blank');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('viewport ws connect timeout')), 5_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('viewport ws connect failed')); }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') handleCdpMessage(data);
      else if (data instanceof ArrayBuffer) handleCdpMessage(new TextDecoder().decode(data));
      else if (typeof Blob !== 'undefined' && data instanceof Blob) data.text().then(handleCdpMessage).catch(() => {});
    });
    socket.addEventListener('close', () => {
      if (state === 'running') report('stopped', '浏览器会话已关闭');
    });
    ws = socket;

    await cdpSend('Page.enable');
    await cdpSend('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: MAX_FRAME_WIDTH,
      maxHeight: MAX_FRAME_HEIGHT,
      everyNthFrame: 1,
    });
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
    child = null;
    if (!processToKill) return;
    try {
      processToKill.kill();
    } catch { /* best effort */ }
    if (process.platform === 'win32') {
      // Chrome keeps subprocess trees; taskkill /T is the reliable sweep.
      spawn('taskkill', ['/PID', String(processToKill.pid), '/T', '/F'], { windowsHide: true });
    }
  }

  /** `tooling.viewportStart`. Idempotent: a running bridge answers with its
   *  current coordinates instead of spawning a second browser. */
  async function start(params = {}) {
    if (state === 'running') return { ok: true, cdpPort, url: currentUrl, alreadyRunning: true };
    if (state === 'starting') return startingPromise ?? { ok: false, reasonCode: 'start_failed', error: 'start already in flight' };

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
          child = spawn(executable, [
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
          child.on('exit', () => {
            if (state === 'running' || state === 'starting') {
              closeWebSocket();
              report('stopped', '浏览器已退出');
            }
          });
          child.on('error', (error) => logLine(`spawn failed: ${error?.message ?? error}`));
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
        report('running');
        return { ok: true, cdpPort, url: currentUrl };
      } catch (error) {
        closeWebSocket();
        await killChild();
        report('error', String(error?.message ?? error).slice(0, 200));
        return { ok: false, reasonCode: 'start_failed', error: String(error?.message ?? error).slice(0, 200) };
      } finally {
        startingPromise = null;
      }
    })();
    return startingPromise;
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
    await killChild();
    if (profileDir) {
      const dir = profileDir;
      profileDir = null;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    currentUrl = '';
    lastFrameMetadata = null;
    report('stopped');
    return { ok: true };
  }

  return {
    start,
    stop,
    navigate,
    input,
    /** Bounded teardown on host exit (host.mjs rl.close → tooling.dispose). */
    dispose: stop,
    get state() { return state; },
    get cdpPort() { return cdpPort; },
  };
}

export default createViewportBridge;
