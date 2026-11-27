import { WebSocket } from 'ws';

// Runs in a CDP isolated world. The only page addition is an aria-hidden,
// non-interactive closed shadow root; it never moves the user's OS cursor.
export function cursorOverlay(point) {
  let overlay = globalThis.__tryloAgentCursor;
  if (!point) { overlay?.host.remove(); clearTimeout(overlay?.timer); globalThis.__tryloAgentCursor = undefined; return; }
  if (!overlay?.host.isConnected) {
    clearTimeout(overlay?.timer);
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true'); host.setAttribute('data-trylo-agent-cursor', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important';
    const root = host.attachShadow({ mode: 'closed' });
    const cursor = document.createElement('div'); cursor.className = 'cursor';
    cursor.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;pointer-events:none!important';
    const ring = document.createElement('span');
    ring.style.cssText = 'position:absolute;left:-12px;top:-12px;width:24px;height:24px;border:2px solid #e8bd65;border-radius:50%;opacity:0;box-sizing:border-box;pointer-events:none!important';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '22'); svg.setAttribute('height', '30'); svg.setAttribute('viewBox', '-2 -2 22 30');
    svg.style.cssText = 'position:relative;left:-2px;top:-2px;display:block;overflow:visible;filter:drop-shadow(0 1.5px 1.5px #3b2b1364);pointer-events:none!important';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gradient.setAttribute('id', 'trylo-cursor-gold');
    gradient.setAttribute('x1', '0'); gradient.setAttribute('y1', '0'); gradient.setAttribute('x2', '0'); gradient.setAttribute('y2', '1');
    for (const [offset, color] of [['0%', '#ffefb3'], ['50%', '#e8bd65'], ['100%', '#ce9236']]) {
      const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stop.setAttribute('offset', offset); stop.setAttribute('stop-color', color); gradient.append(stop);
    }
    defs.append(gradient);
    const shape = 'M0 0L.6 21.5L5.8 16.4L10 25.2L13.6 23.4L9.4 14.6L17.4 14.4Z';
    const rim = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: shape, fill: 'none', stroke: '#fff7dd', 'stroke-width': '2.4', 'stroke-linejoin': 'round' })) rim.setAttribute(key, value);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: shape, fill: 'url(#trylo-cursor-gold)', stroke: '#754e18', 'stroke-width': '.75', 'stroke-linejoin': 'round' })) arrow.setAttribute(key, value);
    const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: 'M.8 2.3L1.3 18.7', fill: 'none', stroke: '#fff7dd', 'stroke-width': '.65', 'stroke-linecap': 'round', opacity: '.84' })) highlight.setAttribute(key, value);
    svg.append(defs, rim, arrow, highlight);
    const label = document.createElement('span'); label.textContent = '智能体';
    label.style.cssText = 'position:absolute;left:18px;top:22px;background:#ffffff;color:#262725;border:1px solid #946d22;border-radius:5px;padding:3px 6px;font:11px/14px system-ui;white-space:nowrap;box-shadow:0 1px 4px #26272520;pointer-events:none!important';
    cursor.append(ring, svg, label); root.append(cursor);
    document.documentElement.append(host);
    overlay = { host, cursor, ring };
    globalThis.__tryloAgentCursor = overlay;
  }
  overlay.cursor.style.transform = `translate(${point.x}px,${point.y}px)`;
  if (point.click) {
    overlay.ring.getAnimations().forEach(animation => animation.cancel());
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) overlay.ring.animate([{ opacity: .8, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(1.7)' }], { duration: 450 });
  }
  clearTimeout(overlay.timer);
  overlay.timer = setTimeout(() => { overlay.host.remove(); globalThis.__tryloAgentCursor = undefined; }, 2200);
}

/** Separate persistent CDP socket: visual feedback never awaits or occupies
 * the MCP input path. Bursts coalesce while a feedback update is in flight. */
export function createNativeBrowserCursor(url) {
  let socket, connecting, context, nextId = 0, latest, pumping = false, visible = false, disposed = false;
  const pending = new Map();
  async function connect() {
    if (socket?.readyState === WebSocket.OPEN) return;
    if (connecting) return connecting;
    socket = new WebSocket(url);
    const current = socket;
    current.on('message', raw => {
      let message; try { message = JSON.parse(String(raw)); } catch { return; }
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
    });
    const closed = () => {
      if (socket !== current) return;
      context = undefined;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('cursor connection closed')); }
      pending.clear();
    };
    current.on('close', closed); current.on('error', closed);
    connecting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { current.terminate(); reject(new Error('cursor connection timeout')); }, 1000);
      timer.unref();
      current.once('open', () => { clearTimeout(timer); resolve(); });
      current.once('error', error => { clearTimeout(timer); reject(error); });
      current.once('close', () => { clearTimeout(timer); reject(new Error('cursor connection closed')); });
    });
    try { await connecting; } finally { connecting = undefined; }
  }
  async function request(method, params) {
    await connect();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('cursor feedback timeout')); }, 1000);
      timer.unref(); pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function update(point) {
    let initialize = false;
    if (!context) {
      if (!point) return;
      const tree = await request('Page.getFrameTree');
      context = (await request('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'trylo-agent-cursor' })).executionContextId;
      initialize = true;
    }
    if (disposed && point) return;
    const handler = 'globalThis.__tryloAgentCursorUpdate';
    const expression = `${initialize ? `${handler}=(${cursorOverlay.toString()});` : ''}${handler}(${JSON.stringify(point)})`;
    const result = await request('Runtime.evaluate', { contextId: context, expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error('cursor overlay could not render');
  }
  async function drain() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (latest !== undefined && !disposed) {
        const point = latest; latest = undefined;
        try { await update(point); } catch { context = undefined; /* visual feedback is best-effort */ }
      }
    } finally { pumping = false; }
  }
  return {
    show(point) {
      if (disposed) return;
      visible = true;
      latest = { ...point, click: point.click || (latest?.click === true && latest.x === point.x && latest.y === point.y) };
      void drain();
    },
    hide() { if (!visible || disposed) return; visible = false; latest = null; void drain(); },
    async dispose() {
      if (disposed) return;
      disposed = true; latest = undefined; visible = false;
      if (context) await update(null).catch(() => {});
      socket?.terminate();
    },
  };
}
