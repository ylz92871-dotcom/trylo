import crypto from 'node:crypto';
import { createModelQuota, quotaError } from './quota.mjs';

// Provider execution is injected by trusted server code, never selected by a
// client-supplied URL or usage claim. No adapter means no upstream request.
export async function createModelService({ store, now = Date.now, executor = null, vault = null, requestTimeoutMs = 120000 }) {
  const quota = await createModelQuota({ store, now, ...(executor?.userConcurrency ? { userConcurrency: executor.userConcurrency } : {}) });
  await quota.recoverAfterRestart();
  const active = new Set(); let closed = false, closing = false;
  const ready = source => Boolean(executor && source && (executor.ready ? executor.ready(source) : true));
  function userQuotas(userId) {
    const data = quota.userQuotas(userId); data.executionEnabled = Boolean(executor);
    for (const grant of data.quotas) { const source = quota.source(grant.upstreamId); grant.executionReady = ready(source); grant.catalog = (source.catalog || []).filter(item => grant.models.includes(item.id)); }
    return data;
  }
  function userModels(userId) {
    const models = userQuotas(userId).quotas.filter(grant => !grant.revoked && grant.expiresAtMs > now() && grant.upstreamEnabled && grant.executionReady).flatMap(grant => grant.models.map(id => ({ id, upstreamId: grant.upstreamId, upstreamName: grant.upstreamName, pool: quota.source(grant.upstreamId).type, ...(grant.catalog.find(item => item.id === id) || {}), remaining: Math.min(grant.remaining, grant.upstreamRemaining) })));
    return { enabled: Boolean(executor), models, reason: !executor ? '统一模型服务尚未开放，当前不会产生模型费用。' : models.length ? '模型按账号授权和配额开放；专用能力按目录标识区分。' : '模型服务已接入，当前账号尚无可用授权。' };
  }
  async function execute(userId, data, externalSignal, onChunk) {
    if (closing || closed || !executor) throw quotaError(503, '配额管理已接入，真实模型上游尚未开放。', 'executor_unavailable');
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.model !== 'string' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload) || !(typeof data.upstreamId === 'string' && data.pool === undefined || data.upstreamId === undefined && data.pool === 'free')) throw quotaError(400, '模型请求格式无效。');
    if (['userId', 'units', 'used', 'reserved', 'maxUnits'].some(key => Object.hasOwn(data, key))) throw quotaError(400, '账号和计量值由服务端确定。');
    const sourceId = data.upstreamId || userModels(userId).models.filter(item => item.id === data.model && item.pool === 'free' && item.remaining > 0).sort((a, b) => a.upstreamId.localeCompare(b.upstreamId))[0]?.upstreamId;
    const source = quota.source(sourceId);
    if (!source) throw quotaError(403, '上游不可用。');
    if (!ready(source)) throw quotaError(503, '该上游的调用配置尚未就绪。', 'adapter_unavailable');
    executor.prepare?.({ source, model: data.model, payload: data.payload, streaming: Boolean(onChunk) });
    const units = source.unit === 'requests' ? 1 : executor.quote?.({ source, model: data.model, payload: data.payload });
    if (!Number.isSafeInteger(units) || units < 1) throw quotaError(503, '这条上游尚未配置可信的 Token 预占上限。', 'meter_unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    let finish; const done = new Promise(resolve => { finish = resolve; });
    const job = { controller, done }; active.add(job);
    let reservation, dispatched = false, invoked = false, timer;
    try {
      reservation = await quota.reserve({ userId, upstreamId: source.id, model: data.model, requestKey: data.requestKey, units, timeoutMs: requestTimeoutMs, fingerprint: crypto.createHash('sha256').update(JSON.stringify({ upstreamId: source.id, model: data.model, payload: data.payload })).digest('hex') });
      if (controller.signal.aborted) throw quotaError(499, '请求已取消，尚未调用上游。');
      await quota.dispatch(reservation.id); dispatched = true;
      const aborted = new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(quotaError(504, '请求已停止，用量待核对。', 'usage_uncertain')), { once: true });
        if (controller.signal.aborted) reject(quotaError(504, '请求已停止，用量待核对。', 'usage_uncertain'));
      });
      timer = setTimeout(abort, requestTimeoutMs);
      // Valid, late provider usage can reconcile an uncertain reservation. A
      // disconnect/timeout alone never refunds a possibly billable operation.
      const completed = Promise.resolve().then(() => { if (controller.signal.aborted) throw quotaError(499, '请求在调用上游前取消。'); invoked = true; return executor.run({ source, model: data.model, payload: data.payload, signal: controller.signal, onChunk }); }).then(async result => {
        const actual = source.unit === 'requests' ? 1 : result?.units;
        if (!Number.isSafeInteger(actual) || actual < 0 || actual > 1000000000) throw quotaError(502, '上游未返回可信用量，已保留预占额度。', 'usage_uncertain');
        if (!closed) await quota.settle(reservation.id, actual);
        return result?.value;
      }).catch(async error => {
        const finishedRequest = invoked && source.unit === 'requests' && error?.requestFinished === true;
        if (!closed) { if (finishedRequest) await quota.settle(reservation.id, 1); else if (invoked) await quota.uncertain(reservation.id); else await quota.release(reservation.id, true); }
        if (finishedRequest) throw quotaError(error.status, error.message, 'upstream_rejected');
        throw quotaError(502, '上游调用失败或用量无法确认，请联系管理员核对。', 'usage_uncertain');
      });
      return { result: await Promise.race([completed, aborted]), requestId: reservation.id };
    } catch (error) {
      if (reservation) { if (dispatched && invoked) await quota.uncertain(reservation.id); else await quota.release(reservation.id, !invoked); }
      throw error;
    } finally {
      clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); active.delete(job); finish();
    }
  }
  const snapshot = () => { const data = quota.snapshot(); data.policy.executionEnabled = Boolean(executor); data.policy.credentialsEnabled = Boolean(vault && executor); data.policy.adapter = executor?.supports ? 'amd' : null; for (const source of data.upstreams) { source.credentialConfigured = Boolean(vault?.has(source)); source.executionReady = ready(source); source.credentialSlots = executor?.supports?.(source) ? vault?.slots?.(source) || [] : []; source.members = executor?.supports?.(source) && source.credentialConfigured ? executor.members?.(source) || [] : []; } return data; };
  async function handleAdmin(request, response, url, principal, { body, json }) {
    if (!url.pathname.startsWith('/api/admin/model-service')) return false;
    const route = url.pathname.slice('/api/admin/model-service'.length), actor = principal.userId;
    const read = async () => {
      const data = await body(request);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw quotaError(400, '请求内容必须为对象。');
      return data;
    };
    if (request.method === 'GET' && route === '') { json(response, 200, snapshot()); return true; }
    if (request.method === 'GET' && route === '/requests') { json(response, 200, { records: quota.requests() }); return true; }
    if (request.method === 'POST' && route === '/upstreams') { await quota.saveUpstream(await read(), actor); json(response, 200, snapshot()); return true; }
    if (request.method === 'POST' && route === '/grants') { await quota.saveGrant(await read(), actor); json(response, 200, snapshot()); return true; }
    const credential = route.match(/^\/upstreams\/([a-f0-9-]+)\/credential$/);
    if (request.method === 'POST' && credential) { const source = quota.source(credential[1]), data = await read(); if (!vault || !executor?.supports?.(source)) throw quotaError(400, '当前只支持为 AMD 免费池配置密钥。'); await vault.save(source, data.apiKey, data.slot ?? 'primary'); await quota.credentialAudit(source.id, actor); json(response, 200, snapshot()); return true; }
    const catalog = route.match(/^\/upstreams\/([a-f0-9-]+)\/catalog$/);
    if (request.method === 'POST' && catalog) { await read(); const source = quota.source(catalog[1]); if (!source || !executor?.discover || !ready(source)) throw quotaError(503, '请先配置受支持的上游与密钥。'); await quota.setCatalog(source.id, await executor.discover(source), actor); json(response, 200, snapshot()); return true; }
    const enabled = route.match(/^\/upstreams\/([a-f0-9-]+)\/enabled$/);
    if (request.method === 'POST' && enabled) { await quota.setEnabled(enabled[1], (await read()).enabled, actor); json(response, 200, snapshot()); return true; }
    const revoked = route.match(/^\/grants\/([a-f0-9-]+)$/);
    if (request.method === 'DELETE' && revoked) { await quota.revoke(revoked[1], actor); json(response, 200, snapshot()); return true; }
    const reconcile = route.match(/^\/requests\/([a-f0-9-]+)\/reconcile$/);
    if (request.method === 'POST' && reconcile) { const data = await read(); await quota.settle(reconcile[1], data.units, { reconcile: true, actor, reason: data.reason }); json(response, 200, { records: quota.requests() }); return true; }
    throw quotaError(404, '配额管理接口不存在。');
  }
  async function handleUser(request, response, url, principal, { body, json }, prefix = '/api/account') {
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    const route = url.pathname.slice(prefix.length);
    if (request.method === 'GET' && route === '/model-quotas') { json(response, 200, userQuotas(principal.userId)); return true; }
    if (request.method === 'GET' && route === '/models') { json(response, 200, userModels(principal.userId)); return true; }
    if (request.method === 'GET' && route === '/model-usage') { json(response, 200, { records: quota.requests(principal.userId) }); return true; }
    if (request.method === 'POST' && route === '/model-requests') {
      const data = await body(request, 8 * 1024 * 1024), controller = new AbortController();
      const disconnect = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnect);
      const sendChunk = async value => {
        if (controller.signal.aborted || response.destroyed) throw quotaError(499, '客户端已断开。');
        if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        if (!response.write(`data: ${JSON.stringify(value)}\n\n`)) await new Promise((resolve, reject) => {
          const cleanup = () => { response.off('drain', drain); response.off('close', close); };
          const drain = () => { cleanup(); resolve(); }; const close = () => { cleanup(); reject(quotaError(499, '客户端已断开。')); };
          response.once('drain', drain); response.once('close', close);
        });
      };
      try { const result = await execute(principal.userId, data, controller.signal, data?.payload?.stream ? sendChunk : undefined); if (!response.destroyed) { if (data?.payload?.stream) { if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('data: [DONE]\n\n'); } else json(response, 200, result); } }
      catch (failure) { if (response.headersSent && !response.destroyed) response.end(`event: error\ndata: ${JSON.stringify({ error: { code: 'usage_uncertain', message: '请求中断，请先核对本次用量。' } })}\n\n`); else throw failure; }
      finally { response.removeListener('close', disconnect); }
      return true;
    }
    return false;
  }
  return { quota, execute, handleAdmin, handleUser, snapshot, userModels, async close() { closing = true; const jobs = [...active]; for (const job of jobs) job.controller.abort(); await Promise.all(jobs.map(job => job.done)); closed = true; } };
}
