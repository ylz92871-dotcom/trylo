import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from '../../desktop-services/tests/fixtures/mobile-ui-gateway.cjs';
import { connectRemoteGateway } from '../src/remoteConnection.ts';

// Real HTTP, single-use tickets and WebSocket against the production Gateway.
// Only Desktop authority/task results are synthetic.
test('real gateway reconnect recovers missed results, approvals and selected session', async () => {
  const originals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new EventTarget();
  win.setTimeout = (...args) => setTimeout(...args);
  win.clearTimeout = (...args) => clearTimeout(...args);
  const doc = new EventTarget(); doc.visibilityState = 'visible';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const port = 51000 + Math.floor(Math.random() * 9000);
  const fixture = createFixture(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' };
  const request = async (path, body, signal) => {
    const response = await fetch(baseUrl + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal });
    assert.equal(response.ok, true); return response.json();
  };
  const received = [];
  const states = [];
  let dispose = () => {};
  const wait = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail('Gateway state was not observed'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const subscribe = () => connectRemoteGateway({ baseUrl, ticket: signal => request('/v1/socket-ticket', {}, signal), snapshot: signal => request('/v1/snapshot', undefined, signal), onSnapshot: value => received.push(value), onState: value => states.push(value) });
  try {
    await fixture.gateway.start(); fixture.initialize();
    dispose = subscribe(); await wait(() => states.at(-1) === 'connected');
    await request('/v1/chat/messages', { text: 'connection test', surface: 'code' });
    await wait(() => received.at(-1).approvals.length === 1);
    assert.equal(received.at(-1).conversation.filter(m => m.toolCallId === 'read').length, 1);
    dispose();
    // Events happen while the phone is disconnected.
    await request('/v1/permissions/fixture-approval/decision', { decision: 'allow' });
    dispose = subscribe(); await wait(() => received.at(-1).agent.status === 'done');
    assert.deepEqual(received.at(-1).approvals, []);
    assert.equal(received.at(-1).conversation.find(m => m.toolCallId === 'build').status, 'done');
    assert.equal(received.at(-1).conversation.filter(m => m.role === 'assistant').length, 1);
    const result = await request('/v1/sessions', { surface: 'work' });
    await wait(() => received.at(-1).activeSessionId === result.sessionId);
    assert.deepEqual(received.at(-1).conversation, []);
    assert.equal(received.at(-1).sessions[0].surface, 'work');
    // Foreground resubscription also restores this exact selection.
    const count = received.length;
    doc.dispatchEvent(new Event('visibilitychange'));
    await wait(() => received.length > count && states.at(-1) === 'connected');
    assert.equal(received.at(-1).activeSessionId, result.sessionId);
  } finally {
    dispose(); await fixture.gateway.stop();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});


test('Code and Work team messages, canonical member updates and session restoration use the real gateway', async () => {
  const port = 51000 + Math.floor(Math.random() * 9000);
  const fixture = createFixture(port);
  const headers = { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' };
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.ok, true); return response.json();
  };
  try {
    await fixture.gateway.start(); fixture.initialize();
    for (const surface of ['code', 'work']) {
      const { sessionId } = await request('/v1/sessions', { surface });
      await request('/v1/chat/messages', { surface, text: 'Test team UX', teamProfileId: 'fixture-team' });
      let snapshot = await request('/v1/snapshot');
      assert.equal(snapshot.activeSessionId, sessionId);
      assert.equal(snapshot.collaboration.team.title, '产品协作团队');
      assert.equal(snapshot.collaboration.members.length, 3);
      const collaboration = structuredClone(snapshot.collaboration);
      Object.assign(collaboration.members.find(member => member.id === 'worker'), { status: 'done', result: 'Updated result' });
      fixture.gateway.publish({ type: 'collaborationState', sessionId, collaboration });
      snapshot = await request('/v1/snapshot');
      const worker = snapshot.collaboration.members.find(member => member.id === 'worker');
      assert.equal(worker.name, '界面实现');
      assert.match(worker.prompt, /Code/);
      assert.equal(worker.result, 'Updated result');
      const other = await request('/v1/sessions', { surface });
      assert.equal((await request('/v1/snapshot')).collaboration.members.length, 0);
      fixture.gateway.publish({ type: 'collaborationState', sessionId, collaboration });
      assert.equal((await request('/v1/snapshot')).activeSessionId, other.sessionId);
      assert.equal((await request('/v1/snapshot')).collaboration.members.length, 0);
      await request(`/v1/sessions/${sessionId}/select`, {});
      assert.equal((await request('/v1/snapshot')).collaboration.members.find(member => member.id === 'worker').result, 'Updated result');
    }
  } finally { await fixture.gateway.stop(); }
});
