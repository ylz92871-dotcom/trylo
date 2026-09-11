// Trylo Desktop Services — pet chat HTTP transport.
//
// Ported from the legacy extension's request plumbing (postJson /
// postSseJson / doHttpJsonRequest / endpoint resolvers / header builder,
// extension.js ~17462-17740) and rewritten over the Node >= 22 global
// `fetch` instead of hand-rolled http/https requests. Preserved verbatim
// in behavior: endpoint path resolution, header construction (auth header
// + prefix normalization + extra headers + anthropic-version default),
// SSE frame parsing with content-type sniffing, and user-visible error
// strings (`HTTP <status>: …`, 'Endpoint must be a valid URL.', …).

const DEFAULT_TIMEOUT_MS = 180000;

// ── endpoint resolution (legacy-verbatim) ────────────────────────────

function parseEndpoint(raw) {
  const t = String(raw || '').trim();
  if (!t) throw new Error('Endpoint is empty.');
  try {
    return new URL(t);
  } catch {
    throw new Error('Endpoint must be a valid URL.');
  }
}

function trimSlash(value) {
  const cleaned = String(value || '').replace(/\/+$/g, '');
  return cleaned || '/';
}

function appendPath(base, suffix) {
  const b = String(base || '').replace(/\/+$/g, '');
  const s = String(suffix || '').replace(/^\/+/g, '');
  return !b || b === '/' ? `/${s}` : `${b}/${s}`;
}

export function resolveOpenAIEndpoint(raw) {
  const u = parseEndpoint(raw);
  const p = trimSlash(u.pathname);
  if (/\/chat\/completions$/i.test(p)) return u.toString();
  u.pathname = p === '/' ? '/v1/chat/completions' : appendPath(p, 'chat/completions');
  return u.toString();
}

export function resolveAnthropicEndpoint(raw) {
  const u = parseEndpoint(raw);
  const p = trimSlash(u.pathname);
  if (/\/v1\/messages$/i.test(p) || /\/messages$/i.test(p)) return u.toString();
  if (p === '/') u.pathname = '/v1/messages';
  else if (/\/v1$/i.test(p)) u.pathname = appendPath(p, 'messages');
  else u.pathname = appendPath(p, 'v1/messages');
  return u.toString();
}

// ── headers (legacy-verbatim) ────────────────────────────────────────

function normHeader(v) {
  const text = String(v || '').trim();
  return !text || text.toLowerCase() === 'none' ? '' : text;
}

function hasHeader(headers, name) {
  const n = String(name || '').toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === n);
}

function normalizeAuthPrefix(prefix, headerName) {
  const raw = String(prefix ?? '');
  if (String(headerName || '').toLowerCase() !== 'authorization') {
    return raw;
  }
  const trimmed = raw.trim();
  if (!trimmed) return 'Bearer ';
  if (/^[A-Za-z]+$/.test(trimmed)) {
    return `${trimmed} `;
  }
  return raw;
}

function parseHeadersText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return {};
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Extra headers must be a valid JSON object.');
  }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') {
    throw new Error('Extra headers must be a JSON object.');
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const safe = normHeader(k);
    if (!safe) continue;
    out[safe] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function buildHeaders(config) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const routeLabel = String(config.routeLabel || 'API').trim();
  const h = normHeader(config.apiKeyHeader);
  if (h) {
    if (!config.apiKey) {
      throw new Error(
        `${routeLabel} key is missing. Fill it or clear ${routeLabel} Key Header for no-auth endpoints.`,
      );
    }
    const normalizedPrefix = normalizeAuthPrefix(config.apiKeyPrefix, h);
    headers[h] = `${normalizedPrefix}${config.apiKey}`;
  }
  const extra = parseHeadersText(config.extraHeadersText || '{}');
  for (const [k, v] of Object.entries(extra)) headers[k] = v;
  if (config.apiFormat === 'anthropic' && !hasHeader(headers, 'anthropic-version')) {
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

// ── error shaping ────────────────────────────────────────────────────

function trimForError(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function toErrorMessage(err) {
  if (err instanceof Error) {
    const base = err.message || 'Unknown error';
    const code = err && typeof err === 'object' && err.code ? ` [${String(err.code)}]` : '';
    const cause =
      err.cause instanceof Error && err.cause.message ? ` | cause: ${err.cause.message}` : '';
    return `${base}${code}${cause}`;
  }
  return String(err);
}

export function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err.code ? String(err.code) : '';
  if (code === 'ABORT_ERR') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /request aborted/i.test(msg);
}

function decorateFetchError(rawError) {
  const name = rawError && typeof rawError === 'object' ? String(rawError.name || '') : '';
  const cause = rawError && rawError.cause ? rawError.cause : null;
  const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : '';
  if (name === 'TimeoutError') {
    const err = new Error('Request timed out');
    err.code = 'ETIMEDOUT';
    return err;
  }
  // `AbortSignal.any` surfaces a caller abort as a DOMException named
  // 'AbortError' — normalize it so isAbortError() (and the legacy
  // '已停止本次回复。' path) recognizes it.
  if (name === 'AbortError' || isAbortError(rawError)) {
    const err = new Error('Request aborted');
    err.code = 'ABORT_ERR';
    return err;
  }
  if (causeCode === 'ENOTFOUND') {
    return new Error(`Network error: DNS failed (ENOTFOUND).`);
  }
  if (causeCode === 'ECONNREFUSED') {
    return new Error('Network error: connection refused (ECONNREFUSED).');
  }
  return rawError instanceof Error ? rawError : new Error(String(rawError || 'Unknown error'));
}

// ── transport ────────────────────────────────────────────────────────

function parseJson(text) {
  return JSON.parse(String(text || ''));
}

function fetchWithTimeout(endpoint, init, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(endpoint, { ...init, signal: combined }).catch((err) => {
    throw decorateFetchError(err);
  });
}

/** POST + JSON body → parsed JSON. Throws `HTTP <status>: …` on non-2xx. */
export async function postJson(endpoint, headers, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(
    endpoint,
    { method: 'POST', headers, body: JSON.stringify(body) },
    signal,
    timeoutMs,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${trimForError(text)}`);
  }
  return parseJson(text);
}

function readSseFrameData(frame) {
  return String(frame || '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
}

/** POST + JSON body consuming an SSE stream (or a plain JSON body when the
 *  server does not stream). Calls `onPayload(parsed)` per SSE data frame.
 *  Resolves `{ streamed, payloadCount, data }` — legacy contract. */
export async function postSseJson(
  endpoint,
  headers,
  body,
  signal,
  onPayload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    },
    signal,
    timeoutMs,
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${trimForError(detail)}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  let responseMode = contentType.includes('text/event-stream') ? 'sse' : '';
  let frameBuffer = '';
  let responseBody = '';
  let payloadCount = 0;

  const processFrame = (frame) => {
    const dataText = readSseFrameData(frame);
    if (!dataText || dataText === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      return;
    }
    payloadCount += 1;
    if (typeof onPayload === 'function') onPayload(parsed);
  };

  const drainFrames = (flush) => {
    frameBuffer = frameBuffer.replace(/\r\n/g, '\n');
    let splitAt = frameBuffer.indexOf('\n\n');
    while (splitAt >= 0) {
      processFrame(frameBuffer.slice(0, splitAt));
      frameBuffer = frameBuffer.slice(splitAt + 2);
      splitAt = frameBuffer.indexOf('\n\n');
    }
    if (flush && frameBuffer.trim()) {
      processFrame(frameBuffer);
      frameBuffer = '';
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    if (!responseMode) {
      responseMode = /^\s*(?:data:|event:|:)/.test(text) ? 'sse' : 'json';
    }
    if (responseMode === 'sse') {
      frameBuffer += text;
      drainFrames(false);
    } else {
      responseBody += text;
    }
  }

  if (responseMode === 'sse') {
    drainFrames(true);
    return { streamed: true, payloadCount, data: null };
  }
  return { streamed: false, payloadCount: 0, data: parseJson(responseBody) };
}
