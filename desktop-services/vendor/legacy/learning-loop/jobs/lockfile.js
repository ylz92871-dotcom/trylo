'use strict';

/*
 * lockfile.js
 *
 * L6 (F2 P1-3) cross-window job lock. VS Code's Memento (`globalState`)
 * is NOT shared across windows of the same extension: each window has
 * its own in-memory cache, and `update` in window A does not become
 * visible to window B. The earlier `jobs.lock` field in the state
 * blob therefore did not actually serialize dispatch across windows.
 *
 * This module uses an OS-level lockfile under
 * `context.globalStorageUri.fsPath/trylo-jobs.lock`. The FS IS shared
 * between windows of the same VS Code install, so this is the
 * authoritative cross-window mutex.
 *
 * Layout:
 *   {globalStorage}/trylo-jobs.lock       // the lockfile itself
 *   content: JSON { ownerId, acquiredAt } // atomically written
 *
 * Semantics:
 *   - acquire(dir, ownerId, staleMs) ->
 *       { ok: true,  preempted: bool, lockState }   // we own it
 *       { ok: false, lockState }                    // someone else does
 *   - heartbeat(dir, ownerId) -> updates mtime + content; fails if
 *       we are not the current owner.
 *   - release(dir, ownerId) -> unlink (only if we own).
 *
 * Stale lock:
 *   - If the file's mtime is older than staleMs, the holder is
 *     presumed dead. We unlink + retry once.
 *   - This means a crashed window's lock is auto-cleared after
 *     staleMs (default 2*tickMs = 60s).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const LOCK_FILENAME = 'trylo-jobs.lock';

function _lockPath(dir) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('lockfile: dir is required');
  }
  return path.join(dir, LOCK_FILENAME);
}

async function _safeReadJson(p) {
  try {
    const text = await fsp.readFile(p, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function _isStale(lockState, staleMs, now) {
  if (!lockState || typeof lockState.heartbeatAt !== 'number') return true;
  return (now - lockState.heartbeatAt) > staleMs;
}

class LockfileError extends Error {}

/**
 * Try to acquire the lock.
 *
 * @param {string} dir - globalStorage path
 * @param {string} ownerId
 * @param {number} staleMs - heartbeat threshold
 * @returns {Promise<{ ok: boolean, preempted?: boolean, lockState: object|null }>}
 */
async function acquire(dir, ownerId, staleMs) {
  if (!ownerId) throw new LockfileError('lockfile: ownerId is required');
  const p = _lockPath(dir);
  const now = Date.now();
  // Fast path: try to create the lockfile with O_EXCL semantics.
  try {
    const handle = await fsp.open(p, 'wx');
    try {
      const payload = JSON.stringify({ ownerId, acquiredAt: now, heartbeatAt: now });
      await handle.writeFile(payload, 'utf8');
    } finally {
      await handle.close();
    }
    return { ok: true, preempted: false, lockState: { ownerId, acquiredAt: now, heartbeatAt: now } };
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      // Filesystem error other than "already exists" — propagate.
      throw err;
    }
  }
  // Lockfile exists. Read the current holder.
  const current = await _safeReadJson(p);
  if (current && current.ownerId === ownerId) {
    // Same owner: heartbeat update.
    const next = { ...current, heartbeatAt: now };
    try {
      await fsp.writeFile(p, JSON.stringify(next), 'utf8');
    } catch (e) { /* best-effort */ }
    return { ok: true, preempted: false, lockState: next };
  }
  // Different owner. Is it stale?
  if (_isStale(current, staleMs, now)) {
    // Stale lock: unlink and retry once.
    try { await fsp.unlink(p); } catch {}
    return acquire(dir, ownerId, staleMs);
  }
  return { ok: false, lockState: current };
}

/**
 * Refresh the heartbeat. No-op if we don't own the lock.
 *
 * @param {string} dir
 * @param {string} ownerId
 * @returns {Promise<boolean>} true if heartbeat applied, false otherwise
 */
async function heartbeat(dir, ownerId) {
  const p = _lockPath(dir);
  const current = await _safeReadJson(p);
  if (!current || current.ownerId !== ownerId) return false;
  const now = Date.now();
  const next = { ...current, heartbeatAt: now };
  try {
    await fsp.writeFile(p, JSON.stringify(next), 'utf8');
    // Also touch mtime explicitly so external stat-based tools (ls -l)
    // see the recent activity. writeFile already updates mtime.
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the lock. No-op if we don't own it.
 *
 * @param {string} dir
 * @param {string} ownerId
 * @returns {Promise<boolean>} true if released, false if not owner
 */
async function release(dir, ownerId) {
  const p = _lockPath(dir);
  const current = await _safeReadJson(p);
  if (!current || current.ownerId !== ownerId) return false;
  try { await fsp.unlink(p); return true; } catch { return false; }
}

/**
 * Inspect the current lock without acquiring.
 *
 * @param {string} dir
 * @returns {Promise<object|null>}
 */
async function inspect(dir) {
  const p = _lockPath(dir);
  return _safeReadJson(p);
}

module.exports = {
  LOCK_FILENAME,
  LockfileError,
  acquire,
  heartbeat,
  release,
  inspect,
};
