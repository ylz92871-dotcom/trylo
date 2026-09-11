'use strict';

/*
 * skill-governance.js
 *
 * 13 §3.6 / 13 §5 / 13 §6: a single narrow production helper that
 * per-turn and generic Skill apply both call. It owns the Trylo
 * transition table (5 states, no `reconcile_required`), the field
 * whitelist for realtime webview patches, and the snapshot/apply/
 * rollback result normalisation. It does NOT call any Hermes
 * function itself - the extension.js caller is the one that calls
 * `applySkillWithSnapshotAsync` and feeds the result into
 * `transition` / `buildPatch`.
 *
 * Allowed states: staged / approved / discarded / apply_failed /
 * rolled_back. Any other state is rejected at the boundary so
 * production code cannot drift.
 */

const ALLOWED_STATES = new Set([
  'staged',
  'approved',
  'discarded',
  'apply_failed',
  'rolled_back',
]);

// Field whitelist for the realtime webview patch. NEVER carry
// before/after/diff/proposal body/Memory body/model reasoning.
// backupState, errorCode, safetySnapshotId are part of the L3
// surface per 13 §6.
const ALLOWED_PATCH_FIELDS = new Set([
  'state',
  'pendingId',
  'action',
  'skillName',
  'snapshotId',
  'backupState',
  'errorCode',
  'safetySnapshotId',
  'updatedAt',
]);

function _clampString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function _clampInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function _now() { return Date.now(); }

/**
 * Apply a state transition to the source turn's `skillGovernance`.
 * Mutates the turn in place. The new state MUST be one of the five
 * allowed values; anything else throws (caught by the call site
 * which logs and continues).
 *
 * @param {object} turn
 * @param {object} fields
 * @returns {object} the new skillGovernance object
 */
function transition(turn, fields) {
  if (!turn || typeof turn !== 'object') {
    throw new Error('skillGovernance.transition: turn is required');
  }
  if (!fields || typeof fields !== 'object') {
    throw new Error('skillGovernance.transition: fields is required');
  }
  const state = _clampString(fields.state);
  if (!ALLOWED_STATES.has(state)) {
    throw new Error('skillGovernance.transition: invalid state ' + JSON.stringify(state));
  }
  const cur = (turn.learning && turn.learning.skillGovernance) || {};
  const next = Object.assign({}, cur, {
    schemaVersion: 1,
    state,
    pendingId: fields.pendingId != null ? _clampString(fields.pendingId) : (cur.pendingId || ''),
    updatedAt: _now(),
  });
  if (fields.action != null) next.action = _clampString(fields.action);
  if (fields.skillName != null) next.skillName = _clampString(fields.skillName);
  if (fields.snapshotId != null) next.snapshotId = _clampString(fields.snapshotId);
  if (fields.backupState != null) next.backupState = _clampString(fields.backupState);
  if (fields.errorCode != null) next.errorCode = _clampString(fields.errorCode);
  if (fields.safetySnapshotId != null) next.safetySnapshotId = _clampString(fields.safetySnapshotId);
  if (!turn.learning) turn.learning = {};
  turn.learning.skillGovernance = next;
  return next;
}

/**
 * Build a realtime webview patch from a transition fields object.
 * The whitelist guarantees the patch never carries proposal body /
 * diff / Memory body / model reasoning.
 */
function buildPatch(fields) {
  if (!fields || typeof fields !== 'object') {
    throw new Error('buildPatch: fields is required');
  }
  const out = {};
  for (const key of Object.keys(fields)) {
    if (ALLOWED_PATCH_FIELDS.has(key)) {
      out[key] = key === 'updatedAt'
        ? _clampInt(fields[key])
        : _clampString(fields[key]);
    }
  }
  if (!('updatedAt' in out)) out.updatedAt = _now();
  return out;
}

/**
 * Normalise the result of `applySkillWithSnapshotAsync` into the
 * unified 5-state contract. 13 §5.2: this is the ONLY place the
 * per-turn and generic code paths are allowed to convert
 * {committed, kept_pending, snapshotId, backupState, lastError,
 * result} into a single {state, ...patch}. Both call sites MUST go
 * through this helper.
 *
 * 13 §5.1: when expectedHash is missing OR the second live hash
 * check fails, we return `apply_failed` and the source turn must
 * stay `staged`. The caller is expected to do the live hash check
 * BEFORE calling this helper; if the helper receives a missing
 * expectedHash, that is itself a fail-closed condition.
 */
function normaliseApplyResult({ adminResult, expectedHash, liveHash, payload }) {
  const r = adminResult || {};
  const ok = r.success === true;
  const committed = ok && r.committed === true;
  // 20 §2 F1 (P0-2): `kept_pending` must be honoured even when the
  // admin call returned success:false (admin.py `err(..., kept_pending=True,
  // backupState=...)` shape). committed still requires success; kept_pending
  // does not — a snapshot/security failure is reported with success:false.
  const keptPending = r.kept_pending === true;
  // 15 §2.3: a missing expectedHash is itself a fail-closed
  // condition. The production caller (reviewSkillProposalForTurn
  // and the generic branch) MUST supply the user-previewed hash.
  // Empty string / undefined / null all mean "anti-swap bypass
  // attempt" -> `apply_failed / EXPECTED_HASH_REQUIRED`.
  if (!expectedHash || typeof expectedHash !== 'string' || expectedHash.length === 0) {
    return {
      state: 'apply_failed',
      patch: {
        state: 'apply_failed',
        pendingId: (payload && payload.id) || (r && r.id) || '',
        errorCode: 'EXPECTED_HASH_REQUIRED',
        updatedAt: _now(),
      },
    };
  }
  // 13 §5.1: caller supplies the live hash. We never re-read
  // detail here; the caller passed the LIVE payload (already through
  // anti-swap) and the liveHash computed from it. A mismatch means
  // the pending payload changed since preview.
  if (liveHash && expectedHash !== liveHash) {
    return {
      state: 'apply_failed',
      patch: {
        state: 'apply_failed',
        pendingId: (payload && payload.id) || (r && r.id) || '',
        errorCode: 'PAYLOAD_CHANGED',
        updatedAt: _now(),
      },
    };
  }
  if (committed) {
    return {
      state: 'approved',
      patch: {
        state: 'approved',
        pendingId: (r && r.id) || (payload && payload.id) || '',
        action: r.action || (payload && payload.action) || '',
        skillName: r.skillName || (payload && payload.skillName) || (payload && payload.target) || '',
        snapshotId: r.snapshotId || '',
        backupState: r.backupState || 'snapshot_ok',
        updatedAt: _now(),
      },
    };
  }
  if (keptPending) {
    // snapshot/security/hash failure: apply_failed, pending kept.
    // 20 §2 F1 (P0-2): project backupState + snapshotId so the source
    // turn and realtime patch carry the L3 surface (18 §3 P0-2 expects
    // {"state":"apply_failed","backupState":"snapshot_failed",
    // "errorCode":"SNAPSHOT_FAILED"}). snapshotId lets rollback still
    // locate the pre-apply snapshot on the apply-failed path.
    return {
      state: 'apply_failed',
      patch: {
        state: 'apply_failed',
        pendingId: (r && r.id) || (payload && payload.id) || '',
        backupState: r.backupState || '',
        snapshotId: r.snapshotId || '',
        errorCode: r.backupState === 'snapshot_failed'
          ? 'SNAPSHOT_FAILED'
          : r.backupState === 'snapshot_missing'
            ? 'SNAPSHOT_MISSING'
            : r.lastError
              ? 'APPLY_ERROR'
              : 'APPLY_FAILED',
        updatedAt: _now(),
      },
    };
  }
  // success:false from the admin call (e.g. python crash)
  return {
    state: 'apply_failed',
    patch: {
      state: 'apply_failed',
      pendingId: (r && r.id) || (payload && payload.id) || '',
      backupState: r.backupState || '',
      errorCode: 'ADMIN_ERROR',
      updatedAt: _now(),
    },
  };
}

/**
 * 15 §3: per-turn and generic Skill apply use the SAME source-turn
 * closure. Given a pendingId + a normalised patch, walk all turns in
 * the globalSessionsCache whose skillGovernance.pendingId matches,
 * merge the patch through the field whitelist, persist, and push
 * a realtime webview patch. The function takes its side-effect
 * hooks as injection so it can be tested without a real VS Code
 * globalContext.
 */
function applySkillGovernanceResultToSourceTurns({
  pendingId,
  normalised,
  sessionCache,
  mutateTurn,
  postPatch,
  now,
}) {
  if (!pendingId || !normalised || !normalised.state || !normalised.patch) {
    return { updated: 0, reason: 'invalid args' };
  }
  if (!Array.isArray(sessionCache)) sessionCache = [];
  if (typeof mutateTurn !== 'function') mutateTurn = () => ({ ok: false });
  if (typeof postPatch !== 'function') postPatch = () => {};
  const ts = typeof now === 'function' ? now() : Date.now();
  let updated = 0;
  for (const session of sessionCache) {
    if (!session || !Array.isArray(session.turns)) continue;
    for (let i = 0; i < session.turns.length; i++) {
      const turn = session.turns[i];
      if (!turn || !turn.learning || !turn.learning.skillGovernance) continue;
      if (String(turn.learning.skillGovernance.pendingId) !== String(pendingId)) continue;
      // Merge through the whitelist. We reuse the production
      // transition table by building a fresh skillGovernance object.
      const next = Object.assign({}, turn.learning.skillGovernance, normalised.patch, {
        schemaVersion: 1,
        state: normalised.state,
        updatedAt: ts,
      });
      const wr = mutateTurn(session, turn, i, next);
      if (wr && wr.ok) {
        postPatch(session, turn, next);
        updated++;
      }
    }
  }
  return { updated };
}

module.exports = {
  ALLOWED_STATES,
  ALLOWED_PATCH_FIELDS,
  transition,
  buildPatch,
  normaliseApplyResult,
  applySkillGovernanceResultToSourceTurns,
};
