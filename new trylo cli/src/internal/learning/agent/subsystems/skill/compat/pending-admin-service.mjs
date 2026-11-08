// Trylo Desktop Services — staged pending admin adapter (Phase 3B).
// See migration spec §7.5 and architecture doc §6.6.
//
// Thin adapter over the vendored `hermes-pending-admin.js` → `admin.py` → the
// official Hermes write-approval store. All long-lived Hermes writes are
// staged and require user approval; nothing here writes directly.
//
// Ownership: Desktop decides WHAT the user approved; `admin.py` decides HOW a
// staged write is committed (snapshot → anti-swap → apply → discard).
//
// Failure policy (spec §7.5 / arch §6.3):
//   - `apply` is fail-closed: it MUST carry both `pendingId` and
//     `expectedHash`; a missing hash is rejected here before Python is
//     spawned, so a stale UI can never commit content the user did not review.
//   - Every other failure is reported, never swallowed — an infrastructure
//     error must not look like "no pending items".

import { requireLegacyVendor } from './vendor-path.mjs';

const VALID_SUBSYSTEMS = new Set(['memory', 'skills']);

function fail(message, code = 'INVALID_PARAMS') {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * @param {{ storageRoot: string, timeoutMs?: number, admin?: object|null }} options
 *   `admin` is a test seam only — production uses the vendored module.
 */
export function createPendingAdminService({ storageRoot, timeoutMs, admin: injectedAdmin = null } = {}) {
  let admin = injectedAdmin;
  function legacy() {
    if (!admin) admin = requireLegacyVendor('hermes-pending-admin.js');
    return admin;
  }

  function opts(extra) {
    const merged = {};
    if (typeof timeoutMs === 'number') merged.timeoutMs = timeoutMs;
    return { ...merged, ...extra };
  }

  function requireStorage() {
    if (!storageRoot) fail('hermes storage root is not configured', 'NOT_CONFIGURED');
  }

  function requireSubsystem(subsystem) {
    if (!VALID_SUBSYSTEMS.has(subsystem)) {
      fail(`unknown pending subsystem '${String(subsystem)}'`, 'INVALID_PARAMS');
    }
  }

  return {
    /** List every staged proposal (memory + skills). */
    async list() {
      requireStorage();
      const result = await legacy().listPendingAsync(storageRoot, opts());
      if (!result || typeof result !== 'object') {
        return { ok: false, pending: [], count: 0, error: 'pending admin returned no result' };
      }
      return {
        ok: Boolean(result.success),
        pending: Array.isArray(result.pending) ? result.pending : [],
        count: typeof result.count === 'number' ? result.count : (result.pending || []).length,
        error: result.error ?? null,
      };
    },

    /** One proposal's detail (used to obtain the `expectedHash` for apply). */
    async detail({ subsystem, id }) {
      requireStorage();
      requireSubsystem(subsystem);
      if (!id) fail('pending detail requires an id');
      const result = await legacy().runAdminAsync(storageRoot, { op: 'get', subsystem, id }, opts());
      if (!result || typeof result !== 'object') {
        return { ok: false, error: 'pending admin returned no result' };
      }
      return { ok: Boolean(result.success), detail: result, error: result.error ?? null };
    },

    /** Commit a staged Memory or Skill. Requires the subsystem plus BOTH
     *  pendingId and expectedHash. Skill apply keeps the legacy snapshot
     *  path; Memory apply uses the official generic admin operation. */
    async apply({ subsystem, id, expectedHash, reason }) {
      requireStorage();
      requireSubsystem(subsystem);
      if (!id) fail('apply requires a pendingId');
      if (!expectedHash) {
        fail('apply requires expectedHash (review the proposal again before applying)', 'MISSING_HASH');
      }
      const result = subsystem === 'skills'
        ? await legacy().applySkillWithSnapshotAsync(
            storageRoot,
            { id, expectedHash, reason },
            opts(),
          )
        : await legacy().runAdminAsync(
            storageRoot,
            { op: 'apply', subsystem, id, expectedHash, reason },
            opts(),
          );
      // The Skill snapshot transaction returns `success: true` whenever the
      // transaction itself RAN — even when the official apply rejected the
      // content and kept the proposal pending (`committed: false`). Treat that
      // as a failure and surface the official reason (lastError / result.error),
      // otherwise the UI reports "approved" while Hermes never wrote anything.
      const committed = subsystem === 'skills'
        ? Boolean(result && result.success && result.committed !== false)
        : Boolean(result && result.success);
      let error = (result && result.error) ?? null;
      if (!committed && !error) {
        error = (result && (result.lastError
          || (result.result && result.result.error)))
          || 'apply did not commit; the proposal was kept pending';
      }
      return { ok: committed, result: result ?? null, error };
    },

    /** Discard a staged proposal without applying it. */
    async discard({ subsystem, id }) {
      requireStorage();
      requireSubsystem(subsystem);
      if (!id) fail('discard requires an id');
      const result = await legacy().runAdminAsync(storageRoot, { op: 'discard', subsystem, id }, opts());
      return { ok: Boolean(result && result.success), result: result ?? null, error: (result && result.error) ?? null };
    },

    /** List the official Skill backups (snapshots taken before an apply). */
    async listBackups() {
      requireStorage();
      const result = await legacy().listSkillBackupsAsync(storageRoot, opts());
      return { ok: Boolean(result && result.success), backups: (result && result.backups) || [], error: (result && result.error) ?? null };
    },

    /** Roll the Skill tree back to a snapshot id from `listBackups`. */
    async rollback({ snapshotId }) {
      requireStorage();
      if (!snapshotId) fail('rollback requires a snapshotId from listBackups');
      const result = await legacy().rollbackSkillBackupAsync(storageRoot, snapshotId, opts());
      return { ok: Boolean(result && result.success), result: result ?? null, error: (result && result.error) ?? null };
    },

    /** Stage a Skill proposal (used by the learning loop — still staged,
     *  never applied automatically; arch §6.3). */
    async proposeSkill(params) {
      requireStorage();
      if (!params || !params.action) fail('proposeSkill requires an action');
      const result = await legacy().proposeSkillAsync(storageRoot, params, opts());
      return { ok: Boolean(result && result.success), result: result ?? null, error: (result && result.error) ?? null };
    },
  };
}
