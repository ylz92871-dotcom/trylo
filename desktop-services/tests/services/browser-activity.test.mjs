import assert from 'node:assert/strict';
import { it } from 'node:test';
import vm from 'node:vm';
import { browserActivitySource, createBrowserActivity, parseBrowserActivity } from '../../src/tooling/browser/browser-activity.mjs';

function pageHarness() {
  const events = [];
  const listeners = new Map();
  let clock = 1000;
  const window = { innerWidth: 1440, innerHeight: 900, report: payload => events.push(JSON.parse(payload)) };
  window.top = window;
  const document = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  const context = { window, document, Date: { now: () => clock } };
  return { events, listeners, window, document, context, tick: value => { clock += value; } };
}

const element = (attrs, text = '', tagName = 'INPUT') => ({
  tagName, textContent: text, value: 'NEVER_SEND_VALUE',
  getAttribute: name => attrs[name] ?? null,
  getBoundingClientRect: () => ({ left: 80, top: 50, width: 100, height: 20 }),
});

it('captures exact real pointer coordinates and keeps only a readable target descriptor', () => {
  const page = pageHarness();
  vm.runInNewContext(browserActivitySource('report'), page.context);
  page.listeners.get('pointerdown')({ target: element({}, ' Confirm  purchase ', 'BUTTON'), clientX: 333, clientY: 222 });
  assert.deepEqual(page.events[0], { kind: 'click', target: 'Confirm purchase', viewportWidth: 1440, viewportHeight: 900, x: 333, y: 222 });
});

it('input feedback never includes values, typed content, or password text', () => {
  const page = pageHarness();
  vm.runInNewContext(browserActivitySource('report'), page.context);
  page.listeners.get('input')({ target: element({ placeholder: 'Search' }, 'private typed text'), data: 'SECRET' });
  page.listeners.get('input')({ target: element({ type: 'password', 'aria-label': 'SECRET_PASSWORD' }), data: 'PASSWORD' });
  assert.equal(page.events[0].target, 'Search');
  assert.equal(page.events[0].x, 130);
  assert.equal(page.events[0].y, 60);
  assert.equal(page.events[1].target, '密码输入框');
  assert.ok(!JSON.stringify(page.events).includes('SECRET'));
  assert.ok(!JSON.stringify(page.events).includes('private typed text'));
  assert.ok(!JSON.stringify(page.events).includes('NEVER_SEND_VALUE'));
  page.listeners.get('pointerdown')({ target: element({ contenteditable: 'true' }, 'PRIVATE_EDITABLE_TEXT', 'DIV'), clientX: 10, clientY: 20 });
  assert.equal(page.events.at(-1).target, 'DIV');
  assert.ok(!JSON.stringify(page.events).includes('PRIVATE_EDITABLE_TEXT'));
});

it('throttles movement and scroll independently, without throttling clicks', () => {
  const page = pageHarness();
  vm.runInNewContext(browserActivitySource('report'), page.context);
  const event = { target: element({}), clientX: 90, clientY: 60 };
  for (let i = 0; i < 8; i++) {
    page.listeners.get('pointermove')(event);
    page.listeners.get('wheel')(event);
    page.listeners.get('scroll')({ target: page.document });
    page.tick(10);
  }
  page.listeners.get('pointerdown')(event);
  page.listeners.get('pointerdown')(event);
  assert.deepEqual(page.events.map(event => event.kind), ['move', 'scroll', 'click', 'click']);
  page.listeners.get('pointermove')(event);
  assert.equal(page.events.at(-1).kind, 'move');
});

it('reattachment replaces page listeners and ignores subframes instead of guessing coordinates', () => {
  const page = pageHarness();
  vm.runInNewContext(browserActivitySource('report'), page.context);
  const previous = page.listeners.get('pointerdown');
  vm.runInNewContext(browserActivitySource('report'), page.context);
  assert.notEqual(page.listeners.get('pointerdown'), previous);
  assert.equal(page.listeners.size, 6);
  const iframe = pageHarness();
  iframe.window.top = {};
  vm.runInNewContext(browserActivitySource('report'), iframe.context);
  assert.equal(iframe.listeners.size, 0);
});

it('validates the binding payload and emits only the explicit public fields', () => {
  assert.equal(parseBrowserActivity('bad json'), null);
  assert.equal(parseBrowserActivity(JSON.stringify({ kind: 'navigate', viewportWidth: 100, viewportHeight: 100 })), null);
  assert.equal(parseBrowserActivity(JSON.stringify({ kind: 'click', viewportWidth: 0, viewportHeight: 100 })), null);
  assert.deepEqual(parseBrowserActivity(JSON.stringify({ kind: 'click', x: -5, y: 150, viewportWidth: 100, viewportHeight: 100, value: 'secret' }), 42), {
    kind: 'click', timestamp: 42, viewportWidth: 100, viewportHeight: 100, x: 0, y: 100,
  });
});

it('installs on both current and future documents and drops unknown, destroyed and disposed contexts', async () => {
  const events = [];
  const calls = [];
  const observer = createBrowserActivity({ emit: (topic, payload) => events.push({ topic, payload }) });
  await observer.install(async (method, params) => {
    calls.push({ method, params });
    return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {};
  });
  const binding = calls.find(call => call.method === 'Runtime.addBinding').params.name;
  assert.ok(calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'));
  assert.ok(calls.some(call => call.method === 'Runtime.evaluate'));
  const event = { method: 'Runtime.bindingCalled', params: { name: binding, executionContextId: 8, payload: JSON.stringify({ kind: 'click', viewportWidth: 1440, viewportHeight: 900 }) } };
  observer.handle(event);
  assert.equal(events.length, 0);
  observer.handle({ method: 'Runtime.executionContextCreated', params: { context: { id: 8, auxData: { isDefault: true, frameId: 'main' } } } });
  observer.handle(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, 'viewportAction');
  observer.handle({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 8 } });
  observer.handle(event);
  assert.equal(events.length, 1);
  observer.handle({ method: 'Runtime.executionContextCreated', params: { context: { id: 8, auxData: { isDefault: true, frameId: 'main' } } } });
  observer.dispose();
  observer.handle(event);
  assert.equal(events.length, 1);
});
