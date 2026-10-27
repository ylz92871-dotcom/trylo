import { icon, logo, status, toast, confirm, escape as e } from '/console/shared/ui.js';
import { createApi } from '/console/shared/api.js';
const api = createApi('account'), root = document.querySelector('#app');
const titles = { overview: '概览', usage: '用量', models: '模型', devices: '设备', settings: '设置' };
const state = { user: null, page: 'overview', code: '', summary: null, records: [], models: null, quotas: null, error: '', loading: true, busy: false, menu: false, period: '7', model: 'all', grant: null };
let version = 0, lastRead = 0;
const button = (name, page, primary = false) => `<button class="button${primary ? ' primary' : ''}" data-go="${page}">${name}</button>`;
const action = (name, id, primary = false) => `<button class="button${primary ? ' primary' : ''}" data-action="${id}" ${state.busy ? 'disabled' : ''}>${name}</button>`;
const heading = (title, description, control = '') => `<div class="page-title"><div><h1>${title}</h1><p>${description}</p></div>${control}</div>`;
const empty = (title, text) => `<div class="empty"><h2>${title}</h2><p>${text}</p></div>`;
function route() { const [page, search = ''] = location.hash.slice(1).split('?'); state.page = page || 'overview'; state.code = new URLSearchParams(search).get('code') || ''; }
function header() { return `<header class="global-header"><div class="header-inner"><div class="workspace"><a class="brand" href="/account/#overview">${logo()}Trylo</a><span>/</span><div class="workspace-name">个人空间</div></div><div class="header-right"><a class="text-button" href="/">返回官网</a>${state.user ? `<div class="profile-wrap"><button class="profile" data-action="menu" aria-label="账号菜单" aria-expanded="${state.menu}"><span class="avatar">${e(state.user.username.slice(0, 2).toUpperCase())}</span><span>${e(state.user.username)}</span>${icon('chevron')}</button>${state.menu ? `<div class="profile-menu"><button data-go="settings">账号设置</button><button data-action="logout">退出网页</button></div>` : ''}</div>` : ''}</div></div></header>`; }
function allowance() {
  const rows = state.quotas?.quotas || [], format = value => Number(value).toLocaleString('zh-CN');
  const periods = { day: '每天', week: '每周', month: '每月', fiveHours: '每 5 小时' };
  if (!rows.length) return empty('尚未分配模型额度', '获得管理员授权后，这里会显示各上游的配额。');
  return `<div class="table-scroll"><table><thead><tr><th>上游与模型</th><th>本周期已用 / 配额</th><th>预占</th><th>剩余额度</th><th>状态</th></tr></thead><tbody>${rows.map(item => {
    const unit = item.unit === 'tokens' ? 'Token' : '次请求';
    const label = item.revoked ? '已撤销' : item.expiresAtMs <= Date.now() ? '已到期' : !item.upstreamEnabled ? '上游已暂停' : !state.quotas.executionEnabled || item.executionReady === false ? '待开放调用' : !item.models.length ? '模型未开放' : item.remaining === 0 || item.upstreamRemaining === 0 ? '配额已用完' : '可使用';
    return `<tr><td>${e(item.upstreamName)}<br><span class="mono">${e(item.models.join(' / '))}</span></td><td class="numeric">${format(item.used)} / ${format(item.limit)} ${unit}<br>${periods[item.period]}</td><td class="numeric">${format(item.reserved)} ${unit}</td><td class="numeric">${format(Math.min(item.remaining, item.upstreamRemaining))} ${unit}</td><td>${status(label, label === '可使用' ? 'good' : '')}</td></tr>`;
  }).join('')}</tbody></table></div><p class="callout">按上游分别计量，不同单位不合并；剩余额度同时受上游共享总额度限制。北京时间重置，5 小时周期从上游创建时起算。</p>`;
}
function usageTable(rows) {
  if (!rows.length) return empty('还没有模型请求', '统一模型服务开放后，这里会显示实际用量。');
  return `<div class="table-scroll"><table><thead><tr><th>请求</th><th>模型</th><th>来源</th><th>时间</th><th class="numeric">用量</th><th>状态</th></tr></thead><tbody>${rows.map(row => `<tr><td class="mono">${e(row.id)}</td><td>${e(row.model)}</td><td>${e(row.source)}</td><td>${e(new Date(row.at).toLocaleString())}</td><td class="numeric">${Number(row.units).toLocaleString('zh-CN')} ${row.unit === 'tokens' ? 'Token' : '次请求'}</td><td>${e({ reserved: '预占中', dispatched: '请求中', uncertain: '用量待核对', settled: '已结算', released: '未调用，已释放' }[row.status] || row.status)}</td></tr>`).join('')}</tbody></table></div>`;
}
function deviceRows(compact = false) {
  const devices = state.summary?.devices || [];
  if (!devices.length) return empty('连接你的第一台电脑', '打开 Trylo Desktop，在浏览器中登录此账号，再选择是否开启远程访问。');
  return `<div class="${compact ? 'connected-grid' : ''}">${devices.map(device => `<div class="${compact ? 'device-tile' : 'device-list-row'}">${icon('monitor')}<div><strong>${e(device.name)}</strong><p>Trylo Desktop</p></div>${status(device.online ? '在线' : '离线', device.online ? 'good' : '')}${compact ? '' : `<button class="button" data-remove="${e(device.id)}" ${state.busy ? 'disabled' : ''}>移除设备</button>`}</div>`).join('')}</div>`;
}
function overview() {
  return heading('概览', '查看模型额度与设备连接，继续你的工作。', button('连接设备', 'connect', true)) + allowance() + `<div class="split"><section><div class="section-title"><h2>近期用量</h2>${button('查看用量', 'usage')}</div>${usageTable(state.records.slice(0, 3))}</section><aside class="benefits"><div class="section-title"><h2>模型服务</h2></div><div class="benefit"><span>账号状态</span><strong>邀请内测</strong></div><div class="benefit"><span>使用方式</span><strong>Trylo 内使用</strong></div><div class="benefit"><span>独立 API 密钥</span><strong>不提供</strong></div><p>${e(state.models?.reason || '服务状态读取中')}</p></aside></div><section class="divider-section"><div class="section-title"><h2>已连接设备</h2>${button('管理设备', 'devices')}</div>${deviceRows(true)}</section>`;
}
function usage() {
  const rows = state.records.filter(row => row.at >= Date.now() - Number(state.period) * 86400000 && (state.model === 'all' || state.model === row.model));
  return heading('用量', '查看账号请求记录，不包含本地项目名称或会话正文。') + allowance() + `<div class="toolbar"><span>${rows.length} 条请求</span><div class="filters"><select id="period" aria-label="时间范围">${['7', '30'].map(value => `<option value="${value}" ${state.period === value ? 'selected' : ''}>最近 ${value} 天</option>`).join('')}</select><select id="model" aria-label="模型筛选"><option value="all">全部模型</option>${[...new Set(state.records.map(row => row.model))].map(model => `<option ${model === state.model ? 'selected' : ''}>${e(model)}</option>`).join('')}</select></div></div>${usageTable(rows)}`;
}
function devices() { return heading('设备', '管理属于这个账号的电脑。手机配对随所属电脑一起撤销。', button('连接设备', 'connect', true)) + deviceRows() + '<div class="callout"><strong>登录与远程操作分别授权</strong>账号登录不会自动开启远程访问。移除电脑会断开其中继连接并撤销对应的手机会话。</div>'; }
function models() {
  const catalog = (state.models?.models || []);
  return heading('模型', '查看管理员为你分配的模型与配额。') + (!state.quotas?.executionEnabled ? '<div class="notice"><p>统一模型调用尚未开放，以下授权与额度已保存。</p></div>' : '') + allowance() + (catalog.length ? `<section class="divider-section"><div class="section-title"><h2>模型目录</h2><span>${catalog.length} 个模型</span></div><div class="table-scroll"><table><thead><tr><th>模型</th><th>能力</th><th>调用状态</th></tr></thead><tbody>${catalog.map(item => `<tr><td class="mono">${e(item.id)}</td><td>${e(item.outputs?.map(value => ({ text: '文本', audio: '语音', ocr: 'OCR', decision: '判别' }[value] || value)).join(' / ') || '聊天')}${item.vision ? ' · 视觉' : ''}${item.tools ? ' · 工具' : ''}</td><td>${item.chat === false ? '目录已收录，专用入口待接入' : item.remaining === 0 ? '配额已用完' : '服务端已接入'}</td></tr>`).join('')}</tbody></table></div></section>` : '') + '<div class="callout"><strong>本地自定义 API 保持独立</strong>你可以继续使用 Desktop 已配置的供应商。本页不发放独立密钥。平台模型需由客户端支持统一服务接入。</div>';
}
function settings() { return heading('设置', '同一个账号，各端会话分别管理。') + `<div class="settings"><div class="setting-row"><h3>账号</h3><div class="value">${e(state.user.username)}<small>网站与 Desktop 共用身份</small></div></div><div class="setting-row"><h3>当前网页</h3><div class="value">已登录<small>退出网页后，Desktop 保持自己的登录状态</small></div>${action('退出网页', 'logout')}</div><div class="setting-row"><h3>客户端登录</h3><div class="value">由 Desktop 主动发起<small>在浏览器中确认设备和验证码，再返回客户端</small></div>${button('连接步骤', 'connect')}</div><div class="setting-row"><h3>账号恢复</h3><div class="value">自助恢复暂未开放<small>请妥善保管密码</small></div></div></div>`; }
function connect() { return heading('连接设备', '先确认账号，再选择是否开启远程访问。') + `<div class="settings">${[['1. 在电脑上发起登录', '打开 Trylo Desktop → 远程与连接 → 在浏览器中登录。'], ['2. 确认账号与验证码', '核对网页和 Desktop 显示的验证码，再确认登录。'], ['3. 返回 Desktop', '登录不会自动开启远程访问；需要时在 Desktop 中单独开启。']].map(([title, detail]) => `<div class="setting-row"><h3>${title}</h3><div class="value">${detail}</div></div>`).join('')}</div>`; }
function auth() {
  const register = state.page === 'register';
  return `<div class="auth-page">${header()}<main class="auth-content"><section class="auth-box"><h1>${register ? '创建 Trylo 账号' : '登录 Trylo'}</h1><p>${state.code ? '登录后继续确认 Desktop 请求。' : register ? '凭邀请码加入 Trylo。' : '管理模型额度与自己的设备。'}</p><form id="auth-form"><label class="label" for="username">账号</label><input class="field" name="username" id="username" autocomplete="username" pattern="[A-Za-z0-9_.-]{3,64}" required><label class="label" for="password">密码</label><input class="field" name="password" id="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="12" maxlength="256" required>${register ? '<label class="label" for="invite">邀请码</label><input class="field" id="invite" name="inviteCode" required autocomplete="off">' : ''}<p class="error" role="alert">${e(state.error)}</p><button type="submit" class="button primary full" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在提交…' : register ? '创建账号' : '登录'}</button></form><p class="switch"><button data-switch="${register ? 'login' : 'register'}">${register ? '已有账号，登录' : '使用邀请码注册'}</button></p></section></main></div>`;
}
function authorize() {
  return `<div class="auth-page">${header()}<main class="auth-content"><section class="auth-box"><h1>确认登录 Desktop</h1><p>当前账号：${e(state.user.username)}</p>${state.error ? `<p class="error" role="alert">${e(state.error)}</p>` : ''}${state.grant && state.grant.userCode === state.code && !state.loading ? `<div class="auth-target">${icon('monitor')}<div><strong>${e(state.grant.name)}</strong><p>验证码 <code>${e(state.grant.userCode)}</code></p></div></div><p>请核对 Desktop 显示的验证码。只有你刚刚发起的请求才应确认。</p><div class="permissions"><div>${icon('shield')}登录不会自动开启远程访问或批准工具操作。</div></div><div class="auth-actions">${action('取消', 'deny')}${action('确认登录', 'approve', true)}</div>` : `<p>${state.loading ? '正在读取登录请求…' : '请从 Desktop 重新发起登录。'}</p>${button('返回控制台', 'overview')}`}</section></main></div>`;
}
function render() {
  document.title = `Trylo · ${titles[state.page] || '账号'}`;
  if (!state.user && !state.loading) { root.innerHTML = auth(); return; }
  if (state.page === 'authorize' && state.user) { root.innerHTML = authorize(); return; }
  if (state.page === 'success' || state.page === 'cancelled') { root.innerHTML = `<div class="auth-page">${header()}<main class="auth-content"><section class="auth-box"><h1>${state.page === 'success' ? '登录已确认' : '已取消登录'}</h1><p>${state.page === 'success' ? '可以返回 Desktop。客户端会完成一次性凭据交换。' : '没有为这次请求授予登录权限。'}</p>${button('返回控制台', 'overview')}</section></main></div>`; return; }
  const view = { overview, usage, models, devices, settings, connect }[state.page] || overview;
  root.innerHTML = `${header()}<nav class="navigation" aria-label="用户控制台导航"><div class="nav-inner">${Object.entries(titles).map(([id, title]) => `<button data-go="${id}" class="${state.page === id ? 'active' : ''}" ${state.page === id ? 'aria-current="page"' : ''}>${title}</button>`).join('')}</div></nav><main class="main">${state.error ? `<div class="notice" role="alert"><p>${e(state.error)}</p>${action('重试', 'refresh')}</div>` : ''}${state.loading ? empty('正在读取账号', '请稍候…') : view()}<footer class="footer"><span>Trylo · 用户控制台</span>${action('刷新状态', 'refresh')}</footer></main>`;
}
async function load() {
  const scope = ++version; state.loading = true; state.error = ''; state.grant = null; render();
  try {
    const session = await api.session();
    if (scope !== version) return;
    state.user = session.user;
    const [summary, usage, models, quotas] = await Promise.all([api.request('/summary'), api.request('/model-usage'), api.request('/models'), api.request('/model-quotas')]);
    const grant = state.page === 'authorize' ? await api.request(`/authorization?code=${encodeURIComponent(state.code)}`) : null;
    if (scope !== version) return;
    state.user = session.user; state.summary = summary; state.quotas = quotas;
    state.records = usage.records.map(item => ({ ...item, at: item.createdAt, units: ['reserved', 'dispatched'].includes(item.status) ? item.reserved : item.used, source: quotas.quotas.find(grant => grant.upstreamId === item.upstreamId)?.upstreamName || '历史上游' }));
    state.models = models; state.grant = grant; lastRead = Date.now();
  } catch (failure) { if (scope !== version) return; state.error = failure.message; state.grant = null; if (failure.status === 401) { state.user = null; api.clear(); } }
  finally { if (scope === version) { state.loading = false; render(); } }
}
async function perform(task) { if (state.busy) return; state.busy = true; state.error = ''; try { await task(); } catch (failure) { state.error = failure.message; if (failure.status === 401) state.user = null; } finally { state.busy = false; render(); } }
function go(page) { location.hash = page; }
root.addEventListener('click', event => {
  const control = event.target.closest('button'); if (!control || control.disabled) return;
  if (control.dataset.go) return go(control.dataset.go);
  if (control.dataset.switch) { state.page = control.dataset.switch; render(); return; }
  if (control.dataset.action === 'menu') { state.menu = !state.menu; render(); return; }
  if (control.dataset.action === 'refresh') return void load();
  if (control.dataset.action === 'logout') return void perform(async () => { await api.request('/logout', { method: 'POST', body: {} }); version++; api.clear(); state.user = null; state.summary = null; state.quotas = null; state.records = []; state.menu = false; });
  if (['approve', 'deny'].includes(control.dataset.action)) {
    if (state.loading || !state.grant || state.grant.userCode !== state.code) return;
    const code = state.code;
    return void perform(async () => { await api.request('/authorization', { method: 'POST', body: { code, approve: control.dataset.action === 'approve' } }); if (state.code === code && state.page === 'authorize') go(control.dataset.action === 'approve' ? 'success' : 'cancelled'); });
  }
  if (control.dataset.remove) {
    const device = state.summary.devices.find(item => item.id === control.dataset.remove);
    confirm('移除这个设备？', `将断开「${device.name}」的服务器连接，并撤销对应的手机配对。`, '移除设备', () => perform(async () => { await api.request(`/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE', body: {} }); await load(); toast('设备已移除'); }));
  }
});
root.addEventListener('submit', event => {
  if (event.target.id !== 'auth-form') return; event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  void perform(async () => { await api.request(state.page === 'register' ? '/register' : '/login', { method: 'POST', body: data }); data.password = ''; state.page = state.code ? 'authorize' : 'overview'; history.replaceState(null, '', `#${state.page}${state.code ? `?code=${state.code}` : ''}`); await load(); });
});
root.addEventListener('change', event => { if (['period', 'model'].includes(event.target.id)) { state[event.target.id] = event.target.value; render(); } });
addEventListener('hashchange', () => { route(); state.menu = false; void load(); window.scrollTo(0, 0); });
addEventListener('focus', () => { if (state.user && !state.busy && !state.loading && Date.now() - lastRead > 15000) void load(); });
route(); void load();
