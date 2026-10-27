import { quotaError } from './quota.mjs';
export const AMD_BASE = 'https://developer.amd.com.cn/radeon/api/v1';
const fail = (status, message, code = 'upstream_unavailable') => { throw quotaError(status, message, code); };
export function isAmdSource(source) {
  return source?.type === 'free' && source.protocol === 'chat' && source.unit === 'requests' && typeof source.endpoint === 'string' && source.endpoint.replace(/\/$/, '') === AMD_BASE;
}
export function normalizeAmdModels(data) {
  if (!Array.isArray(data?.data) || !data.data.length || data.data.length > 100) fail(502, 'AMD 模型目录格式无效。');
  const seen = new Set();
  return data.data.map(item => {
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(item.id) || seen.has(item.id)) fail(502, 'AMD 模型 ID 无效或重复。');
    seen.add(item.id);
    const outputs = (item.architecture?.output_modalities || item.output || []).filter(value => ['text', 'audio', 'ocr', 'decision'].includes(value));
    const providers = Array.isArray(item.providers) ? item.providers : [];
    return { id: item.id, outputs, chat: outputs.includes('text'), streaming: providers.some(p => p.streaming === true), vision: providers.some(p => p.vision === true), tools: providers.some(p => p.tools === true), contextLength: Number.isSafeInteger(item.context_length) ? item.context_length : 0 };
  });
}
async function boundedJson(response, secret, max = 4 * 1024 * 1024) {
  if (!response.body) fail(502, 'AMD 返回了空响应。');
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > max) fail(502, 'AMD 返回内容超过限制。'); chunks.push(Buffer.from(next.value)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8').replaceAll(secret, '[redacted]'));
  } catch (error) { if (error.status) throw error; fail(502, 'AMD 返回内容无法解析。'); }
  finally { await reader.cancel().catch(() => {}); }
}
export function createAmdExecutor({ vault, transport = fetch, now = Date.now }) {
  // One source/grant/ledger, multiple credentials. Rotation never creates an
  // extra quota and never retries an operation that may have reached AMD.
  const members = new Map(); let sequence = 0;
  function states(source) {
    return (vault.slots?.(source) || ['primary']).map(slot => {
      const key = source.id + ':' + slot;
      if (!members.has(key)) members.set(key, { slot, active: 0, dispatched: 0, last: 0, cooldownUntil: 0, status: 0 });
      return members.get(key);
    });
  }
  function acquire(source, slot) {
    const candidates = states(source).filter(item => (!slot || item.slot === slot) && item.cooldownUntil <= now());
    candidates.sort((a, b) => a.active - b.active || a.last - b.last || a.slot.localeCompare(b.slot));
    const chosen = candidates[0];
    if (!chosen) fail(429, 'AMD 账号正在冷却，请稍后重试。', 'upstream_cooling');
    const secret = vault.read(source, chosen.slot);
    chosen.active++; chosen.last = ++sequence;
    return { secret, chosen, release() { chosen.active--; } };
  }
  const ready = source => isAmdSource(source) && vault.has(source);
  const requireSource = source => { if (!isAmdSource(source)) fail(503, '当前执行器只开放 AMD 免费池的按次 Chat 接口。', 'adapter_unavailable'); };
  async function request(source, route, { payload, signal, slot } = {}) {
    requireSource(source); const lease = acquire(source, slot), { secret, chosen } = lease;
    let response;
    try { chosen.dispatched++; response = await transport(AMD_BASE + route, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${secret}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: 'error', signal }); }
    catch { chosen.status = 502; chosen.cooldownUntil = now() + 10000; lease.release(); fail(502, 'AMD 连接失败，请稍后重试。'); }
    chosen.status = response.status;
    if (!response.ok) { chosen.cooldownUntil = now() + ([401, 403].includes(response.status) ? 300000 : response.status === 429 ? 30000 : 10000); lease.release(); await response.body?.cancel().catch(() => {}); throw Object.assign(quotaError(response.status === 429 ? 429 : 502, response.status === 429 ? 'AMD 当前请求过多，请稍后再试。' : 'AMD 拒绝或未完成本次请求。', 'upstream_rejected'), { requestFinished: true }); }
    return { response, secret, release: lease.release };
  }
  function prepare({ source, model, payload, streaming }) {
    requireSource(source);
    const info = source.catalog?.find(item => item.id === model);
    if (!info?.chat) fail(400, '该模型属于专用能力，尚不通过聊天接口调用。', 'model_capability');
      // Bound structural work independently of the model's token window. The
      // former 256-item cap rejected ordinary tool histories below 200K.
      if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 2048 || payload.messages.some(message => !message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || !(typeof message.content === 'string' || Array.isArray(message.content) || (message.role === 'assistant' && Array.isArray(message.tool_calls))))) fail(400, '请提供有效的聊天消息（最多 2048 条）。');
    if (payload.model !== undefined || payload.n !== undefined && payload.n !== 1 || payload.stream !== undefined && typeof payload.stream !== 'boolean') fail(400, '模型由授权决定，单次请求只生成一个回答。');
    if (payload.stream && (!streaming || !info.streaming)) fail(400, '当前请求不支持流式返回。');
    const allowance = payload.max_tokens ?? payload.max_completion_tokens ?? 2048;
    if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > 8192) fail(400, '单次输出上限必须为 1–8192 Token。');
    // The CLI carries base instructions, workspace rules and context notes as
    // separate system messages. AMD accepts one system block at the front.
    // Preserve every instruction in order, without changing the chat/tool order.
    const instructions = payload.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => {
      if (typeof message.content === 'string') return message.content;
      if (!Array.isArray(message.content) || message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string')) fail(400, '系统指令须为文本。');
      return message.content.map(part => part.text).join('\n');
    });
    const messages = [...(instructions.length ? [{ role: 'system', content: instructions.join('\n\n') }] : []), ...payload.messages.filter(message => !['system', 'developer'].includes(message.role))];
    const result = { messages, model, max_tokens: allowance, stream: Boolean(payload.stream) };
    for (const name of ['temperature', 'top_p', 'stop', 'response_format', 'tools', 'tool_choice', 'reasoning_effort']) if (payload[name] !== undefined) result[name] = payload[name];
    if (result.tools && !info.tools) fail(400, '该模型未声明工具调用能力。', 'model_capability');
    if (result.stream) result.stream_options = { include_usage: true };
    return result;
  }
  return {
    ready, supports: isAmdSource, prepare, userConcurrency: 1,
    members(source) { return states(source).map(item => ({ ...item })); },
    async discover(source, signal = AbortSignal.timeout(30000), slot) {
      const catalogs = [];
      for (const member of slot ? [slot] : vault.slots?.(source) || ['primary']) {
        const { response, secret, release } = await request(source, '/models', { signal, slot: member });
        try { catalogs.push(normalizeAmdModels(await boundedJson(response, secret))); } finally { release(); }
      }
      if (!catalogs.length) fail(503, '尚未配置 AMD 账号。');
      // Every member must be able to serve an advertised model. Preserve the
      // existing grants; the admin must explicitly grant newly discovered IDs.
      return catalogs[0].filter(item => catalogs.every(catalog => catalog.some(other => other.id === item.id))).map(item => {
        const matches = catalogs.map(catalog => catalog.find(other => other.id === item.id));
        return { ...item, outputs: item.outputs.filter(output => matches.every(other => other.outputs.includes(output))),
          chat: matches.every(other => other.chat), tools: matches.every(other => other.tools), streaming: matches.every(other => other.streaming), vision: matches.every(other => other.vision), contextLength: Math.min(...matches.map(other => other.contextLength)) };
      });
    },
    async run({ source, model, payload, signal, onChunk }) {
      const body = prepare({ source, model, payload, streaming: Boolean(onChunk) });
      const { response, secret, release } = await request(source, '/chat/completions', { payload: body, signal });
      try {
      if (!body.stream) {
        const value = await boundedJson(response, secret);
        if (!Array.isArray(value.choices) || !value.choices.length || value.error) fail(502, 'AMD 未返回有效回答。');
        return { value, units: 1 };
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) fail(502, 'AMD 未返回流式事件。');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', bytes = 0, done = false;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length; if (bytes > 4 * 1024 * 1024) fail(502, 'AMD 流式响应超过限制。');
          buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') { done = true; break; }
            let value; try { value = JSON.parse(data.replaceAll(secret, '[redacted]')); } catch { fail(502, 'AMD 流式事件无法解析。'); }
            if (value.error) throw Object.assign(quotaError(502, 'AMD 拒绝了聊天请求，请检查模型能力与请求格式。', 'upstream_rejected'), { requestFinished: true });
            if (!Array.isArray(value.choices)) fail(502, 'AMD 流式请求未完成。');
            await onChunk(value);
          }
          if (done) break;
          if (buffer.length > 512 * 1024) fail(502, 'AMD 单个事件超过限制。');
        }
        if (!done) fail(502, 'AMD 流在完成标记之前中断。', 'usage_uncertain');
        return { value: { streamed: true }, units: 1 };
      } finally { await reader.cancel().catch(() => {}); }
      } finally { release(); }
    },
  };
}
