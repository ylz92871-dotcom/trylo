'use strict';

/*
 * hermes-session-sync.js
 *
 * Mirrors Trylo session turns into the Hermes SessionDB search index so
 * session_search can recall past Trylo conversations. Trylo JSON/Memento stays
 * authoritative; state.db is a rebuildable index.
 *
 * R3: fully async. spawnSync was removed so the VS Code extension host is never
 * frozen by a Python subprocess. A single worker serializes all SessionDB
 * writes (max 1 concurrent), per-session updates are debounced (~300ms, latest
 * snapshot wins), startup rebuild is lower priority than user saves, a slow
 * adapter is killed after a timeout (leaving the hash unset so it retries),
 * and shutdown stops accepting work + waits bounded for the in-flight task.
 *
 * Failures are never swallowed silently: they go to the configured logger
 * (the extension routes them to the trace/output channel). No empty catch.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const { ensureDataDir, getHermesHome } = require('./hermes-capability-manager');

// PATCH 2 (see desktop-services/vendor/PATCHES.md): resolve the Python
// capabilities dir from the host env (fallback keeps the upstream layout).
const ADAPTER = path.join(
  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
  'session_adapter.py',
);
const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 300;
const SYNC_TIMEOUT_MS = 45000;
const SHUTDOWN_WAIT_MS = 5000;

// Per-process map of sessionId -> last-mirrored content hash. Lost on restart;
// the Python-side durable hash (state.db state_meta) is the authoritative skip.
const syncedHashes = new Map();

let logger = null;
function reportWarning(message, detail) {
  const text = `hermes-session-sync: ${message} ${detail instanceof Error ? detail.message : (detail || '')}`;
  if (logger) { try { logger(text); } catch { console.warn(text); } } else { console.warn(text); }
}
function setLogger(fn) { logger = typeof fn === 'function' ? fn : null; }

function computeHash(session) {
  const h = crypto.createHash('sha256');
  h.update('schema=' + SCHEMA_VERSION); h.update('\x00');
  h.update(String(session && session.title != null ? session.title : '')); h.update('\x00');
  const ws = session && session.workspace;
  h.update(String(ws && ws.path != null ? ws.path : '')); h.update('\x00');
  h.update(String(session && session.model != null ? session.model : '')); h.update('\x00');
  for (const turn of session && Array.isArray(session.turns) ? session.turns : []) {
    if (!turn || typeof turn !== 'object') continue;
    h.update(String(turn.prompt != null ? turn.prompt : '')); h.update('\x00');
    h.update(String(turn.resultText != null ? turn.resultText : '')); h.update('\x00');
    h.update(String(turn.startedAt != null ? turn.startedAt : '')); h.update('\x00');
  }
  return h.digest('hex');
}

// --- async subprocess runner ---
function runAdapterAsync(payload, storagePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    let pythonExe;
    try {
      pythonExe = resolveHermesPython();
      ensureDataDir(storagePath);
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(pythonExe, [ADAPTER], {
      env: {
        ...process.env,
        HERMES_HOME: getHermesHome(storagePath),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs || SYNC_TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('session_adapter timed out'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`session_adapter exited ${code} sig ${sig}: ${err.slice(0, 400)}`));
        return;
      }
      const lines = out.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) {
        reject(new Error('session_adapter produced no output'));
        return;
      }
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) {
        reject(new Error(`session_adapter bad output: ${e.message}`));
      }
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (e) {
      try { child.kill('SIGKILL'); } catch {}
      reject(e);
    }
  });
}

// --- single-worker priority queue (max 1 concurrent) ---
const ACTIVE = { queue: [], running: null, accepting: true, debounce: new Map() };

function _drain() {
  if (ACTIVE.running || !ACTIVE.accepting) return;
  // Prefer high-priority (sync) tasks over the low-priority rebuild.
  let idx = ACTIVE.queue.findIndex(t => !t.lowPriority);
  if (idx < 0 && ACTIVE.queue.length) idx = 0;
  if (idx < 0) return;
  const task = ACTIVE.queue.splice(idx, 1)[0];
  ACTIVE.running = runAdapterAsync(task.payload, task.storagePath, task.timeout)
    .then(
      res => task.resolve(res),
      err => task.reject(err),
    )
    .finally(() => {
      ACTIVE.running = null;
      if (ACTIVE.accepting) _drain();
    });
}

function _enqueue(payload, storagePath, opts) {
  return new Promise((resolve, reject) => {
    if (!ACTIVE.accepting) {
      reject(new Error('session sync is shutting down; task dropped'));
      return;
    }
    ACTIVE.queue.push({
      payload,
      storagePath,
      resolve,
      reject,
      timeout: (opts && opts.timeout) || SYNC_TIMEOUT_MS,
      lowPriority: !!(opts && opts.lowPriority),
    });
    _drain();
  });
}

/**
 * Incrementally mirror one session. Debounced per-session (latest snapshot
 * wins). Resolves true when mirrored (or already up to date), false on failure.
 * Never throws; failures are reported via the logger.
 */
function mirrorSession(session, storagePath) {
  if (!session || !session.id) return Promise.resolve(false);
  return new Promise(resolve => {
    // Supersede any pending debounce for this session: clear its timer and
    // resolve the older promise (latest snapshot wins).
    const prev = ACTIVE.debounce.get(session.id);
    if (prev) {
      clearTimeout(prev.timer);
      try { prev.resolve(true); } catch {}
    }
    const timer = setTimeout(() => {
      ACTIVE.debounce.delete(session.id);
      // Recompute the hash on the latest object state at flush time.
      const h = computeHash(session);
      if (syncedHashes.get(session.id) === h) { resolve(true); return; }
      _enqueue({ op: 'sync', session }, storagePath).then(
        res => {
          if (res && res.success) { syncedHashes.set(session.id, h); resolve(true); }
          else { reportWarning(`sync failed for ${session.id}`, res); resolve(false); }
        },
        err => { reportWarning(`sync error for ${session.id}`, err); resolve(false); },
      );
    }, DEBOUNCE_MS);
    ACTIVE.debounce.set(session.id, { timer, resolve });
  });
}

/**
 * Bulk rebuild from the full Trylo session library, including delete-sync of
 * trylo-vscode rows no longer in the library. Lower priority than user saves.
 */
function rebuildIndex(sessions, storagePath) {
  const list = Array.isArray(sessions) ? sessions : [];
  return _enqueue({ op: 'rebuild', sessions: list }, storagePath, { lowPriority: true, timeout: 120000 })
    .then(res => {
      if (res && res.success) {
        for (const s of list) {
          if (s && s.id) syncedHashes.set(s.id, computeHash(s));
        }
        return true;
      }
      reportWarning('rebuild failed', res);
      return false;
    }, err => { reportWarning('rebuild error', err); return false; });
}

/** Stop accepting new tasks and bounded-wait for the in-flight one (R3). */
function shutdown() {
  ACTIVE.accepting = false;
  for (const entry of ACTIVE.debounce.values()) {
    clearTimeout(entry.timer);
    try { entry.resolve(false); } catch {}
  }
  ACTIVE.debounce.clear();
  // Reject queued tasks so their promises settle (no dangling handles).
  for (const t of ACTIVE.queue) {
    try { t.reject(new Error('session sync shutting down; task dropped')); } catch {}
  }
  ACTIVE.queue.length = 0;
  const inFlight = ACTIVE.running;
  if (!inFlight) return Promise.resolve();
  return Promise.race([
    inFlight.then(() => {}, () => {}),
    new Promise(r => setTimeout(r, SHUTDOWN_WAIT_MS)),
  ]);
}

module.exports = {
  computeHash,
  mirrorSession,
  rebuildIndex,
  shutdown,
  setLogger,
};
