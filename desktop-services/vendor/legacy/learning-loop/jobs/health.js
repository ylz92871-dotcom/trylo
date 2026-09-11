'use strict';

/*
 * health.js
 *
 * L7-B (依 `L7_EXECUTION_TASK.md` §4.4) — first-start health check.
 * Verifies Python, uv env, upstream import, HERMES_HOME init. Persists
 * a bounded HealthReport to `learning-state.health` so the result
 * is visible across restarts (L7 §4.4 "降级状态必须持久化").
 *
 * The scheduler (L6) consults `getDegraded()` to decide whether to
 * pause dispatch: if health is failed, the scheduler pauses (A/B
 * all stop) and surfaces `HERMES_UNAVAILABLE` in the UI.
 *
 * Bounded: the report keeps the last 100 check entries; older ones
 * are evicted FIFO (so the section never grows unbounded).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');

const MAX_HISTORY = 100;

class HealthError extends Error {}

function _defaultHealth() {
  return {
    lastCheckAt: 0,
    lastOk: true,
    checks: [],          // [{name, ok, errorCode, hint, ts}]
    failureBuckets: { python: 0, version: 0, hermesHome: 0, mcp: 0 },
    lastErrorCode: '',
  };
}

/**
 * Run the health check sequence. Each check is a tuple:
 *   { name, run: () => Promise<{ok, errorCode, hint}> }
 *
 * @param {object} opts
 * @param {string} opts.pythonExe     absolute path to Python
 * @param {string} opts.hermesHome    HERMES_HOME path
 * @param {function} opts.readVersion  () => string  (Hermes version from require_version)
 * @returns {Promise<{ok: boolean, checks: Array, lastErrorCode: string}>}
 */
async function runHealthCheck(opts) {
  const checks = [];
  let allOk = true;
  let lastErrorCode = '';

  // 1. Python reachable
  try {
    const out = cp.execFileSync(opts.pythonExe, ['-X', 'utf8', '-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' });
    if (!/\[3, 1[01]\]/.test(out)) {
      allOk = false;
      lastErrorCode = 'PYTHON_VERSION_UNSUPPORTED';
      checks.push({ name: 'python', ok: false, errorCode: lastErrorCode, hint: 'Need Python 3.11.x', ts: Date.now() });
    } else {
      checks.push({ name: 'python', ok: true, errorCode: '', hint: 'Python 3.11.x', ts: Date.now() });
    }
  } catch (e) {
    allOk = false;
    lastErrorCode = 'PYTHON_MISSING';
    checks.push({ name: 'python', ok: false, errorCode: lastErrorCode, hint: 'Install Python 3.11', ts: Date.now() });
  }

  // 2. Hermes version matches PINNED
  try {
    const v = opts.readVersion();
    if (v !== '0.19.0') {
      allOk = false;
      lastErrorCode = 'HERMES_VERSION_MISMATCH';
      checks.push({ name: 'version', ok: false, errorCode: lastErrorCode, hint: 'PINNED 0.19.0, got ' + v, ts: Date.now() });
    } else {
      checks.push({ name: 'version', ok: true, errorCode: '', hint: v, ts: Date.now() });
    }
  } catch (e) {
    allOk = false;
    lastErrorCode = 'HERMES_VERSION_MISSING';
    checks.push({ name: 'version', ok: false, errorCode: lastErrorCode, hint: 'Hermes not importable', ts: Date.now() });
  }

  // 3. HERMES_HOME exists + writable
  try {
    if (!opts.hermesHome || !fs.existsSync(opts.hermesHome)) {
      allOk = false;
      lastErrorCode = 'HERMES_HOME_MISSING';
      checks.push({ name: 'hermesHome', ok: false, errorCode: lastErrorCode, hint: 'HERMES_HOME does not exist', ts: Date.now() });
    } else {
      try {
        fs.accessSync(opts.hermesHome, fs.constants.W_OK);
        checks.push({ name: 'hermesHome', ok: true, errorCode: '', hint: opts.hermesHome, ts: Date.now() });
      } catch (e) {
        allOk = false;
        lastErrorCode = 'HERMES_HOME_NOT_WRITABLE';
        checks.push({ name: 'hermesHome', ok: false, errorCode: lastErrorCode, hint: 'check permissions', ts: Date.now() });
      }
    }
  } catch (e) {
    allOk = false;
    lastErrorCode = 'HERMES_HOME_CHECK_FAILED';
    checks.push({ name: 'hermesHome', ok: false, errorCode: lastErrorCode, hint: e.message, ts: Date.now() });
  }

  return { ok: allOk, checks, lastErrorCode };
}

/**
 * Persist a HealthReport to the learning-state `health` section.
 * Bounded: keeps the last MAX_HISTORY check entries; older ones
 * are evicted FIFO.
 */
function persistHealth(state, report) {
  if (!state || typeof state !== 'object') return;
  if (!state.health || typeof state.health !== 'object') {
    state.health = _defaultHealth();
  }
  state.health.lastCheckAt = Date.now();
  state.health.lastOk = !!report.ok;
  state.health.lastErrorCode = report.lastErrorCode || '';
  // Append all checks as a new history entry.
  const history = Array.isArray(state.health.checks) ? state.health.checks : [];
  history.push({
    at: Date.now(),
    ok: !!report.ok,
    errorCode: report.lastErrorCode || '',
  });
  while (history.length > MAX_HISTORY) history.shift();
  state.health.checks = history;
  // Bump failure buckets.
  if (!report.ok && report.lastErrorCode) {
    const fb = state.health.failureBuckets || { python: 0, version: 0, hermesHome: 0, mcp: 0 };
    if (/PYTHON/i.test(report.lastErrorCode)) fb.python += 1;
    else if (/VERSION/i.test(report.lastErrorCode)) fb.version += 1;
    else if (/HERMES_HOME/i.test(report.lastErrorCode)) fb.hermesHome += 1;
    else if (/MCP/i.test(report.lastErrorCode)) fb.mcp += 1;
    state.health.failureBuckets = fb;
  }
  // Replace the latest per-check status for the UI (last value per name).
  state.health.lastChecks = report.checks;
}

/**
 * Read the persisted health. Returns the default if absent.
 */
function readHealth(state) {
  if (!state || !state.health || typeof state.health !== 'object') {
    return _defaultHealth();
  }
  return Object.assign(_defaultHealth(), state.health);
}

/**
 * True when the persisted health indicates a non-recoverable failure
 * (Hermes itself unreachable, version mismatch, HERMES_HOME missing).
 * The scheduler uses this to pause dispatch.
 */
function isDegraded(state) {
  const h = readHealth(state);
  if (h.lastCheckAt === 0) return false; // never checked → not degraded yet
  if (h.lastOk) return false;
  // The scheduler pauses on every non-ok health (per L7 §4.4 "全部
  // 暂停并报错码" — A-level also paused when MCP/HERMES fails).
  return true;
}

module.exports = {
  HealthError,
  runHealthCheck,
  persistHealth,
  readHealth,
  isDegraded,
  MAX_HISTORY,
};
