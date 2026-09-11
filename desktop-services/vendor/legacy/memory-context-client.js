'use strict';

/*
 * memory-context-client.js
 *
 * Node-side async client for the frozen Hermes Memory snapshot.
 * Calls the official Hermes 0.19.0 MemoryStore via
 * `hermes-capabilities/memory_context_adapter.py` and returns a
 * validated JSON object.
 *
 * 05 §5 Phase B1 — frozen memory snapshot client.
 *
 * Hard rules:
 *   - async spawn only (never spawnSync)
 *   - timeout, stdout/stderr caps, abort, exit code check
 *   - schema + hash + version validation
 *   - returns { ok: false } on any failure so the original Trylo
 *     Agent silently degrades (Memory is non-essential)
 *   - never re-parses MEMORY/USER content in Node
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveHermesPython } = require('./hermes-python-resolver');
const { getHermesHome } = require('./hermes-capability-manager');

// PATCH 4 (see desktop-services/vendor/PATCHES.md): resolve the Python
// capabilities dir from the host env (fallback keeps the upstream layout).
const ADAPTER_SCRIPT = path.join(
  process.env.TRYLO_HERMES_CAPABILITIES_DIR || path.join(__dirname, 'hermes-capabilities'),
  'memory_context_adapter.py',
);

const TIMEOUT_MS = 10000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const EXPECTED_HERMES_VERSION = '0.19.0';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

const REQUIRED_KEYS = [
  'success', 'schemaVersion', 'hermesVersion',
  'memoryBlock', 'userBlock',
  'memoryCharCount', 'userCharCount',
  'memoryHash', 'userHash', 'snapshotHash',
  'frozenAt',
];

/**
 * Strictly validate the adapter response. Returns { valid, error? }.
 */
function _validateSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'adapter output is not an object' };
  }
  if (parsed.success !== true) {
    return { valid: false, error: String(parsed.error || 'adapter reported failure') };
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) {
      return { valid: false, error: `missing required key: ${key}` };
    }
  }
  if (parsed.schemaVersion !== 1) {
    return { valid: false, error: `unsupported schemaVersion: ${parsed.schemaVersion}` };
  }
  if (String(parsed.hermesVersion || '') !== EXPECTED_HERMES_VERSION) {
    return { valid: false, error: `hermes version mismatch: ${parsed.hermesVersion}` };
  }
  if (typeof parsed.memoryBlock !== 'string' || typeof parsed.userBlock !== 'string') {
    return { valid: false, error: 'memoryBlock/userBlock must be strings' };
  }
  for (const h of ['memoryHash', 'userHash', 'snapshotHash']) {
    if (!SHA256_RE.test(String(parsed[h] || ''))) {
      return { valid: false, error: `${h} is not a valid sha256 hash` };
    }
  }
  // Verify the two block hashes match the content
  const crypto = require('node:crypto');
  const expectedMemHash = 'sha256:' + crypto.createHash('sha256').update(parsed.memoryBlock, 'utf8').digest('hex');
  if (expectedMemHash !== parsed.memoryHash) {
    return { valid: false, error: 'memoryBlock hash mismatch (content was tampered in transit)' };
  }
  const expectedUserHash = 'sha256:' + crypto.createHash('sha256').update(parsed.userBlock, 'utf8').digest('hex');
  if (expectedUserHash !== parsed.userHash) {
    return { valid: false, error: 'userBlock hash mismatch' };
  }
  // Verify the snapshot hash
  const expectedSnapHash = 'sha256:' + crypto.createHash('sha256')
    .update(parsed.memoryHash + '|' + parsed.userHash, 'utf8').digest('hex');
  if (expectedSnapHash !== parsed.snapshotHash) {
    return { valid: false, error: 'snapshotHash mismatch' };
  }
  return { valid: true };
}

/**
 * Call the Python snapshot adapter.
 *
 * 07 §2 E1/E2: accepts an optional AbortSignal. On abort, the child
 * process is killed and timer + child listeners are cleaned up. All
 * early-exit paths (resolve once, then nothing) go through one
 * `_finalize(...)` helper that clears the timer and removes listeners
 * to prevent leaks.
 *
 * @param {object} [options]
 * @param {string} [options.globalStoragePath] - VS Code globalStorage for HERMES_HOME
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ ok: boolean, snapshot?: object, error?: string }>}
 */
function fetchMemorySnapshot(options = {}) {
  return new Promise((resolve) => {
    let pythonExe;
    try {
      pythonExe = resolveHermesPython();
    } catch (err) {
      resolve({ ok: false, error: `Hermes Python not found: ${err.message}` });
      return;
    }

    const hermesHome = options.globalStoragePath
      ? getHermesHome(options.globalStoragePath)
      : (process.env.HERMES_HOME || '');

    let child;
    try {
      child = spawn(pythonExe, [ADAPTER_SCRIPT], {
        env: {
          ...process.env,
          HERMES_HOME: hermesHome,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      resolve({ ok: false, error: `Memory snapshot adapter spawn failed: ${spawnErr.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      finalize({ ok: false, error: 'Memory snapshot adapter timed out' });
    }, timeoutMs);

    // 07 §2 E1: abort support.
    const onAbort = () => {
      if (settled) return;
      finalize({ ok: false, error: 'Memory snapshot adapter aborted' });
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort);
    }

    function finalize(payload) {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch {}
      if (options.signal) {
        try { options.signal.removeEventListener('abort', onAbort); } catch {}
      }
      // Kill the child and detach listeners to avoid leaks.
      try { child.kill(); } catch {}
      try { child.stdout.removeAllListeners('data'); } catch {}
      try { child.stderr.removeAllListeners('data'); } catch {}
      try { child.removeAllListeners('error'); } catch {}
      try { child.removeAllListeners('close'); } catch {}
      try { child.stdin.removeAllListeners('error'); } catch {}
      resolve(payload);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) {
        finalize({ ok: false, error: 'Memory snapshot adapter stdout exceeded limit' });
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
      finalize({ ok: false, error: `Memory snapshot adapter spawn failed: ${err.message}` });
    });

    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        finalize({ ok: false, error: `Memory snapshot adapter exited ${code}: ${stderr.slice(0, 500)}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const validation = _validateSnapshot(parsed);
        if (!validation.valid) {
          finalize({ ok: false, error: validation.error });
          return;
        }
        finalize({ ok: true, snapshot: parsed });
      } catch (err) {
        finalize({ ok: false, error: `Memory snapshot JSON parse error: ${err.message}` });
      }
    });

    child.stdin.on('error', err => {
      finalize({ ok: false, error: `Memory snapshot stdin error: ${err.message}` });
    });

    try {
      child.stdin.write(JSON.stringify({ hermes_home: hermesHome }));
      child.stdin.end();
    } catch (err) {
      finalize({ ok: false, error: `Memory snapshot stdin write failed: ${err.message}` });
    }
  });
}

module.exports = {
  fetchMemorySnapshot,
  TIMEOUT_MS,
  EXPECTED_HERMES_VERSION,
  _validateSnapshot,
};
