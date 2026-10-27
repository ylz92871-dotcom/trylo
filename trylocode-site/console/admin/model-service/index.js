import { icon, status, escape as e, toast, confirm } from '/console/shared/ui.js';

const types = { free: '免费 API', plan: 'Coding Plan' };
const periods = { day: '每天', week: '每周', month: '每月', fiveHours: '每 5 小时' };
const units = { requests: '次请求', tokens: 'Token' };
const protocols = { chat: 'Chat Completions', messages: 'Messages', responses: 'Responses' };
const choices = (values, selected) => Object.entries(values).map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
const field = (name, label, value, extra = '') => `<div><label class="label" for="ms-${name}">${label}</label><input class="field" id="ms-${name}" name="${name}" value="${e(value ?? '')}" ${extra}></div>`;
const select = (name, label, values, value, disabled = false) => `<div><label class="label" for="ms-${name}">${label}</label><select class="field" id="ms-${name}" name="${name}" ${disabled ? 'disabled' : ''}>${choices(values, value)}</select></div>`;
const action = (label, name, id = '', primary = false, disabled = false) => `<button type="button" class="button${primary ? ' primary' : ''}" data-ms-action="${name}" data-id="${e(id)}" ${disabled ? 'disabled' : ''}>${primary ? icon('plus') : ''}${label}</button>`;
const textAction = (label, name, id, disabled) => `<button type="button" class="text-button" data-ms-action="${name}" data-id="${e(id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
const date = value => value ? new Date(value).toLocaleDateString('zh-CN') : '未设置';
const format = value => Number(value).toLocaleString('zh-CN');
const localDate = (days = 0) => { const value = new Date(); value.setDate(value.getDate() + days); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; };

// The view knows no URL, credential store or production transport. A port supplies
// account/upstream data and mutations; the preview injects an in-memory port.
export function mountModelService(root, { client, preview = true, page = 'upstreams', onPageChange = () => {} }) {
  const state = { page, loading: true, busy: false, error: '', editor: null, draft: null, search: '', type: 'all', data: { upstreams: [], users: [], grants: [] } };
  let alive = true;
  const upstream = id => state.data.upstreams.find(item => item.id === id);
  const granted = id => state.data.grants.filter(item => item.upstreamId === id && !item.revoked && item.expiresAt >= localDate());
  const countModels = item => item.models.length === 1 ? e(item.models[0]) : `${e(item.models[0])}<small>共 ${item.models.length} 个模型</small>`;
  const title = (heading, description, controls = '') => `<div class="page-title"><div><h1 tabindex="-1">${heading}</h1><p>${description}</p></div>${controls}</div>`;
  function focus(selector = 'h1') { root.querySelector(selector)?.focus(); }
  const amdSource = item => state.data.policy?.credentialsEnabled && item.type === 'free' && item.protocol === 'chat' && item.unit === 'requests' && item.endpoint.replace(/\/$/, '') === 'https://developer.amd.com.cn/radeon/api/v1';
  const liveActions = item => amdSource(item) ? `${textAction(item.credentialConfigured ? `配置账号（${item.credentialSlots?.length || 1}）` : '配置密钥', 'credential', item.id, state.busy)}${textAction('同步模型', 'sync-catalog', item.id, state.busy || !item.credentialConfigured)}` : '';

  function upstreamList() {
    const rows = state.data.upstreams.filter(item => (state.type === 'all' || item.type === state.type) && `${item.name} ${item.models.join(' ')}`.toLowerCase().includes(state.search.toLowerCase()));
    return title('上游配置', '连接你已有的 API，把可用模型分配给指定用户。', action('新增上游', 'new-upstream', '', true, state.busy)) +
      `<div class="ms-summary"><span>${state.data.upstreams.length} 个上游</span><span>新增账号默认没有模型使用权限</span></div>
      <div class="admin-toolbar"><input class="field" id="ms-search" aria-label="搜索上游名称或模型" placeholder="搜索上游名称或模型" value="${e(state.search)}"><select id="ms-filter-type" aria-label="筛选上游类型">${choices({ all: '全部类型', ...types }, state.type)}</select></div>
      <div class="admin-table"><div class="table-scroll"><table><thead><tr><th>上游</th><th>类型</th><th>开放模型</th><th>本周期总配额</th><th>授权账号</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(item => `<tr><td><strong>${e(item.name)}</strong><small>${e(protocols[item.protocol])}</small></td><td>${types[item.type]}</td><td class="ms-model-id mono">${countModels(item)}</td><td class="number">${format(item.used || 0)} / ${format(item.totalLimit)} ${units[item.unit]}<small>预占 ${format(item.reserved || 0)} · ${periods[item.period]}</small></td><td>${granted(item.id).length} 人</td><td>${status(item.enabled ? '已启用' : '已暂停', item.enabled ? 'good' : '')}</td><td><div class="ms-row-actions">${textAction('编辑', 'edit-upstream', item.id, state.busy)}${textAction('授权', 'grant-upstream', item.id, state.busy)}${textAction(item.enabled ? '暂停' : '启用', 'toggle-upstream', item.id, state.busy)}</div></td></tr>`).join('')}</tbody></table>${rows.length ? '' : '<div class="empty"><h2>没有匹配的上游</h2><p>调整筛选条件，或添加一条已有 API。</p></div>'}</div><p class="table-total">${rows.length} 条上游配置</p></div>
      <div class="ms-footnote"><strong>配额分别管理</strong><p>免费 API 与 Coding Plan 独立授权、独立限额。一个上游额度用尽后，停止使用该上游。</p></div>`;
  }

  function grantList() {
    return title('用户授权', '为指定账号开放上游、模型和使用额度。', action('新增授权', 'new-grant', '', true, state.busy || !state.data.upstreams.length)) +
      `<div class="ms-summary"><span>${state.data.grants.filter(item => !item.revoked && item.expiresAt >= localDate()).length} 条有效授权</span><span>注册邀请与模型授权分别管理</span></div>
      <div class="admin-table"><div class="table-scroll"><table><thead><tr><th>账号</th><th>可用上游与模型</th><th>本周期配额</th><th>授权到期</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.data.grants.map(item => {
        const source = upstream(item.upstreamId), user = state.data.users.find(user => user.id === item.userId);
        const label = item.revoked ? '已撤销' : user?.disabled ? '账号已停用' : item.expiresAt < localDate() ? '已到期' : !source?.enabled ? '上游已暂停' : !item.models.some(model => source.models.includes(model)) ? '模型未开放' : item.used + (item.reserved || 0) >= item.limit ? '配额已用完' : item.upstreamRemaining === 0 ? '上游额度已用完' : !preview && (!state.data.policy?.executionEnabled || source.executionReady === false) ? '待接入调用' : '可使用';
        return `<tr><td><strong>${e(user?.username || '未知账号')}</strong></td><td>${e(source?.name || '上游不可用')}<small class="mono">${e(item.models.join(' / '))}</small></td><td class="number">${format(item.used)} / ${format(item.limit)} ${units[source?.unit] || ''}<small>预占 ${format(item.reserved || 0)} · ${periods[source?.period] || ''}重置</small></td><td>${e(date(item.expiresAt))}</td><td>${status(label, label === '可使用' ? 'good' : '')}</td><td><div class="ms-row-actions">${textAction('调整', 'edit-grant', item.id, state.busy || item.revoked)}${textAction('撤销', 'revoke-grant', item.id, state.busy || item.revoked)}</div></td></tr>`;
      }).join('')}</tbody></table>${state.data.grants.length ? '' : '<div class="empty"><h2>还没有模型授权</h2><p>选择一个已有账号，为它开放指定上游和模型。</p></div>'}</div><p class="table-total">${state.data.grants.length} 条授权记录</p></div>
      <div class="ms-footnote"><strong>按账号共用配额</strong><p>经过统一模型服务的请求按账号共用额度和并发限制，包括电脑端、网页端和子智能体。</p></div>`;
  }

  function upstreamEditor() {
    const d = state.draft;
    return title(state.editor.id ? '编辑上游' : '新增上游', '填写现成 API 的连接信息，再设置这条上游的使用规则。', action('返回上游列表', 'cancel')) +
      `<form id="ms-upstream-form" class="ms-editor" ${state.busy ? 'aria-busy="true"' : ''}>
        <section class="admin-form"><h2>连接信息</h2><div class="ms-form-grid">
          ${field('name', '上游名称', d.name, 'required maxlength="60" placeholder="例如：我的 Coding Plan"')}
          ${select('type', '额度来源', types, d.type)}
          ${field('endpoint', 'API 地址', d.endpoint, 'type="url" required placeholder="https://api.example.com/v1"')}
          ${select('protocol', '接口协议', protocols, d.protocol)}
          <div class="ms-wide"><label class="label" for="ms-apiKey">API 密钥</label><input class="field" id="ms-apiKey" name="apiKey" type="password" autocomplete="off" disabled placeholder="${preview ? '预览不接收真实密钥' : state.data.policy?.credentialsEnabled ? '在上游列表中单独配置或更换密钥' : '真实上游接入后开放录入'}"><p class="ms-hint">${preview ? '此处仅展示密钥配置位置。' : state.data.policy?.credentialsEnabled ? 'AMD 免费池已接入，密钥加密保存在服务器。其他适配器单独开放。' : '当前可保存配额与授权，尚不接收密钥或发起模型调用。'}</p></div>
          <div class="ms-wide"><label class="label" for="ms-models">开放的模型 ID</label><textarea class="field ms-textarea mono" id="ms-models" name="models" required placeholder="每行一个上游真实模型 ID">${e(d.models)}</textarea><p class="ms-hint">按上游真实 ID 调用，用户只能选择这里开放的模型。</p>${d.catalog?.length ? `<p class="ms-hint">目录同步 ${d.catalog.length} 个模型，${d.catalog.filter(item => item.chat).length} 个聊天模型。语音、OCR、判别等专用模型保留在目录中，专用调用入口单独接入。</p>` : ''}</div>
        </div></section>
        <section class="admin-form"><h2>配额规则</h2><p class="ms-section-description">${d.type === 'plan' ? '套餐费用与用户配额分开记录，周期按你的实际套餐设置。' : '免费额度也设置使用上限，避免提前耗尽。'}</p><div class="ms-form-grid">
          ${select('unit', '计量单位', units, d.unit)}${select('period', '配额周期', periods, d.period)}
          ${field('defaultLimit', '每人默认配额', d.defaultLimit, 'type="number" min="1" max="1000000000" step="1" required')}
          ${field('totalLimit', '上游本周期总配额', d.totalLimit, 'type="number" min="1" max="1000000000" step="1" required')}
          ${field('concurrency', '上游总并发上限', d.concurrency, 'type="number" min="1" max="100" step="1" required')}
        </div><p class="ms-hint">这些是 Trylo 的分配限制，按北京时间重置；5 小时周期从上游创建时起算。上游官方剩余额度需另接查询接口。</p></section>
        ${state.error ? `<p class="error" role="alert" tabindex="-1">${e(state.error)}</p>` : ''}
        <div class="ms-form-actions"><button type="submit" class="button primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在保存…' : '保存上游'}</button>${action('取消', 'cancel', '', false, state.busy)}<span class="ms-hint">保存后，在用户授权中分配使用资格。</span></div>
      </form>`;
  }

  function grantEditor() {
    const d = state.draft, source = upstream(d.upstreamId);
    return title(state.editor.id ? '调整授权' : '新增授权', state.editor.id ? '调整模型、配额与到期日；更换账号或上游时请新增授权。' : '只有获授权的账号，才能在 Trylo 中使用对应模型。', action('返回授权列表', 'cancel')) +
      `<form id="ms-grant-form" class="ms-editor" ${state.busy ? 'aria-busy="true"' : ''}><section class="admin-form"><h2>使用范围</h2><div class="ms-form-grid">
        ${select('userId', '账号', Object.fromEntries(state.data.users.map(item => [item.id, item.username])), d.userId, Boolean(state.editor.id))}
        ${select('upstreamId', '上游', Object.fromEntries(state.data.upstreams.map(item => [item.id, item.name])), d.upstreamId, Boolean(state.editor.id))}
        <fieldset class="ms-wide ms-model-options"><legend>可用模型</legend>${source?.models.map(model => `<label><input type="checkbox" name="allowedModel" value="${e(model)}" ${d.models.includes(model) ? 'checked' : ''}><span class="mono">${e(model)}</span></label>`).join('') || '<p>请先配置上游模型。</p>'}</fieldset>
      </div></section><section class="admin-form"><h2>额度与有效期</h2><div class="ms-form-grid">
        ${field('limit', `每周期配额（${units[source?.unit] || ''}）`, d.limit, 'type="number" min="1" max="1000000000" step="1" required')}
        ${field('expiresAt', '授权到期日', d.expiresAt, `type="date" min="${localDate()}" required`)}
      </div><p class="ms-hint">${periods[source?.period] || ''}重置，受上游总并发限制。额度耗尽后暂停调用，不自动切换至其他上游。</p></section>
      ${state.error ? `<p class="error" role="alert" tabindex="-1">${e(state.error)}</p>` : ''}<div class="ms-form-actions"><button type="submit" class="button primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在保存…' : '保存授权'}</button>${action('取消', 'cancel', '', false, state.busy)}</div></form>`;
  }

  function render() {
    if (!alive) return;
    root.classList.add('model-admin');
    root.innerHTML = state.loading ? '<div class="ms-loading" role="status">正在读取配置…</div>' :
      `${!preview && !state.data.policy?.executionEnabled ? '<div class="notice"><div><strong>配额与授权已接入服务端</strong><p>真实模型上游尚未开放。启用配置不会发起模型调用。</p></div></div>' : ''}` +
      (state.editor ? (state.editor.kind === 'credential' ? credentialEditor() : state.editor.kind === 'upstream' ? upstreamEditor() : grantEditor()) :
        `${state.error ? `<div class="notice" role="alert"><p>${e(state.error)}</p>${action('重试', 'reload')}</div>` : ''}${state.page === 'upstreams' ? upstreamList() : grantList()}`);
    if (state.busy) for (const control of root.querySelectorAll('input,select,textarea,button')) control.disabled = true;
    if (!state.editor && state.page === 'upstreams') for (const item of state.data.upstreams) {
      const row = root.querySelector(`[data-ms-action="edit-upstream"][data-id="${item.id}"]`)?.closest('tr');
      row?.querySelector('.ms-row-actions')?.insertAdjacentHTML('beforeend', liveActions(item));
      if (row && item.executionReady === false && item.enabled) row.querySelector('td:nth-child(6)')?.insertAdjacentHTML('beforeend', '<small>调用未就绪</small>');
    }
  }

  async function load() {
    state.loading = true; state.error = ''; render();
    try { const data = await client.load(); if (alive) state.data = data; }
    catch (error) { state.error = error.message; }
    finally { state.loading = false; render(); }
  }
  async function run(task, success) {
    if (state.busy) return;
    state.busy = true; state.error = ''; render();
    try { const data = await task(); if (!alive) return; state.data = data; state.editor = null; state.draft = null; toast(success); }
    catch (error) { if (alive) state.error = error.message; }
    finally { state.busy = false; render(); if (alive) focus(state.error ? '[role="alert"]' : 'h1'); }
  }
  function navigate(page) {
    if (state.busy) return;
    const change = () => { state.page = page === 'grants' ? 'grants' : 'upstreams'; state.editor = null; state.draft = null; state.error = ''; onPageChange(state.page); render(); focus(); };
    if (state.editor) confirm('放弃本次编辑？', '尚未保存的修改将被丢弃。', '放弃修改', change);
    else change();
  }
  function editUpstream(id) {
    const item = upstream(id);
    state.page = 'upstreams'; onPageChange(state.page); state.editor = { kind: 'upstream', id }; state.error = '';
    state.draft = item ? { ...item, models: item.models.join('\n'), apiKey: '' } : { name: '', type: 'free', endpoint: '', protocol: 'chat', models: '', unit: 'tokens', period: 'day', defaultLimit: '100000', totalLimit: '1000000', concurrency: '2', apiKey: '' };
    render(); focus('#ms-name');
  }
  function credentialEditor() {
    const item = upstream(state.editor.id);
    return title('配置上游密钥', `${item.name} · 密钥只由服务器保存，不会回显。`, action('返回上游列表', 'cancel')) + `<form id="ms-credential-form" class="ms-editor"><section class="admin-form"><h2>AMD API 密钥</h2><p class="ms-section-description">凭据绑定当前 AMD 地址。修改地址后需重新配置，不能把旧密钥发往新主机。</p><label class="label" for="ms-credential-slot">上游账号</label><select id="ms-credential-slot" class="field" name="slot"><option value="primary">账号 1（primary）</option><option value="secondary">账号 2（secondary）</option></select><p class="ms-hint">两条 API 在同一免费池内分流，共享用户额度。保存会替换所选账号的密钥。</p><label class="label" for="ms-credential">新密钥</label><input id="ms-credential" class="field" name="credential" type="password" autocomplete="new-password" required minlength="16" maxlength="512"><p class="ms-hint">提交后加密保存。不会显示已有密钥，也不会存入浏览器本地存储。</p></section>${state.error ? `<p class="error" role="alert">${e(state.error)}</p>` : ''}<div class="ms-form-actions"><button type="submit" class="button primary">保存密钥</button>${action('取消', 'cancel')}</div></form>`;
  }
  function editGrant(id, sourceId) {
    const item = state.data.grants.find(item => item.id === id), source = upstream(item?.upstreamId || sourceId) || state.data.upstreams[0];
    if (!source || !state.data.users.length) return;
    state.page = 'grants'; onPageChange(state.page); state.editor = { kind: 'grant', id }; state.error = '';
    state.draft = item ? { ...item, models: [...item.models] } : { userId: state.data.users[0].id, upstreamId: source.id, models: [...source.models], limit: String(source.defaultLimit), expiresAt: localDate(30) };
    render(); focus(state.editor.id ? '[name="allowedModel"]' : '#ms-userId');
  }
  function click(event) {
    const button = event.target.closest('[data-ms-action]'); if (!button || button.disabled || state.busy) return;
    const { msAction: name, id } = button.dataset;
    if (name === 'new-upstream' || name === 'edit-upstream') editUpstream(id);
    if (name === 'new-grant' || name === 'edit-grant' || name === 'grant-upstream') editGrant(name === 'edit-grant' ? id : '', name === 'grant-upstream' ? id : '');
    if (name === 'cancel') navigate(state.page);
    if (name === 'reload') void load();
    if (name === 'credential' && amdSource(upstream(id))) { state.editor = { kind: 'credential', id }; state.draft = {}; state.error = ''; render(); focus('#ms-credential'); }
    if (name === 'sync-catalog') void run(() => client.syncCatalog(id), '已同步上游全部模型；已有用户授权范围保持不变');
    if (name === 'toggle-upstream') {
      const item = upstream(id), update = () => run(() => client.setUpstreamEnabled(id, !item.enabled), item.enabled ? '上游已暂停' : '上游已启用');
      if (item.enabled) confirm('暂停这条上游？', '获授权的用户将暂时无法使用这条上游。已有授权与配额记录会保留。', '暂停上游', update);
      else void update();
    }
    if (name === 'revoke-grant') confirm('撤销这条授权？', '该账号将无法继续使用这条授权中的模型。其他授权不受影响。', '撤销授权', () => run(() => client.revokeGrant(id), '授权已撤销'));
  }
  function input(event) {
    const control = event.target;
    if (state.draft && control.name && control.name !== 'allowedModel' && Object.hasOwn(state.draft, control.name)) state.draft[control.name] = control.value;
    if (control.id === 'ms-search') {
      const cursor = control.selectionStart; state.search = control.value; render(); const field = root.querySelector('#ms-search'); field.focus(); field.setSelectionRange(cursor, cursor);
    }
  }
  function change(event) {
    const control = event.target;
    if (control.id === 'ms-filter-type') { state.type = control.value; render(); }
    if (!state.editor) return;
    input(event);
    if (control.name === 'allowedModel') state.draft.models = [...root.querySelectorAll('[name="allowedModel"]:checked')].map(item => item.value);
    if (control.name === 'upstreamId') { const item = upstream(control.value); state.draft.models = [...item.models]; state.draft.limit = String(item.defaultLimit); render(); focus('#ms-upstreamId'); }
    if (control.name === 'type' || control.name === 'unit') { render(); focus(`#ms-${control.name}`); }
  }
  function submit(event) {
      if (event.target.id === 'ms-credential-form') { event.preventDefault(); if (state.busy) return; const value = root.querySelector('#ms-credential').value, slot = root.querySelector('#ms-credential-slot').value; root.querySelector('#ms-credential').value = ''; void run(() => client.saveCredential(state.editor.id, value, slot), '上游账号密钥已加密保存，同池共享用户额度'); return; }
    if (!['ms-upstream-form', 'ms-grant-form'].includes(event.target.id)) return;
    event.preventDefault(); if (state.busy) return;
    const d = { ...state.draft };
    if (state.editor.kind === 'upstream') {
      const models = [...new Set(d.models.split(/[\n,]/).map(value => value.trim()).filter(Boolean))];
      let url; try { url = new URL(d.endpoint); } catch { /* Show the same recoverable form error. */ }
      if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !models.length) { state.error = '请填写 HTTPS API 地址（不含密钥、查询参数或片段），并至少开放一个模型。'; render(); focus('[role="alert"]'); return; }
      void run(() => client.saveUpstream({ ...d, id: state.editor.id, name: d.name.trim(), models, defaultLimit: Number(d.defaultLimit), totalLimit: Number(d.totalLimit), concurrency: Number(d.concurrency) }), '上游配置已保存');
    } else {
      if (!d.models.length) { state.error = '请至少选择一个可用模型。'; render(); focus('[role="alert"]'); return; }
      void run(() => client.saveGrant({ ...d, id: state.editor.id, limit: Number(d.limit) }), '用户授权已保存');
    }
  }
  root.addEventListener('click', click); root.addEventListener('input', input); root.addEventListener('change', change); root.addEventListener('submit', submit);
  void load();
  return { navigate, leave(change) { if (state.busy) return; if (state.editor) confirm('放弃本次编辑？', '尚未保存的修改将被丢弃。', '放弃修改', change); else change(); }, destroy() { alive = false; root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('change', change); root.removeEventListener('submit', submit); root.replaceChildren(); } };
}
