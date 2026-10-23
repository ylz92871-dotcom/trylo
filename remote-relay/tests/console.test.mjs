import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// Reuse the repository's existing UI test dependency, without adding runtime packages.
import { JSDOM } from '../../desktop/node_modules/jsdom/lib/api.js';

const consoleRoot = new URL('../../trylocode-site/console/', import.meta.url);
const adminSource = await fs.readFile(new URL('admin/app.js', consoleRoot), 'utf8');
const apiSource = await fs.readFile(new URL('shared/api.js', consoleRoot), 'utf8');
const uiSource = await fs.readFile(new URL('shared/ui.js', consoleRoot), 'utf8');
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), 'Expected UI state did not arrive');
}
async function fixture(t, post) {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div>', { url: 'https://console.test/admin/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, calls = [];
  let csrf = 'initial-csrf';
  window.AbortSignal = AbortSignal;
  window.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'POST') return post(url, options, csrf);
    return response({
      '/api/admin/session': { user: { username: 'operator', role: 'admin' }, csrf },
      '/api/admin/invitations': { invitations: [] }, '/api/admin/users': { users: [] },
      '/api/admin/limits': { maxAccounts: 100, maxDevices: 2, registrationOpen: true },
      '/api/admin/audit': { records: [] },
    }[url]);
  };
  window.eval(`${uiSource.replaceAll('export ', '')}\nconst e = escape;\n${apiSource.replace('export ', '')}\n${adminSource.replace(/^import .*;\r?\n/gm, '')}`);
  const doc = window.document;
  await until(() => doc.querySelector('[data-action="new"]'));
  doc.querySelector('[data-action="new"]').click();
  function field(name, value) {
    const input = doc.querySelector(`#${name}`); input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  function submit() { doc.querySelector('#invite-form').requestSubmit(); }
  return { window, doc, calls, field, submit, rotateCsrf() { csrf = 'fresh-csrf'; } };
}

test('invitation submit immediately shows pending state and blocks duplicate submissions', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => pending);
  f.field('note', '体验名额'); f.submit();
  assert.equal(f.doc.querySelector('#invite-form').getAttribute('aria-busy'), 'true');
  assert.match(f.doc.querySelector('#invite-form button[type="submit"]').textContent, /正在创建/);
  assert.equal(f.doc.querySelector('#invite-form button[type="submit"]').disabled, true);
  f.submit(); await until(() => f.calls.some(call => call.method === 'POST'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  release(response({ error: '暂时不可用' }, 503));
  await until(() => f.doc.querySelector('#invite-error')?.textContent.includes('暂时不可用'));
});

test('failed creation preserves all fields and explains 403 without silently signing out', async t => {
  const f = await fixture(t, async () => response({ error: '页面会话已变化，请刷新后重试。' }, 403));
  f.field('note', '第二批 <体验>'); f.field('limit', '3'); f.field('days', '14'); f.submit();
  await until(() => f.calls.some(call => call.method === 'POST') && !f.doc.querySelector('#invite-form')?.hasAttribute('aria-busy'));
  assert.equal(f.doc.querySelector('#note')?.value, '第二批 <体验>');
  assert.equal(f.doc.querySelector('#limit')?.value, '3'); assert.equal(f.doc.querySelector('#days')?.value, '14');
  assert.match(f.doc.querySelector('#invite-error')?.textContent || '', /页面会话已变化/);
  assert.equal(f.doc.querySelector('#login-form'), null);
});

test('returning to an open invitation form does not refresh away the draft', async t => {
  const f = await fixture(t, async () => response({}, 500));
  f.field('note', '不要清掉'); f.field('limit', '5');
  const form = f.doc.querySelector('#invite-form'), before = f.calls.length;
  f.window.dispatchEvent(new f.window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.doc.querySelector('#invite-form'), form);
  assert.equal(f.doc.querySelector('#note').value, '不要清掉');
  assert.equal(f.calls.length, before);
});

test('create refreshes session first and renders the returned invitation without depending on list reload', async t => {
  const f = await fixture(t, async (url, options, csrf) => {
    assert.equal(options.headers['X-CSRF-Token'], csrf);
    return response({ code: 'TRYLO-synthetic-code', invitation: { id: 'synthetic-id', suffix: 'c-code', note: '已成功保存', used: 0, limit: 2, expiresAt: Date.now() + 86400000 } }, 201);
  });
  f.rotateCsrf(); f.field('note', '已成功保存'); f.field('limit', '2'); f.submit();
  await until(() => f.doc.querySelector('.code-result'));
  assert.match(f.doc.querySelector('.code-result').textContent, /TRYLO-synthetic-code/);
  assert.match(f.doc.querySelector('tbody').textContent, /已成功保存/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.filter(call => call.url === '/api/admin/invitations' && !call.method).length, 1);
  assert.equal(f.doc.activeElement, f.doc.querySelector('.code-result'));
});

test('uncertain network failure warns against blindly creating again, retaining the draft', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  f.field('note', '可能已创建'); f.submit();
  await until(() => f.doc.querySelector('#invite-error')?.textContent);
  assert.match(f.doc.querySelector('#invite-error').textContent, /结果未确认/);
  assert.equal(f.doc.querySelector('#note').value, '可能已创建');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('expired admin session returns to login with an explicit explanation', async t => {
  const f = await fixture(t, async () => response({ error: '登录已过期，请重新登录。' }, 401));
  f.submit(); await until(() => f.doc.querySelector('#login-form'));
  assert.match(f.doc.querySelector('#login-form [role="alert"]').textContent, /登录已过期/);
});

test('an incomplete successful create response is never presented as a completed invitation', async t => {
  const f = await fixture(t, async () => response(null, 201));
  f.submit(); await until(() => f.doc.querySelector('#invite-error')?.textContent);
  assert.match(f.doc.querySelector('#invite-error').textContent, /结果未确认/);
  assert.equal(f.doc.querySelector('.code-result'), null);
});

test('an unreadable successful response warns that the server may have created the invitation', async t => {
  const f = await fixture(t, async () => ({ ok: true, status: 201, json: async () => { throw new SyntaxError('incomplete'); } }));
  f.submit(); await until(() => f.doc.querySelector('#invite-error')?.textContent);
  assert.match(f.doc.querySelector('#invite-error').textContent, /结果未确认/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
