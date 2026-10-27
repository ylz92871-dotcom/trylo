import crypto from 'node:crypto';

export const quotaError = (status, message, code) => Object.assign(new Error(message), { status, code });
const fail = (status, message, code) => { throw quotaError(status, message, code); };
const day = 86400000, zone = 8 * 3600000;
const periods = new Set(['day', 'week', 'month', 'fiveHours']);
const integer = (value, name, max = 1000000000) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(400, `${name}必须为 1–${max} 的整数。`, 'invalid_limit');
  return value;
};
const cleanModels = value => {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(item))) fail(400, '请提供 1–100 个有效的模型 ID。', 'invalid_models');
  return [...new Set(value)];
};
const parse = row => row && JSON.parse(row.value);
const lookup = (db, table, id) => typeof id === 'string' ? parse(db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)) : null;
const list = (db, table) => db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all().map(parse);
const put = (db, table, item) => db.prepare(`INSERT INTO ${table}(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(item.id, JSON.stringify(item));

export function quotaWindow(now, period, anchor = 0) {
  if (period === 'fiveHours') {
    const duration = 5 * 3600000, start = anchor + Math.floor((now - anchor) / duration) * duration;
    return { start, end: start + duration };
  }
  if (period === 'month') {
    const local = new Date(now + zone), year = local.getUTCFullYear(), month = local.getUTCMonth();
    return { start: Date.UTC(year, month, 1) - zone, end: Date.UTC(year, month + 1, 1) - zone };
  }
  const duration = period === 'week' ? 7 * day : day, anchorTime = period === 'week' ? 4 * day : 0;
  const start = anchorTime + Math.floor((now + zone - anchorTime) / duration) * duration - zone;
  return { start, end: start + duration };
}

export async function createModelQuota({ store, now = Date.now, globalConcurrency = 4, userConcurrency = 2 }) {
  integer(globalConcurrency, '全站并发', 100); integer(userConcurrency, '账号并发', 100);
  await store.sqlWrite(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS model_upstreams(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_grants(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_requests(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,upstream_id TEXT NOT NULL,grant_id TEXT NOT NULL,
        request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,model TEXT NOT NULL,unit TEXT NOT NULL,
        period_start INTEGER NOT NULL,period_end INTEGER NOT NULL,reserved_units INTEGER NOT NULL,
        charged_units INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,created_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,settled_at INTEGER,reconciled_by TEXT,reconciliation_reason TEXT,UNIQUE(user_id,request_key));
      CREATE INDEX IF NOT EXISTS model_request_period ON model_requests(upstream_id,period_start,grant_id);
      CREATE INDEX IF NOT EXISTS model_request_active ON model_requests(status,deadline_at,user_id);`);
  });
  function users(db) { return JSON.parse(db.prepare('SELECT value FROM relay_state WHERE id=1').get().value).users; }
  function audit(db, actor, action, target) {
    const state = JSON.parse(db.prepare('SELECT value FROM relay_state WHERE id=1').get().value);
    state.audit ??= []; state.audit.push({ id: crypto.randomUUID(), at: now(), actor, action, target });
    if (state.audit.length > 5000) state.audit.splice(0, state.audit.length - 5000);
    db.prepare('UPDATE relay_state SET value=? WHERE id=1').run(JSON.stringify(state));
  }
  function requireUser(db, id) { if (!users(db).some(item => item.id === id && !item.disabled)) fail(403, '账号不可用。', 'account_unavailable'); }
  function totals(db, source, grant) {
    const window = quotaWindow(now(), source.period, source.anchor);
    const row = db.prepare(`SELECT COALESCE(SUM(charged_units),0) used,
      COALESCE(SUM(CASE WHEN status IN ('reserved','dispatched') THEN reserved_units ELSE 0 END),0) reserved
      FROM model_requests WHERE upstream_id=? AND period_start=?${grant ? ' AND grant_id=?' : ''}`).get(source.id, window.start, ...(grant ? [grant.id] : []));
    return { ...row, remaining: Math.max(0, (grant ? grant.limit : source.totalLimit) - row.used - row.reserved), periodStart: window.start, periodEnd: window.end };
  }
  function grantView(db, item) {
    const source = lookup(db, 'model_upstreams', item.upstreamId), counts = totals(db, source, item);
    return { ...item, ...counts, unit: source.unit, period: source.period, upstreamEnabled: source.enabled, upstreamRemaining: totals(db, source).remaining };
  }
  function snapshot() {
    return store.sqlRead(db => ({
      upstreams: list(db, 'model_upstreams').map(item => ({ ...item, ...totals(db, item) })),
      grants: list(db, 'model_grants').map(item => grantView(db, item)),
      users: users(db).map(({ id, username, disabled }) => ({ id, username, disabled: Boolean(disabled) })),
      policy: { globalConcurrency, userConcurrency, resetTimezone: 'Asia/Shanghai', executionEnabled: false },
    }));
  }
  function recoverExpired(db) {
    db.prepare("UPDATE model_requests SET status='released',settled_at=? WHERE status='reserved' AND deadline_at<=?").run(now(), now());
    db.prepare("UPDATE model_requests SET status='uncertain',charged_units=reserved_units,settled_at=? WHERE status='dispatched' AND deadline_at<=?").run(now(), now());
  }
  function eligibility(db, userId, upstreamId, model, grantId) {
    requireUser(db, userId);
    const source = lookup(db, 'model_upstreams', upstreamId);
    if (!source || !source.enabled || !source.models.includes(model)) fail(403, '上游或模型未开放。', 'model_unavailable');
    const grant = grantId ? lookup(db, 'model_grants', grantId) : list(db, 'model_grants').find(item => item.userId === userId && item.upstreamId === source.id && !item.revoked);
    if (!grant || grant.userId !== userId || grant.upstreamId !== source.id || grant.revoked || grant.expiresAtMs <= now() || !grant.models.includes(model)) fail(403, '该账号没有有效的模型授权。', 'grant_unavailable');
    return { source, grant };
  }
  async function saveUpstream(value, actor) {
    return store.sqlWrite(db => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '上游配置格式无效。');
      if (value.apiKey || value.secret || value.accessToken) fail(400, '当前只配置配额；真实密钥随上游适配器接入。', 'credentials_unavailable');
      const existing = value.id ? lookup(db, 'model_upstreams', value.id) : null;
      if (value.id && !existing) fail(404, '上游不存在。');
      if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 60 || !['free', 'plan'].includes(value.type) || !['chat', 'messages', 'responses'].includes(value.protocol)) fail(400, '上游名称、类型或接口协议无效。');
      let endpoint;
      try { endpoint = new URL(value.endpoint); } catch { fail(400, 'API 地址无效。'); }
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail(400, '请填写不含凭据或查询参数的 HTTPS API 地址。');
      if (!['tokens', 'requests'].includes(value.unit) || !periods.has(value.period)) fail(400, '计量单位或周期无效。');
      const hasHistory = existing && list(db, 'model_grants').some(item => item.upstreamId === existing.id);
      if (hasHistory && (existing.unit !== value.unit || existing.period !== value.period)) fail(409, '该上游已有授权记录，更换计量规则请新建上游。', 'accounting_immutable');
      const item = { id: existing?.id || crypto.randomUUID(), name: value.name.trim(), type: value.type, endpoint: endpoint.href, protocol: value.protocol, models: cleanModels(value.models), unit: value.unit, period: value.period,
        defaultLimit: integer(value.defaultLimit, '每人默认配额'), totalLimit: integer(value.totalLimit, '上游总配额'), concurrency: integer(value.concurrency, '上游并发', 100), enabled: existing?.enabled || false, anchor: existing?.anchor ?? now(), updatedAt: now(), actor };
      if (existing?.endpoint === item.endpoint && existing?.protocol === item.protocol && existing.catalog) { item.catalog = existing.catalog; item.catalogSyncedAt = existing.catalogSyncedAt; }
      if (item.defaultLimit > item.totalLimit) fail(400, '每人默认配额不能超过上游总配额。');
      if (existing) { const counts = totals(db, existing); if (item.totalLimit < counts.used + counts.reserved) fail(409, '总配额不能低于本周期已使用与预占的额度。'); }
      if (!existing && list(db, 'model_upstreams').length >= 100) fail(429, '上游数量已达上限。');
      put(db, 'model_upstreams', item); audit(db, actor, existing ? 'model.upstream.update' : 'model.upstream.create', item.id); return item.id;
    });
  }
  async function saveGrant(value, actor) {
    return store.sqlWrite(db => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.userId !== 'string' || typeof value.upstreamId !== 'string') fail(400, '授权配置格式无效。');
      const existing = value.id ? lookup(db, 'model_grants', value.id) : null;
      if (value.id && !existing) fail(404, '授权不存在。');
      if (existing?.revoked) fail(409, '已撤销的授权不能修改，请新增授权。');
      if (existing && (existing.userId !== value.userId || existing.upstreamId !== value.upstreamId)) fail(409, '已有授权不能更换账号或上游。', 'accounting_immutable');
      requireUser(db, value.userId);
      const source = lookup(db, 'model_upstreams', value.upstreamId);
      if (!source) fail(404, '上游不存在。');
      const models = cleanModels(value.models);
      if (models.some(model => !source.models.includes(model))) fail(400, '授权模型不在上游开放范围内。');
      if (list(db, 'model_grants').some(item => item.id !== existing?.id && item.userId === value.userId && item.upstreamId === source.id && !item.revoked)) fail(409, '该账号已有这条上游的授权，请调整已有授权。');
      if (typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.expiresAt)) fail(400, '请填写有效的授权到期日。');
      const expiry = Date.parse(`${value.expiresAt}T00:00:00+08:00`) + day;
      if (!Number.isFinite(expiry) || new Date(expiry - day + zone).toISOString().slice(0, 10) !== value.expiresAt || expiry <= now()) fail(400, '授权到期日无效或已经过期。');
      const item = { id: existing?.id || crypto.randomUUID(), userId: value.userId, upstreamId: source.id, models, limit: integer(value.limit, '用户配额'), expiresAt: value.expiresAt, expiresAtMs: expiry, revoked: false, createdAt: existing?.createdAt ?? now(), updatedAt: now(), actor };
      if (item.limit > source.totalLimit) fail(400, '用户配额不能超过上游总配额。');
      if (existing) { const counts = totals(db, source, existing); if (item.limit < counts.used + counts.reserved) fail(409, '配额不能低于本周期已使用与预占的额度。'); }
      if (!existing && list(db, 'model_grants').length >= 10000) fail(429, '授权记录已达上限。');
      put(db, 'model_grants', item); audit(db, actor, existing ? 'model.grant.update' : 'model.grant.create', item.id); return item.id;
    });
  }
  async function reserve({ userId, upstreamId, model, requestKey, fingerprint, units, timeoutMs = 120000 }) {
    integer(units, '预占额度'); integer(timeoutMs, '请求时限', 300000);
    if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail(400, '请求标识无效。');
    // Commit stale-operation accounting even when the new admission is denied.
    await store.sqlWrite(recoverExpired);
    return store.sqlWrite(db => {
      const { source, grant } = eligibility(db, userId, upstreamId, model);
      if (source.unit === 'requests' && units !== 1) fail(400, '次数配额每次调用必须预占 1 次。');
      const prior = db.prepare('SELECT id,fingerprint,status FROM model_requests WHERE user_id=? AND request_key=?').get(userId, requestKey);
      if (prior) fail(409, prior.fingerprint === fingerprint ? '这次请求已记录，不会重复执行。' : '同一请求标识不能对应不同内容。', 'request_already_recorded');
      const counts = totals(db, source, grant), shared = totals(db, source);
      if (counts.remaining < units || shared.remaining < units) fail(429, '可用配额不足（含正在进行的请求预占）。', 'quota_exhausted');
      const active = db.prepare("SELECT user_id,upstream_id FROM model_requests WHERE status IN ('reserved','dispatched') OR (status='uncertain' AND deadline_at>?)").all(now());
      if (active.length >= globalConcurrency || active.filter(item => item.user_id === userId).length >= userConcurrency || active.filter(item => item.upstream_id === source.id).length >= source.concurrency) fail(429, '并发请求已达上限，请稍后再试。', 'concurrency_exhausted');
      if (db.prepare('SELECT COUNT(*) count FROM model_requests').get().count >= 100000) fail(429, '用量记录容量已达上限，请联系管理员归档。');
      const item = { id: crypto.randomUUID(), userId, upstreamId: source.id, grantId: grant.id, model, unit: source.unit, units, deadlineAt: now() + timeoutMs };
      db.prepare(`INSERT INTO model_requests(id,user_id,upstream_id,grant_id,request_key,fingerprint,model,unit,period_start,period_end,reserved_units,status,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(item.id, userId, source.id, grant.id, requestKey, fingerprint, model, source.unit, counts.periodStart, counts.periodEnd, units, now(), item.deadlineAt);
      return item;
    });
  }
  async function dispatch(id) {
    return store.sqlWrite(db => {
      const item = db.prepare('SELECT * FROM model_requests WHERE id=?').get(id);
      if (!item || item.status !== 'reserved' || item.deadline_at <= now()) fail(409, '预占已失效。');
      eligibility(db, item.user_id, item.upstream_id, item.model, item.grant_id);
      db.prepare("UPDATE model_requests SET status='dispatched' WHERE id=?").run(id);
    });
  }
  async function release(id, knownUnsent = false) {
    return store.sqlWrite(db => { db.prepare(`UPDATE model_requests SET status='released',settled_at=? WHERE id=? AND status IN (${knownUnsent ? "'reserved','dispatched'" : "'reserved'"})`).run(now(), id); });
  }
  async function uncertain(id) {
    return store.sqlWrite(db => { db.prepare("UPDATE model_requests SET status='uncertain',charged_units=reserved_units,settled_at=? WHERE id=? AND status='dispatched'").run(now(), id); });
  }
  async function settle(id, units, { reconcile = false, actor, reason } = {}) {
    if (!Number.isSafeInteger(units) || units < 0 || units > 1000000000) fail(400, '结算用量无效。');
    return store.sqlWrite(db => {
      if (reconcile && (!users(db).some(user => user.id === actor && user.role === 'admin' && !user.disabled) || typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 300)) fail(400, '核对结算需要管理员身份和至少 8 字的依据说明。');
      const item = db.prepare('SELECT * FROM model_requests WHERE id=?').get(id);
      if (!item) fail(404, '请求不存在。');
      if (item.status === 'settled') { if (item.charged_units !== units) fail(409, '请求已按其他用量结算。'); return; }
      if (!['dispatched', 'uncertain'].includes(item.status) || (reconcile && item.status !== 'uncertain')) fail(409, '请求状态不允许结算。');
      db.prepare("UPDATE model_requests SET status='settled',charged_units=?,settled_at=? WHERE id=?").run(units, now(), id);
      if (reconcile) { db.prepare('UPDATE model_requests SET reconciled_by=?,reconciliation_reason=? WHERE id=?').run(actor, reason.trim(), id); audit(db, actor, 'model.usage.reconcile', id); }
      if (units > item.reserved_units) { const source = lookup(db, 'model_upstreams', item.upstream_id); source.enabled = false; source.pauseReason = '实际用量超过适配器预占上限，请核对计量配置。'; put(db, 'model_upstreams', source); }
    });
  }
  async function recoverAfterRestart() {
    await store.sqlWrite(db => {
      db.prepare("UPDATE model_requests SET status='released',settled_at=? WHERE status='reserved'").run(now());
      db.prepare("UPDATE model_requests SET status='uncertain',charged_units=reserved_units,settled_at=? WHERE status='dispatched'").run(now());
    });
  }
  return {
    snapshot, reserve, dispatch, release, uncertain, settle, recoverAfterRestart,
    async setCatalog(id, catalog, actor) { await store.sqlWrite(db => { const item = lookup(db, 'model_upstreams', id); if (!item) fail(404, '上游不存在。'); item.models = cleanModels(catalog.map(model => model.id)); item.catalog = catalog; item.catalogSyncedAt = now(); item.updatedAt = now(); put(db, 'model_upstreams', item); audit(db, actor, 'model.catalog.sync', id); }); return snapshot(); },
    async credentialAudit(id, actor) { await store.sqlWrite(db => audit(db, actor, 'model.credential.update', id)); },
    async saveUpstream(value, actor) { await saveUpstream(value, actor); return snapshot(); },
    async saveGrant(value, actor) { await saveGrant(value, actor); return snapshot(); },
    async setEnabled(id, enabled, actor) { if (typeof enabled !== 'boolean') fail(400, '启停状态无效。'); await store.sqlWrite(db => { const item = lookup(db, 'model_upstreams', id); if (!item) fail(404, '上游不存在。'); item.enabled = enabled; item.updatedAt = now(); item.actor = actor; put(db, 'model_upstreams', item); audit(db, actor, enabled ? 'model.upstream.enable' : 'model.upstream.pause', id); }); return snapshot(); },
    async revoke(id, actor) { await store.sqlWrite(db => { const item = lookup(db, 'model_grants', id); if (!item) fail(404, '授权不存在。'); item.revoked = true; item.updatedAt = now(); item.actor = actor; put(db, 'model_grants', item); audit(db, actor, 'model.grant.revoke', id); }); return snapshot(); },
    userQuotas(userId) { return store.sqlRead(db => { requireUser(db, userId); return { quotas: list(db, 'model_grants').filter(item => item.userId === userId).map(item => { const source = lookup(db, 'model_upstreams', item.upstreamId); const { actor, ...view } = grantView(db, item); return { ...view, upstreamName: source.name, models: view.models.filter(model => source.models.includes(model)) }; }), executionEnabled: false, resetTimezone: 'Asia/Shanghai' }; }); },
    requests(userId) { return store.sqlRead(db => db.prepare(`SELECT id,user_id userId,upstream_id upstreamId,grant_id grantId,model,unit,reserved_units reserved,charged_units used,status,created_at createdAt,settled_at settledAt,reconciled_by reconciledBy,reconciliation_reason reconciliationReason FROM model_requests ${userId ? 'WHERE user_id=?' : ''} ORDER BY rowid DESC LIMIT 200`).all(...(userId ? [userId] : []))); },
    source(id) { return store.sqlRead(db => lookup(db, 'model_upstreams', id)); },
  };
}
