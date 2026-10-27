import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';

// The CLI receives a memory-only, model-scoped loopback capability. Account
// bearer tokens and provider keys stay outside renderer settings and argv.
export function createModelGateway({ account, models, transport = fetch }) {
  const leases = new Map(), active = new Set(); let server, starting, epoch = 0;
  function invalidate() { epoch++; leases.clear(); for (const controller of active) controller.abort(); }
  function json(response, status, value) { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); } }
  async function handle(request, response) {
    const controller = new AbortController(); active.add(controller);
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      if (request.headers.origin || request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 403, { error: { message: '仅限 Desktop 本机模型调用。' } });
      const token = request.headers.authorization?.replace(/^Bearer /, ''), lease = leases.get(token);
      if (!lease || lease.expiresAt <= Date.now() || lease.epoch !== epoch) return json(response, 401, { error: { message: '请重新登录或重新发送本次对话。' } });
      let length = 0; const chunks = [];
      for await (const chunk of request) { length += chunk.length; if (length > 8 * 1024 * 1024) { json(response, 413, { error: { message: '模型请求超过 8MiB，请缩小附件或压缩上下文。' } }); request.resume(); return; } chunks.push(chunk); }
      let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(response, 400, { error: { message: '模型请求格式无效。' } }); }
      if (payload?.model !== lease.model) return json(response, 403, { error: { message: '本次授权与模型不一致。' } });
      const session = await account();
      if (lease.epoch !== epoch || lease.owner !== session.owner) return json(response, 401, { error: { message: '账号已变化，请重新发送。' } });
      const { model, ...body } = payload;
      const remote = await transport(session.serverUrl + '/relay/model-requests', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ pool: 'free', model, requestKey: crypto.randomUUID(), payload: body }),
      });
      // A failed dispatched operation must not be silently replayed by an
      // OpenAI client retrying HTTP 5xx. The ledger keeps its uncertain debit.
      if (!remote.ok) { const data = await remote.json().catch(() => ({})); return json(response, remote.status >= 500 || data.code === 'upstream_rejected' ? 409 : remote.status, { error: { message: data.error || '模型请求失败，请检查账号额度。', code: data.code || (remote.status >= 500 ? 'usage_uncertain' : 'model_request_denied') } }); }
      if (!payload.stream) { const data = await remote.json(); return json(response, 200, data.result); }
      if (!remote.headers.get('content-type')?.includes('text/event-stream')) { await remote.body?.cancel(); return json(response, 409, { error: { message: '模型未返回事件流，请先核对用量。' } }); }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      for await (const chunk of remote.body || []) {
        if (controller.signal.aborted) throw Error('cancelled');
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      response.end();
    } catch {
      if (!response.headersSent) json(response, 409, { error: { code: 'usage_uncertain', message: '模型连接中断，请核对用量后重试。' } });
      else if (!response.destroyed) response.destroy();
    } finally { active.delete(controller); }
  }
  async function listen() {
    if (server?.listening) return;
    if (starting) return starting;
    const candidate = http.createServer((request, response) => { void handle(request, response); });
    candidate.requestTimeout = 150000; candidate.headersTimeout = 10000;
    starting = (async () => { candidate.listen(0, '127.0.0.1'); await once(candidate, 'listening'); server = candidate; server.unref(); })();
    try { await starting; } finally { starting = undefined; }
  }
  return {
    invalidate,
    async connection({ model } = {}) {
      const scope = epoch, session = await account(), catalogue = await models(session);
      if (scope !== epoch) throw Error('账号已变化，请重试。');
      const authorized = catalogue.models.find(item => item.id === model && item.chat === true && item.pool === 'free');
      if (!authorized) throw Error('该文本模型未获授权，请刷新模型列表。');
      const capacity = authorized.contextLength;
      const metadata = Number.isSafeInteger(capacity) && capacity > 0 ? { modelContextWindow: capacity } : {};
      await listen();
      if (scope !== epoch) throw Error('账号已变化，请重试。');
      for (const [key, lease] of leases) if (lease.expiresAt <= Date.now()) leases.delete(key);
      for (const [apiKey, lease] of leases) {
        if (lease.epoch === epoch && lease.owner === session.owner && lease.model === model) {
          lease.expiresAt = Date.now() + 2 * 3600000;
          return { apiHost: `http://127.0.0.1:${server.address().port}/v1`, apiKey, apiModel: model, providerId: 'openai-compatible', apiFormat: 'openai', ...metadata };
        }
      }
      if (leases.size >= 128) throw Error('模型连接过多，请稍后重试。');
      const apiKey = crypto.randomBytes(32).toString('base64url');
      leases.set(apiKey, { model, epoch, owner: session.owner, expiresAt: Date.now() + 2 * 3600000 });
      return { apiHost: `http://127.0.0.1:${server.address().port}/v1`, apiKey, apiModel: model, providerId: 'openai-compatible', apiFormat: 'openai', ...metadata };
    },
    async close() { invalidate(); if (starting) await starting.catch(() => {}); const old = server; server = undefined; if (old) { old.closeAllConnections(); await new Promise(resolve => old.close(resolve)); } },
  };
}
