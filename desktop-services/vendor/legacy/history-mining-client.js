'use strict';

/*
 * history-mining-client.js
 *
 * Node-side async client for the L4 history evidence adapter.
 * Calls `hermes-capabilities/history_adapter.py` and returns a validated,
 * narrowed DTO array (24 §4.1 / 30 §4.1).
 *
 * Mirrors memory-context-client.js exactly:
 *   - async spawn only (never spawnSync)
 *   - timeout, stdout/stderr caps, AbortSignal, exit-code check
 *   - settle-once via a single finalize() that clears the timer and
 *     detaches all child listeners
 *   - returns { ok: false } on any failure so the original Trylo Agent
 *     silently degrades (history mining is non-essential)
 *   - never re-parses conversation body in Node beyond the DTO whitelist
 *
 * 30 §4.1 forbidden-field guard: the DTO must NOT contain full transcript
 * (prompt/content/messages) or raw payload / absolute paths.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const { getHermesHome } = require('./hermes-capability-manager');

// PATCH 5 (see desktop-services/vendor/PATCHES.md): resolve the Python
// capabilities dir from the host env (fallback keeps the upstream layout).
const ADAPTER_SCRIPT = path.join(
  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
  'history_adapter.py',
);

const TIMEOUT_MS = 15000;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_RESULTS = 200;
const MAX_TASK_SUMMARY = 200;

// Whitelist for a single evidence DTO (30 §4.1).
// 30 P2 第 1 条 (production-audit v2): "应**显式允许** `workspacePath`
// 后**拒绝**所有其他键" — i.e. the validator REJECTS any key not in
// this list. `workspacePath` is explicitly allowed because history_adapter
// may carry it as a sibling to `workspace` (it's consumed by the
// cwd cache, not exposed to the model prompt).
const DTO_KEYS = ['sessionId', 'turnId', 'workspace', 'workspacePath', 'timestamp', 'role',
  'taskSummary', 'resultOutcome', 'verification', 'relativeFileHints',
  'toolCategories', 'evidenceHash'];
const DTO_KEYS_SET = new Set(DTO_KEYS);
// Forbidden keys (defence-in-depth; redundant once strict whitelist is on).
const FORBIDDEN_DTO_TOKENS = ['prompt', 'content', 'messages', 'rawPayload', 'raw_payload', 'absolute_path', 'reasoning'];

function _forbiddenHit(dto) {
  // Check field NAMES against the forbidden set — NOT serialized values,
  // so a taskSummary that legitimately contains the word "content" does not
  // false-positive. The DTO is already key-whitelisted; this is a
  // defense-in-depth guard against an adapter regression that adds a
  // full-transcript field.
  if (!dto || typeof dto !== 'object') return null;
  for (const k of Object.keys(dto)) {
    if (FORBIDDEN_DTO_TOKENS.includes(k)) return k;
  }
  return null;
}

/**
 * Strictly validate the adapter response. Returns { valid, error? }.
 */
function _validateResults(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'adapter output is not an object' };
  }
  if (parsed.ok !== true) {
    return { valid: false, error: String(parsed.error || 'adapter reported failure') };
  }
  if (!Array.isArray(parsed.results)) {
    return { valid: false, error: 'results is not an array' };
  }
  if (parsed.results.length > MAX_RESULTS) {
    return { valid: false, error: `results exceed ${MAX_RESULTS}` };
  }
  for (const r of parsed.results) {
    if (!r || typeof r !== 'object') {
      return { valid: false, error: 'result is not an object' };
    }
    // 30 P2 #1: strict whitelist — reject ANY key not in DTO_KEYS.
    // Production-audit v2 fix: a future adapter change that adds a
    // new field (e.g. "absolute_path" or "raw_payload") would now be
    // caught here rather than slipping into the prompt.
    for (const k of Object.keys(r)) {
      if (!DTO_KEYS_SET.has(k)) {
        return { valid: false, error: 'extra key not in DTO whitelist: ' + k };
      }
    }
    // Required keys (workspacePath is OPTIONAL — only present when the
    // adapter emits it for downstream cwd-cache consumers).
    const REQUIRED = DTO_KEYS.filter((k) => k !== 'workspacePath');
    for (const k of REQUIRED) {
      if (!(k in r)) return { valid: false, error: 'result missing key: ' + k };
    }
    if (typeof r.taskSummary !== 'string' || r.taskSummary.length > MAX_TASK_SUMMARY) {
      return { valid: false, error: 'taskSummary missing or > 200 chars' };
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(String(r.evidenceHash || ''))) {
      return { valid: false, error: 'evidenceHash is not a valid sha256' };
    }
    const forbidden = _forbiddenHit(r);
    if (forbidden) {
      return { valid: false, error: 'forbidden field leaked into DTO: ' + forbidden };
    }
  }
  return { valid: true };
}

/**
 * Call the Python history adapter.
 *
 * @param {object} [options]
 * @param {string} [options.globalStoragePath]
 * @param {Array<{query:string,reason:string,expectedScope:{workspace:string,workspacePath?:string,sinceTs?:number}}>} [options.queries]
 * @param {number} [options.limit]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ ok: boolean, results?: object[], queryPlan?: object[], truncated?: boolean, error?: string }>}
 */
function runHistorySearch(options = {}) {
  return new Promise((resolve) => {
    let pythonExe;
    try {
      pythonExe = resolveHermesPython();
    } catch (err) {
      resolve({ ok: false, error: `Hermes Python not found: ${err.message}` });
      return;
    }

    const hermesHome = options.hermes_home
      ? String(options.hermes_home)
      : (options.globalStoragePath
          ? getHermesHome(options.globalStoragePath)
          : (process.env.HERMES_HOME || ''));

    let child;
    try {
      child = spawn(pythonExe, [ADAPTER_SCRIPT], {
        env: { ...process.env, HERMES_HOME: hermesHome, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      resolve({ ok: false, error: `History adapter spawn failed: ${spawnErr.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      finalize({ ok: false, error: 'History adapter timed out' });
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      finalize({ ok: false, error: 'History adapter aborted' });
    };
    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener('abort', onAbort);
    }

    function finalize(payload) {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch {}
      if (options.signal) { try { options.signal.removeEventListener('abort', onAbort); } catch {} }
      try { child.kill(); } catch {}
      try { child.stdout.removeAllListeners('data'); } catch {}
      try { child.stderr.removeAllListeners('data'); } catch {}
      try { child.removeAllListeners('error'); } catch {}
      try { child.removeAllListeners('close'); } catch {}
      try { child.stdin.removeAllListeners('error'); } catch {}
      resolve(payload);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        finalize({ ok: false, error: 'History adapter stdout exceeded limit' });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_STDERR_BYTES) stderr = stderr.slice(0, MAX_STDERR_BYTES);
    });
    child.on('error', (err) => {
      finalize({ ok: false, error: `History adapter spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finalize({ ok: false, error: `History adapter exited ${code}: ${stderr.slice(0, 500)}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const validation = _validateResults(parsed);
        if (!validation.valid) {
          finalize({ ok: false, error: validation.error });
          return;
        }
        finalize({
          ok: true,
          results: parsed.results,
          queryPlan: parsed.queryPlan,
          truncated: parsed.truncated === true,
        });
      } catch (err) {
        finalize({ ok: false, error: `History adapter JSON parse error: ${err.message}` });
      }
    });
    child.stdin.on('error', (err) => {
      finalize({ ok: false, error: `History adapter stdin error: ${err.message}` });
    });

    try {
      child.stdin.write(JSON.stringify({
        hermes_home: hermesHome,
        queries: Array.isArray(options.queries) ? options.queries : [],
        limit: options.limit,
      }));
      child.stdin.end();
    } catch (err) {
      finalize({ ok: false, error: `History adapter stdin write failed: ${err.message}` });
    }
  });
}

module.exports = {
  runHistorySearch,
  TIMEOUT_MS,
  DTO_KEYS,
  REQUIRED_DTO_KEYS: DTO_KEYS.filter((k) => k !== 'workspacePath'),
  MAX_RESULTS,
  _validateResults,
  _forbiddenHit,
};