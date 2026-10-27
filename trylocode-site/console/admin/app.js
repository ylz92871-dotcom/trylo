import { icon, logo, status, toast, confirm, escape as e } from '/console/shared/ui.js';
import { createApi } from '/console/shared/api.js';
import { mountModelService } from '/console/admin/model-service/index.js';
import { createModelAdminClient } from '/console/admin/model-service/api-client.js';
const api = createApi('admin'), root = document.querySelector('#app');
const pages = { invitations: '邀请码', users: '用户', upstreams: '上游配置', modelGrants: '用户授权', resources: '资源限制', audit: '操作记录' };
const inviteDefaults = () => ({ note: '', limit: '1', days: '7' });
const state = { user: null, page: location.hash.slice(1) || 'invitations', invitations: [], users: [], audit: [], limits: null, error: '', loading: true, busy: false, form: false, draft: inviteDefaults(), inviteError: '', created: '', search: '', filter: '全部' };
let generation = 0, modelView = null;
const modelPage = page => ['upstreams', 'modelGrants'].includes(page);
function updateModelPage(page) {
  state.page = page === 'grants' ? 'modelGrants' : 'upstreams';
  history.replaceState(null, '', `#${state.page}`);
  document.title = `Trylo · ${pages[state.page]}`;
  for (const button of root.querySelectorAll('[data-page]')) {
    const active = button.closest('nav') && button.dataset.page === state.page;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
}
function navigate(page) {
  if (modelView && modelPage(page)) return modelView.navigate(page === 'modelGrants' ? 'grants' : 'upstreams');
  const change = () => { state.form = false; state.created = ''; location.hash = page; };
  if (modelView) modelView.leave(change); else change();
}
const date = value => value ? new Date(value).toLocaleString() : '—';
const heading = (title, description, control = '') => `<div class="page-title"><div><h1>${title}</h1><p>${description}</p></div>${control}</div>`;
const button = (label, action, primary = false) => `<button type="button" class="button${primary ? ' primary' : ''}" data-action="${action}" ${state.busy ? 'disabled' : ''}>${primary ? icon('plus') : ''}${label}</button>`;
function inviteStatus(item) { return item.revokedAt ? '已停用' : item.expiresAt <= Date.now() ? '已过期' : item.used >= item.limit ? '已使用' : '待使用'; }
function invitations() {
  const rows = state.invitations.filter(item => (state.filter === '全部' || inviteStatus(item) === state.filter) && `${item.suffix} ${item.note}`.toLowerCase().includes(state.search.toLowerCase()));
  return heading('邀请码', '控制新用户加入，不影响已有账号的登录。', state.form ? '' : button('创建邀请', 'new', true)) + `<div class="admin-metrics"><div><p>已创建邀请</p><strong>${state.invitations.length}</strong></div><div><p>可使用邀请</p><strong>${state.invitations.filter(item => inviteStatus(item) === '待使用').length}</strong></div><div><p>已使用名额</p><strong>${state.invitations.reduce((sum, item) => sum + item.used, 0)}</strong></div></div>` +
    (state.form ? `<form class="admin-form" id="invite-form" ${state.busy ? 'aria-busy="true"' : ''}><h2>创建邀请</h2><div class="form-grid"><div><label class="label" for="note">备注</label><input class="field" id="note" name="note" maxlength="120" value="${e(state.draft.note)}" placeholder="例如：第二批体验" ${state.busy ? 'disabled' : ''}></div><div><label class="label" for="limit">可使用人数</label><input class="field" id="limit" name="limit" type="number" min="1" max="100" value="${e(state.draft.limit)}" required ${state.busy ? 'disabled' : ''}></div><div><label class="label" for="days">有效天数</label><input class="field" id="days" name="days" type="number" min="1" max="90" value="${e(state.draft.days)}" required ${state.busy ? 'disabled' : ''}></div></div>${state.inviteError ? `<p class="error" id="invite-error" role="alert" tabindex="-1">${e(state.inviteError)}</p>` : ''}<div class="actions"><button type="submit" class="button primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在创建…' : '生成邀请码'}</button>${button('取消', 'cancel')}</div></form>` : '') +
    (state.created ? `<div class="code-result" role="status" tabindex="-1"><strong>邀请已创建，请立即保存</strong><code>${e(state.created)}</code><p>完整邀请码仅显示这一次，刷新后无法找回。创建邀请不会自动发放模型额度。</p>${button('我已保存，隐藏邀请码', 'hide-code')}</div>` : '') +
    `<div class="admin-toolbar"><input class="field" id="search" aria-label="搜索邀请码后缀或备注" value="${e(state.search)}" placeholder="搜索后缀或备注"><select id="filter" aria-label="邀请状态">${['全部', '待使用', '已使用', '已停用', '已过期'].map(value => `<option ${state.filter === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="admin-table"><div class="table-scroll"><table><thead><tr><th>邀请码后缀</th><th>备注</th><th class="numeric">名额</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(item => `<tr><td class="mono">…${e(item.suffix)}</td><td>${e(item.note)}</td><td class="numeric">${item.used} / ${item.limit}</td><td>${e(date(item.expiresAt))}</td><td>${status(inviteStatus(item), inviteStatus(item) === '待使用' ? 'good' : '')}</td><td><button class="text-button" data-disable="${e(item.id)}" ${item.revokedAt || state.busy ? 'disabled' : ''}>停用</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : '<div class="empty"><h2>没有匹配的邀请</h2><p>创建邀请，或调整筛选条件。</p></div>'}</div><p class="table-total">${rows.length} 条邀请</p></div>`;
}
function users() { return heading('用户', '模型额度按上游分别管理，可在用户授权中查看。') + `<div class="admin-table"><div class="table-scroll"><table><thead><tr><th>账号</th><th>加入时间</th><th>模型授权</th><th>设备</th><th>角色</th></tr></thead><tbody>${state.users.map(user => `<tr><td>${e(user.username)}</td><td>${e(date(user.createdAt))}</td><td><button class="text-button" data-page="modelGrants">查看授权</button></td><td>${user.devices}</td><td>${user.role === 'admin' ? '管理员' : '用户'}</td></tr>`).join('')}</tbody></table></div><p class="table-total">${state.users.length} 个账号</p></div>`; }
function resources() {
  const limits = state.limits;
  return heading('资源限制', '服务端限制注册人数和每个账号的设备数量。') + `<div class="notice"><div><strong>统一模型服务尚未开放</strong><p>配额在上游配置与用户授权中管理；真实模型调用尚未开放。</p></div></div><form id="limits-form" class="admin-form"><h2>账号与设备</h2><div class="form-grid"><div><label class="label" for="maxAccounts">账号总上限</label><input class="field" id="maxAccounts" name="maxAccounts" type="number" min="1" max="1000" value="${limits.maxAccounts}" required></div><div><label class="label" for="maxDevices">单账号设备上限</label><input class="field" id="maxDevices" name="maxDevices" type="number" min="1" max="50" value="${limits.maxDevices}" required></div><div><label class="label" for="registrationOpen">接受邀请码注册</label><select class="field" id="registrationOpen" name="registrationOpen"><option value="true" ${limits.registrationOpen ? 'selected' : ''}>允许</option><option value="false" ${!limits.registrationOpen ? 'selected' : ''}>暂停</option></select></div></div><button class="button primary" ${state.busy ? 'disabled' : ''}>保存限制</button></form><p class="admin-note">降低上限不会移除现有账号或设备，只限制新增。模型配额由上游配置与用户授权管理；中继流量上限尚未开放配置。</p>`;
}
function audit() { return heading('操作记录', '记录账号注册、登录授权和平台管理操作。') + `<div class="admin-table"><div class="table-scroll"><table><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th></tr></thead><tbody>${state.audit.map(item => `<tr><td>${e(date(item.at))}</td><td>${e(item.actor)}</td><td>${e(item.action)}</td><td class="mono">${e(item.target)}</td></tr>`).join('')}</tbody></table></div><p class="table-total">最近 ${state.audit.length} 条记录</p></div>`; }
function render() {
  modelView?.destroy(); modelView = null;
  document.title = `Trylo · ${pages[state.page] || '管理后台'}`;
  if (!state.user && !state.loading) { root.innerHTML = `<main class="operator-main"><section class="admin-form"><h1>管理员登录</h1><p>管理后台使用独立会话，普通账号无法进入。</p><form id="login-form"><label class="label" for="username">账号</label><input class="field" name="username" id="username" autocomplete="username" required><label class="label" for="password">密码</label><input class="field" name="password" id="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required><p class="error" role="alert">${e(state.error)}</p><button class="button primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在登录…' : '登录管理后台'}</button></form></section></main>`; return; }
  root.innerHTML = `<div class="operator"><header class="operator-header"><div class="operator-brand">${logo()}Trylo<span>管理后台</span></div><div class="operator-account"><span>${e(state.user?.username || '')}</span>${button('退出后台', 'logout')}</div></header><aside class="operator-sidebar"><p>平台管理</p><nav class="operator-nav" aria-label="管理后台导航">${Object.entries(pages).map(([id, title]) => `<button data-page="${id}" class="${state.page === id ? 'active' : ''}" ${state.page === id ? 'aria-current="page"' : ''}>${icon({ invitations: 'invite', users: 'users', upstreams: 'models', modelGrants: 'users', resources: 'budget', audit: 'audit' }[id])}${title}</button>`).join('')}</nav><p class="scope-note">独立管理会话<br>所有管理接口由服务端校验权限</p></aside><main class="operator-main">${state.error ? `<div class="notice" role="alert"><p>${e(state.error)}</p>${button('重试', 'refresh')}</div>` : ''}${state.loading ? '<p role="status">正在读取后台…</p>' : modelPage(state.page) ? '<div id="model-service-root"></div>' : ({ invitations, users, resources, audit }[state.page] || invitations)()}<footer class="footer"><span>Trylo · 平台管理</span>${button('刷新状态', 'refresh')}</footer></main></div>`;
  if (state.user && !state.loading && modelPage(state.page)) modelView = mountModelService(root.querySelector('#model-service-root'), { client: createModelAdminClient(api), preview: false, page: state.page === 'modelGrants' ? 'grants' : 'upstreams', onPageChange: updateModelPage });
}
async function load() {
  const scope = ++generation; state.loading = true; state.error = ''; render();
  try {
    const session = await api.session();
    const [invitations, users, limits, audit] = await Promise.all([api.request('/invitations'), api.request('/users'), api.request('/limits'), api.request('/audit')]);
    if (scope !== generation) return;
    Object.assign(state, { user: session.user, invitations: invitations.invitations, users: users.users, limits, audit: audit.records });
  } catch (failure) { if (scope !== generation) return; state.error = failure.message; if ([401, 403].includes(failure.status)) { state.user = null; api.clear(); state.created = ''; } }
  finally { if (scope === generation) { state.loading = false; render(); } }
}
async function perform(task, kind = '') {
  if (state.busy) return;
  state.busy = true; state.error = ''; state.inviteError = ''; render();
  try { await task(); }
  catch (failure) {
    const message = kind === 'invite' && failure.uncertain ? '创建结果未确认，请先刷新邀请列表，按备注核对后再决定是否重新创建。' : failure.message;
    if (kind === 'invite' && failure.status !== 401) state.inviteError = message;
    else state.error = message;
    if (failure.status === 401) { state.user = null; state.created = ''; api.clear(); }
  } finally {
    state.busy = false; render();
    if (kind === 'invite') document.querySelector(state.inviteError ? '#invite-error' : '.code-result')?.focus();
  }
}
root.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button || button.disabled || state.busy) return;
  if (button.dataset.page) return navigate(button.dataset.page);
  if (button.dataset.action === 'refresh') { if (modelView) modelView.leave(() => void load()); else void load(); return; }
  if (button.dataset.action === 'logout') {
    const logout = () => void perform(async () => { await api.session(); await api.request('/logout', { method: 'POST', body: {} }); generation++; api.clear(); state.user = null; state.created = ''; state.users = []; state.audit = []; state.invitations = []; });
    if (modelView) modelView.leave(logout); else logout(); return;
  }
  if (button.dataset.action === 'new') { state.form = true; state.draft = inviteDefaults(); state.inviteError = ''; render(); document.querySelector('#note').focus(); return; }
  if (button.dataset.action === 'cancel') { state.form = false; state.inviteError = ''; render(); document.querySelector('[data-action="new"]')?.focus(); return; }
  if (button.dataset.action === 'hide-code') { state.created = ''; render(); return; }
  if (button.dataset.disable) confirm('停用这个邀请？', '此邀请将无法继续用于注册，已注册账号不受影响。', '停用邀请', () => perform(async () => { await api.request(`/invitations/${encodeURIComponent(button.dataset.disable)}`, { method: 'DELETE', body: {} }); await load(); toast('邀请已停用'); }));
});
root.addEventListener('submit', event => {
  event.preventDefault(); const id = event.target.id, data = Object.fromEntries(new FormData(event.target));
  if (id === 'login-form') return void perform(async () => { await api.request('/login', { method: 'POST', body: data }); data.password = ''; await load(); });
  if (id === 'invite-form') return void perform(async () => {
    // Another tab may have renewed the admin cookie. Refresh its matching CSRF
    // token before this single mutation; never automatically replay a create.
    await api.session();
    const value = await api.request('/invitations', { method: 'POST', body: { note: data.note, limit: Number(data.limit), days: Number(data.days) } });
    if (typeof value?.code !== 'string' || !value.code || !value.invitation?.id) throw Object.assign(new Error('创建结果未确认。'), { uncertain: true });
    state.created = value.code; state.form = false; state.draft = inviteDefaults();
    state.invitations = [value.invitation, ...state.invitations.filter(item => item.id !== value.invitation.id)];
    state.search = ''; state.filter = '全部';
  }, 'invite');
  if (id === 'limits-form') return void perform(async () => { await api.request('/limits', { method: 'POST', body: { maxAccounts: Number(data.maxAccounts), maxDevices: Number(data.maxDevices), registrationOpen: data.registrationOpen === 'true' } }); await load(); toast('限制已保存'); });
});
root.addEventListener('change', event => { if (event.target.id === 'filter') { state.filter = event.target.value; render(); } });
root.addEventListener('input', event => { if (event.target.form?.id === 'invite-form' && Object.hasOwn(state.draft, event.target.name)) state.draft[event.target.name] = event.target.value; if (event.target.id === 'search') { const cursor = event.target.selectionStart; state.search = event.target.value; render(); const field = document.querySelector('#search'); field.focus(); field.setSelectionRange(cursor, cursor); } });
addEventListener('hashchange', () => {
  const next = pages[location.hash.slice(1)] ? location.hash.slice(1) : 'invitations';
  if (next === state.page) return;
  const change = () => { state.page = next; history.replaceState(null, '', `#${next}`); render(); };
  if (modelView) { history.replaceState(null, '', `#${state.page}`); modelView.leave(change); } else change();
});
addEventListener('focus', () => { if (state.user && !modelView && !state.busy && !state.loading && !state.form && !state.created) void load(); });
void load();
