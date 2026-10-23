import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from '../../desktop/node_modules/jsdom/lib/api.js';

const root = new URL('../../trylocode-site/console/', import.meta.url);
const files = await Promise.all(['shared/ui.js', 'shared/api.js', 'admin/model-service/index.js', 'admin/model-service/api-client.js', 'admin/app.js'].map(file => fs.readFile(new URL(file, root), 'utf8')));
const strip = text => text.replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.ok(check(), 'Expected rendered state'); }
async function fixture(t, options = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', { url: 'https://console.test/admin/#upstreams', runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const { window } = dom, calls = [];
  window.AbortSignal = AbortSignal;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const data = { upstreams: [{ id: 'source', name: 'Synthetic upstream', models: ['test-model'], type: 'free', protocol: 'chat', endpoint: 'https://example.invalid/v1', unit: 'tokens', period: 'day', defaultLimit: 100, totalLimit: 1000, used: 70, reserved: 20, concurrency: 2, enabled: true }], users: [{ id: 'user', username: 'tester' }], grants: [{ id: 'grant', userId: 'user', upstreamId: 'source', models: ['test-model'], used: 70, reserved: 20, limit: 100, expiresAt: '2030-01-01' }], policy: { executionEnabled: false } };
  window.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (init.method && init.method !== 'GET') {
      assert.equal(init.headers['X-CSRF-Token'], 'fresh-csrf');
      if (options.mutate) return options.mutate(url, init, data);
      return reply(data);
    }
    return reply({ '/api/admin/session': { user: { username: 'operator', role: 'admin' }, csrf: 'fresh-csrf' }, '/api/admin/invitations': { invitations: [] }, '/api/admin/users': { users: [] }, '/api/admin/limits': { maxAccounts: 100, maxDevices: 2 }, '/api/admin/audit': { records: [] }, '/api/admin/model-service': data }[url]);
  };
  window.eval(`${strip(files[0])}\nconst e = escape;\n${strip(files[1])}\nconst {mountModelService} = (() => {${strip(files[2])}\nreturn {mountModelService};})();\n${strip(files[3])}\n${strip(files[4])}`);
  const doc = window.document; await until(() => doc.querySelector('[data-ms-action="new-upstream"]'));
  const field = (name, value) => { const node = doc.querySelector(`#ms-${name}`); node.value = value; node.dispatchEvent(new window.Event('input', { bubbles: true })); };
  return { window, doc, calls, field, data };
}

test('live quota screen shows real counters and keeps credentials disabled', async t => {
  const f = await fixture(t);
  assert.match(f.doc.querySelector('tbody').textContent, /70 \/ 1,000/);
  assert.match(f.doc.querySelector('tbody').textContent, /预占 20/);
  assert.match(f.doc.body.textContent, /真实模型上游尚未开放/);
  f.doc.querySelector('[data-ms-action="new-upstream"]').click();
  assert.equal(f.doc.querySelector('#ms-apiKey').disabled, true);
  assert.equal(f.doc.querySelector('#ms-totalLimit').value, '1000000');
  f.field('name', 'Keep my draft'); const form = f.doc.querySelector('#ms-upstream-form'), before = f.calls.length;
  f.window.dispatchEvent(new f.window.Event('focus')); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.doc.querySelector('#ms-upstream-form'), form); assert.equal(f.calls.length, before);
  f.doc.querySelector('nav [data-page="invitations"]').click();
  assert.equal(f.doc.querySelector('dialog')?.open, true);
  f.doc.querySelector('dialog [data-cancel]').click();
  assert.equal(f.doc.querySelector('#ms-name').value, 'Keep my draft');
});

test('quota mutation refreshes existing session and keeps draft after denied save', async t => {
  const f = await fixture(t, { mutate: async () => reply({ error: '总配额不能低于已用和预占。' }, 409) });
  f.doc.querySelector('[data-ms-action="edit-upstream"]').click(); f.field('name', 'Edited name');
  f.doc.querySelector('#ms-upstream-form').requestSubmit();
  await until(() => f.doc.querySelector('[role="alert"]')?.textContent.includes('总配额'));
  assert.equal(f.doc.querySelector('#ms-name').value, 'Edited name');
  const index = f.calls.findIndex(call => call.method === 'POST'); assert.equal(f.calls[index - 1].url, '/api/admin/session');
  assert.equal(JSON.parse(f.calls[index].body).totalLimit, 1000); assert.equal(f.doc.querySelector('#ms-apiKey').disabled, true);
});

test('grant action changes navigation without reloading editor; identities remain fixed', async t => {
  const f = await fixture(t);
  f.doc.querySelector('[data-ms-action="grant-upstream"]').click();
  assert.equal(f.window.location.hash, '#modelGrants'); assert.ok(f.doc.querySelector('#ms-grant-form'));
  assert.equal(f.doc.querySelector('nav [data-page="modelGrants"]').getAttribute('aria-current'), 'page');
  f.doc.querySelector('[data-ms-action="cancel"]').click();
  f.doc.querySelector('dialog [data-confirm]').click();
  await until(() => f.doc.querySelector('[data-ms-action="edit-grant"]'));
  assert.match(f.doc.querySelector('tbody').textContent, /待接入调用/);
  f.doc.querySelector('[data-ms-action="edit-grant"]').click();
  assert.equal(f.doc.querySelector('#ms-userId').disabled, true); assert.equal(f.doc.querySelector('#ms-upstreamId').disabled, true);
});

test('account console reads its own quota ledger without adding incompatible units', async t => {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', { url: 'https://console.test/account/#models', runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const { window } = dom, calls = [];
  window.AbortSignal = AbortSignal;
  window.fetch = async url => {
    calls.push(url);
    return reply({
      '/api/account/session': { user: { username: 'tester' }, csrf: 'synthetic' },
      '/api/account/summary': { devices: [] }, '/api/account/models': { reason: '未开放' },
      '/api/account/model-usage': { records: [{ id: 'request', upstreamId: 'free', model: 'model-a', unit: 'tokens', used: 70, reserved: 100, status: 'uncertain', createdAt: Date.now() }] },
      '/api/account/model-quotas': { executionEnabled: false, quotas: [
        { upstreamId: 'free', upstreamName: 'Free pool', models: ['model-a'], unit: 'tokens', period: 'day', used: 70, reserved: 20, limit: 100, remaining: 10, upstreamRemaining: 500, upstreamEnabled: true, expiresAtMs: Date.now() + 86400000 },
        { upstreamId: 'plan', upstreamName: 'Plan pool', models: ['model-b'], unit: 'requests', period: 'fiveHours', used: 3, reserved: 1, limit: 10, remaining: 6, upstreamRemaining: 4, upstreamEnabled: true, expiresAtMs: Date.now() + 86400000 },
      ] },
    }[url]);
  };
  const user = await fs.readFile(new URL('user/app.js', root), 'utf8');
  window.eval(`${strip(files[0])}\nconst e = escape;\n${strip(files[1])}\n${strip(user)}`);
  await until(() => window.document.querySelector('tbody'));
  assert.match(window.document.querySelector('tbody').textContent, /70 \/ 100 Token/);
  assert.match(window.document.querySelector('tbody').textContent, /3 \/ 10 次请求/);
  assert.match(window.document.querySelector('tbody').textContent, /4 次请求/);
  assert.doesNotMatch(window.document.body.textContent, /剩余额度\s*0\.00|73 点/);
  assert.ok(calls.includes('/api/account/model-quotas')); assert.ok(calls.includes('/api/account/model-usage'));
  const before = calls.length; window.dispatchEvent(new window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls.length, before);
});
