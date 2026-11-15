'use strict';

/*
 * hermes-pending-admin.js
 *
 * Node bridge to the Hermes write-approval pending store. Only the Trylo UI
 * (a VS Code command) calls this; the model never gets apply/discard as a
 * tool. It spawns ``hermes-capabilities/admin.py`` which wraps the official
 * ``tools.write_approval`` store, ``apply_*_pending`` replay functions,
 * and the L3 Skill snapshot / rollback operations - no pending logic is
 * reimplemented here (architecture section 5.2 / 10, 11 §2).
 *
 * The whole module goes through a single async helper `runAdminAsync` so
 * spawn lifecycle, signal handling, and listener cleanup have ONE owner.
 * `listPendingAsync` is just a thin alias over that helper; the Skill
 * snapshot / apply / rollback paths are explicit async wrappers around
 * the same helper.
 */

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const { ensureDataDir, getHermesHome } = require('./hermes-capability-manager');

// PATCH 3 (see desktop-services/vendor/PATCHES.md): resolve the Python
// capabilities dir from the host env (fallback keeps the upstream layout).
const ADMIN = path.join(
  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
  'admin.py',
);

const DEFAULT_TIMEOUT_MS = 30000;
const SHORT_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Synchronous fallback used only by the UI command paths that were
 * already on this API. New code paths (Skill snapshot, abortable
 * baseline) must use runAdminAsync. Do NOT use this for new code.
 */
function runAdmin(globalStoragePath, payload) {
  const pythonExe = resolveHermesPython();
  ensureDataDir(globalStoragePath);
  const result = spawnSync(pythonExe, [ADMIN], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HERMES_HOME: getHermesHome(globalStoragePath),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`admin exited ${result.status}: ${(result.stderr || '').slice(0, 300)}`);
  }
  const lines = (result.stdout || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('admin produced no output');
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * 11 §2.2: the SINGLE async admin helper. Used by listPendingAsync
 * and by every Skill snapshot/apply/list/rollback wrapper.
 *
 * Lifecycle (every exit goes through _finalize so timer + abort
 * listener + stream listeners are released exactly once):
 *   1. resolveHermesPython
 *   2. spawn the child with stdio = ['pipe','pipe','pipe']
 *   3. install stdout/stderr/error/close listeners
 *   4. attach the abort listener BEFORE writing the request
 *   5. write JSON to stdin and end stdin
 *   6. on close: parse the last non-empty JSON line and resolve
 *
 * Hard rules:
 *   - settleOnce(): no second resolve, no second kill
 *   - signal.aborted at entry -> do NOT spawn, return aborted result
 *   - timeout / abort -> kill child, return failure
 *   - stdout > cap OR stderr > cap -> fail closed
 *   - do NOT trust intermediate logs / Python warnings as the final JSON
 */
function runAdminAsync(globalStoragePath, payload, opts = {}) {
  return new Promise((resolve) => {
    let pythonExe;
    try {
      pythonExe = resolveHermesPython();
    } catch (err) {
      resolve({ success: false, error: `Hermes Python not found: ${err.message}` });
      return;
    }

    if (opts.signal && opts.signal.aborted) {
      resolve({ success: false, error: 'admin aborted before spawn' });
      return;
    }

    let storagePath;
    try {
      ensureDataDir(globalStoragePath);
      storagePath = globalStoragePath;
    } catch (err) {
      resolve({ success: false, error: `admin ensureDataDir failed: ${err.message}` });
      return;
    }

    let child;
    try {
      child = spawn(pythonExe, [ADMIN], {
        env: {
          ...process.env,
          HERMES_HOME: getHermesHome(storagePath),
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      resolve({ success: false, error: `admin spawn failed: ${spawnErr.message}` });
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      _finalize({ success: false, error: 'admin timed out' });
    }, timeoutMs);

    const onAbort = () => {
      _finalize({ success: false, error: 'admin aborted' });
    };
    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort);
    }

    function _finalize(payload) {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch {}
      if (opts.signal) {
        try { opts.signal.removeEventListener('abort', onAbort); } catch {}
      }
      try { child.kill(); } catch {}
      try { child.stdout.removeAllListeners('data'); } catch {}
      try { child.stderr.removeAllListeners('data'); } catch {}
      try { child.removeAllListeners('error'); } catch {}
      try { child.removeAllListeners('close'); } catch {}
      try { child.stdin.removeAllListeners('error'); } catch {}
      try { child.stdin.end(); } catch {}
      resolve(payload);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        _finalize({ success: false, error: 'admin stdout exceeded limit' });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_STDERR_BYTES) {
        stderr = stderr.slice(0, MAX_STDERR_BYTES);
      }
    });
    child.on('error', err => {
      _finalize({ success: false, error: `admin spawn error: ${err.message}` });
    });
    child.on('close', code => {
      if (code !== 0) {
        _finalize({
          success: false,
          error: `admin exited ${code}: ${stderr.slice(0, 500)}`,
        });
        return;
      }
      try {
        const lines = stdout.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) {
          _finalize({ success: false, error: 'admin produced no output' });
          return;
        }
        const parsed = JSON.parse(lines[lines.length - 1]);
        _finalize(parsed);
      } catch (err) {
        _finalize({ success: false, error: 'admin parse: ' + err.message });
      }
    });

    // Write the request and close stdin so the child EOF-wakes.
    try {
      child.stdin.on('error', () => { /* swallow EPIPE on early close */ });
      child.stdin.write(JSON.stringify(payload || {}));
      child.stdin.end();
    } catch (err) {
      _finalize({ success: false, error: 'admin stdin write failed: ' + err.message });
    }
  });
}

/**
 * 11 §3 A2: listPendingAsync is now a thin wrapper over runAdminAsync.
 * 2-second default timeout. AbortSignal-friendly. Used by the
 * foreground preflight. The shared async helper is also the path
 * for Skill snapshot / apply / rollback.
 */
function listPendingAsync(globalStoragePath, opts = {}) {
  return runAdminAsync(globalStoragePath, { op: 'list' }, {
    timeoutMs: opts.timeoutMs || 2000,
    signal: opts.signal || undefined,
  }).then(r => {
    if (!r) return { success: false, pending: [], count: 0 };
    if (r.success && Array.isArray(r.pending)) {
      return r;
    }
    return { success: false, pending: [], count: 0, error: r.error };
  });
}

/**
 * 11 §2.3: Skill apply + snapshot in ONE Python transaction. The
 * Python admin side handles get_pending -> anti-swap -> official
 * snapshot_skills -> official apply_skill_pending -> discard. The
 * Node side never touches `upstream.py` or `apply_skill_pending`
 * directly; the only path is admin.py.
 */
function applySkillWithSnapshotAsync(globalStoragePath, params, opts = {}) {
  return runAdminAsync(globalStoragePath, {
    op: 'apply_skill_with_snapshot',
    id: params.id,
    expectedHash: params.expectedHash,
    reason: params.reason || `trylo-before-apply:${params.id}`,
  }, {
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    signal: opts.signal || undefined,
  });
}

/**
 * 11 §2.4: list the official Skill backups. Node side only
 * forwards the call.
 */
function listSkillBackupsAsync(globalStoragePath, opts = {}) {
  return runAdminAsync(globalStoragePath, { op: 'list_skill_backups' }, {
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    signal: opts.signal || undefined,
  });
}

/**
 * 11 §2.4: rollback the official Skill tree to a backup. The
 * `snapshotId` MUST come from the immediately-preceding
 * listSkillBackupsAsync call; the Python side also validates against
 * the live list before doing anything.
 */
function rollbackSkillBackupAsync(globalStoragePath, snapshotId, opts = {}) {
  return runAdminAsync(globalStoragePath, {
    op: 'rollback_skill_backup',
    snapshotId,
  }, {
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    signal: opts.signal || undefined,
  });
}

/* -------------------------------------------------------------------------
 *  Synchronous legacy API (kept for code paths that were already on it).
 *  Do NOT introduce new callers; use the async wrappers above.
 * ------------------------------------------------------------------------- */
function listPending(globalStoragePath) {
  try {
    return runAdmin(globalStoragePath, { op: 'list' });
  } catch {
    return { success: false, pending: [], count: 0 };
  }
}
function getDetail(globalStoragePath, subsystem, id) {
  return runAdmin(globalStoragePath, { op: 'get', subsystem, id });
}
function applyPending(globalStoragePath, subsystem, id, expectedHash) {
  const payload = { op: 'apply', subsystem, id };
  if (expectedHash) payload.expectedHash = expectedHash;
  return runAdmin(globalStoragePath, payload);
}
function discardPending(globalStoragePath, subsystem, id) {
  return runAdmin(globalStoragePath, { op: 'discard', subsystem, id });
}

/**
 * 39 C1 (P0): proposeSkillAsync is the ONLY allowed production staging
 * path. It calls the official Python `skill_propose` LLM tool via
 * admin.py::op='propose_skill'. The response is the raw JSON
 * returned by the official tool — the same one an LLM would
 * receive. JS callers MUST parse `success`/`staged`/`pending_id`
 * from the result themselves; the bridge does NOT translate.
 *
 * This is the spec-mandated replacement for the previous
 * `runAdminAsync({op:'apply'})` and the fabricated `l5-pending-*`
 * / `l5-headless-*` IDs. staging a proposal must produce a real
 * Hermes pending record — verifiable via listPendingAsync.
 */
function proposeSkillAsync(globalStoragePath, params, opts = {}) {
  return runAdminAsync(globalStoragePath, {
    op: 'propose_skill',
    action: params.action || '',
    name: params.name || '',
    content: params.content,
    category: params.category,
    file_path: params.file_path,
    file_content: params.file_content,
    old_string: params.old_string,
    new_string: params.new_string,
    replace_all: !!params.replace_all,
  }, {
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    signal: opts.signal || undefined,
  });
}

module.exports = {
  // The single async helper (low-level, exported for tests).
  runAdminAsync,
  // Async wrappers (production code paths).
  listPendingAsync,
  applySkillWithSnapshotAsync,
  proposeSkillAsync,
  listSkillBackupsAsync,
  rollbackSkillBackupAsync,
  // Legacy sync (do not use in new code).
  listPending,
  getDetail,
  applyPending,
  discardPending,
};
