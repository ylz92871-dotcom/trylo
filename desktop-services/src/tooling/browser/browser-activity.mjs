import { randomUUID } from 'node:crypto';

const ACTIONS = new Set(['click', 'move', 'type', 'scroll']);

/** Only metadata leaves the page: input values, keys and passwords never do. */
export function browserActivitySource(bindingName) {
  return `(${installPageActivity.toString()})(${JSON.stringify(bindingName)})`;
}

function installPageActivity(bindingName) {
  if (window.top !== window) return;
  const cleanupKey = '__tryloBrowserActivityCleanup';
  window[cleanupKey]?.();
  const listeners = [];
  const last = new Map();
  const describe = (node, kind) => {
    const element = node?.closest?.('button,a,input,textarea,select,[role],[contenteditable]') ?? node;
    if (!element?.getAttribute) return '';
    if (element.getAttribute('type') === 'password') return '密码输入框';
    const editable = ['INPUT', 'TEXTAREA'].includes(element.tagName)
      || element.getAttribute('contenteditable') !== null || element.getAttribute('role') === 'textbox';
    const label = element.getAttribute('aria-label') || element.getAttribute('title')
      || element.getAttribute('placeholder') || (kind === 'type' || editable ? element.getAttribute('name') : element.textContent);
    return String(label || element.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  };
  const report = (kind, event) => {
    const now = Date.now();
    if ((kind === 'move' || kind === 'scroll') && now - (last.get(kind) ?? 0) < 80) return;
    last.set(kind, now);
    const payload = {
      kind, target: describe(event.target, kind),
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    };
    if (typeof event.clientX === 'number' && typeof event.clientY === 'number') {
      payload.x = event.clientX;
      payload.y = event.clientY;
    } else if (kind === 'type') {
      const rect = event.target?.getBoundingClientRect?.();
      if (rect) { payload.x = rect.left + rect.width / 2; payload.y = rect.top + rect.height / 2; }
    }
    try { window[bindingName](JSON.stringify(payload)); } catch { /* Observer may have disconnected. */ }
  };
  const listen = (event, handler) => {
    document.addEventListener(event, handler, { capture: true, passive: true });
    listeners.push([event, handler]);
  };
  listen('pointermove', event => report('move', event));
  listen('pointerdown', event => report('click', event));
  listen('click', event => { if (!event.detail) report('click', event); });
  listen('input', event => report('type', event));
  listen('wheel', event => report('scroll', event));
  listen('scroll', event => report('scroll', event));
  window[cleanupKey] = () => {
    for (const [event, handler] of listeners) document.removeEventListener(event, handler, true);
    delete window[cleanupKey];
  };
}

export function parseBrowserActivity(payload, timestamp = Date.now()) {
  if (typeof payload !== 'string' || payload.length > 2048) return null;
  let action;
  try { action = JSON.parse(payload); } catch { return null; }
  if (!ACTIONS.has(action?.kind)) return null;
  const width = Number(action.viewportWidth);
  const height = Number(action.viewportHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || width > 16384 || height > 16384) return null;
  const result = { kind: action.kind, timestamp, viewportWidth: width, viewportHeight: height };
  if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
    result.x = Math.max(0, Math.min(width, action.x));
    result.y = Math.max(0, Math.min(height, action.y));
  }
  if (typeof action.target === 'string') result.target = action.target.slice(0, 100);
  return result;
}

/** A separate CDP binding per connection prevents old tabs from sharing a listener. */
export function createBrowserActivity({ emit, log = () => {} }) {
  const bindingName = `__tryloActivity_${randomUUID().replaceAll('-', '')}`;
  const contexts = new Set();
  let active = true;
  let mainFrame = '';
  return {
    async install(send) {
      const tree = await send('Page.getFrameTree');
      mainFrame = tree?.frameTree?.frame?.id ?? '';
      await send('Runtime.enable');
      await send('Runtime.addBinding', { name: bindingName });
      const source = browserActivitySource(bindingName);
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
      await send('Runtime.evaluate', { expression: source });
    },
    handle(message) {
      if (!active) return;
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context;
        if (context?.auxData?.isDefault && context.auxData.frameId === mainFrame) contexts.add(context.id);
      } else if (message.method === 'Runtime.executionContextDestroyed') {
        contexts.delete(message.params?.executionContextId);
      } else if (message.method === 'Runtime.executionContextsCleared') {
        contexts.clear();
      } else if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
        mainFrame = message.params?.frame?.id ?? mainFrame;
      } else if (message.method === 'Runtime.bindingCalled' && message.params?.name === bindingName
        && contexts.has(message.params.executionContextId)) {
        const action = parseBrowserActivity(message.params.payload);
        if (action) {
          try { emit?.('viewportAction', action); } catch (error) { log(String(error)); }
        }
      }
    },
    dispose() { active = false; contexts.clear(); },
  };
}
