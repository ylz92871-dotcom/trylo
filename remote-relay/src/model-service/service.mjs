import crypto from 'node:crypto';
import { createModelQuota, quotaError } from './quota.mjs';

// Provider execution is injected by trusted server code, never selected by a
// client-supplied URL or usage claim. No adapter means no upstream request.
export async function createModelService({ store, now = Date.now, executor = null, requestTimeoutMs = 120000 }) {
  const quota = await createModelQuota({ store, now });
  await quota.recoverAfterRestart();
  const active = new Set(); let closed = false, closing = false;
  async function execute(userId, data, externalSignal) {
    if (closing || closed || !executor) throw quotaError(503, '配额管理已接入，真实模型上游尚未开放。', 'executor_unavailable');
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.upstreamId !== 'string' || typeof data.model !== 'string' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) throw quotaError(400, '模型请求格式无效。');
    if (['userId', 'units', 'used', 'reserved', 'maxUnits'].some(key => Object.hasOwn(data, key))) throw quotaError(400, '账号和计量值由服务端确定。');
    const source = quota.source(data.upstreamId);
    if (!source) throw quotaError(403, '上游不可用。');
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
      const completed = Promise.resolve().then(() => { if (controller.signal.aborted) throw quotaError(499, '请求在调用上游前取消。'); invoked = true; return executor.run({ source, model: data.model, payload: data.payload, signal: controller.signal }); }).then(async result => {
        const actual = source.unit === 'requests' ? 1 : result?.units;
        if (!Number.isSafeInteger(actual) || actual < 0 || actual > 1000000000) throw quotaError(502, '上游未返回可信用量，已保留预占额度。', 'usage_uncertain');
        if (!closed) await quota.settle(reservation.id, actual);
        return result?.value;
      }).catch(async () => {
        if (!closed) { if (invoked) await quota.uncertain(reservation.id); else await quota.release(reservation.id, true); }
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
  const snapshot = () => { const data = quota.snapshot(); data.policy.executionEnabled = Boolean(executor); return data; };
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
    if (request.method === 'GET' && route === '/model-quotas') { const data = quota.userQuotas(principal.userId); data.executionEnabled = Boolean(executor); json(response, 200, data); return true; }
    if (request.method === 'GET' && route === '/model-usage') { json(response, 200, { records: quota.requests(principal.userId) }); return true; }
    if (request.method === 'POST' && route === '/model-requests') {
      const data = await body(request), controller = new AbortController();
      const disconnect = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnect);
      try { const result = await execute(principal.userId, data, controller.signal); if (!response.destroyed) json(response, 200, result); }
      finally { response.removeListener('close', disconnect); }
      return true;
    }
    return false;
  }
  return { quota, execute, handleAdmin, handleUser, snapshot, async close() { closing = true; const jobs = [...active]; for (const job of jobs) job.controller.abort(); await Promise.all(jobs.map(job => job.done)); closed = true; } };
}
