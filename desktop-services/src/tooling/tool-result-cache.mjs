// Trylo Desktop Services — BinaryRef tool-cache TTL sweeper (PR-4, §7.1).
//
// The renderer's stream translator writes MCP image/audio/binary payloads
// into `<appDataDir>/tool-cache/…` (content-addressed, sha256-named) and
// the session record only ever persists BinaryRef metadata. The spec gives
// those bytes a bounded life: 「默认 24 小时或会话删除时回收」. The renderer
// has no delete-capable fs command, so — same split as the artifact
// promoter — FS truth for cleanup lives here: a bounded, best-effort sweep
// that deletes files whose mtime is older than the TTL, then prunes empty
// fan-out directories.
//
// Failure policy: never throws. A failed/unreadable entry is skipped and
// counted; the next sweep retries. The root is CONSTRUCTED from the
// sidecar's own appDataDir — never taken from a caller-supplied path —
// and the walk stays inside it (depth ≤ 2, bounded entries, symlinks
// skipped via dirent types, matching the promoter's trust boundary).

import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Bounded work per sweep: a huge backlog is drained sweep-by-sweep. */
const MAX_ENTRIES_PER_SWEEP = 2000;
const MAX_DEPTH = 2;

/**
 * @param {{ appDataDir?: string, ttlMs?: number, now?: () => number,
 *            sweepIntervalMs?: number }} [options]
 */
export function createToolResultCache(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const root = typeof options.appDataDir === 'string' && options.appDataDir !== ''
    ? path.join(options.appDataDir, 'tool-cache')
    : null;
  let timer = null;

  /**
   * One bounded sweep. Returns counters the caller can log or surface in
   * diagnostics; `reasonCode: 'no_root'` when no appDataDir was configured
   * (degraded environments), `'root_missing'` when nothing was cached yet.
   */
  async function sweep() {
    if (!root) return { ok: false, reasonCode: 'no_root', root: null, removed: 0, scanned: 0 };
    const stats = { ok: true, root, removed: 0, scanned: 0 };
    const cutoff = now() - ttlMs;
    const dirs = [];
    await walk(root, root, cutoff, dirs, stats, 0);
    // Prune fan-out dirs that became empty (never the root itself).
    for (const dir of dirs) {
      try {
        await fsp.rmdir(dir); // rmdir only removes EMPTY directories
      } catch {
        // Not empty (fresh files arrived) or already gone — fine either way.
      }
    }
    return stats;
  }

  async function walk(rootDir, dir, cutoff, dirs, stats, depth) {
    if (stats.scanned >= MAX_ENTRIES_PER_SWEEP || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stats.scanned >= MAX_ENTRIES_PER_SWEEP) return;
      const full = path.join(dir, entry.name);
      // Dirent types: symlinks are neither file nor directory here —
      // a planted link can never steer the sweep out of the cache root.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) dirs.push(full);
        await walk(rootDir, full, cutoff, dirs, stats, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      stats.scanned += 1;
      let mtimeMs = 0;
      try {
        mtimeMs = (await fsp.stat(full)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > cutoff) continue;
      try {
        await fsp.rm(full, { force: true });
        stats.removed += 1;
      } catch {
        // Locked by a concurrent render — the next sweep retries.
      }
    }
  }

  /** Hourly background sweep + one at startup (unref'd: the Service Host
   *  must never be kept alive by cleanup work). */
  function start(intervalMs = DEFAULT_SWEEP_INTERVAL_MS) {
    if (!root || timer) return;
    void sweep().catch(() => {});
    timer = setInterval(() => {
      void sweep().catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { sweep, start, stop, root };
}

export default createToolResultCache;
