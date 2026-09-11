'use strict';

/*
 * registry.js
 *
 * L6 (34 §1.1) job registry. Pure data layer (no scheduler / no IO).
 * Rejection rules are STRUCTURAL, not flag-based:
 *   - level === 'C'   -> LEVEL_FORBIDDEN    (34 §1.1 + §17.1)
 *   - level === 'B' without budgetModelCalls > 0 -> BUDGET_REQUIRED
 *   - intervalMs < 60_000                       -> INTERVAL_TOO_SHORT
 *   - bad jobId                                  -> JOBID_INVALID
 * Cap: defs <= 50, FIFO by createdAt (handled in learning-state.js).
 *
 * Imports allowed: learning-state only. NO admin / hermes-pending-admin /
 * skillGovernance (34 §1.3 import-graph ban + T3 grep guard).
 */

const crypto = require('node:crypto');

const VALID_TYPES = new Set([
  'index-rebuild',
  'backup-verify',
  'graph-refresh',
  'history-mining',
  'quality-scan',
]);

const VALID_LEVELS = new Set(['A', 'B']); // C is structurally unreachable

const MIN_INTERVAL_MS = 60_000;

const REJECTION_CODES = {
  LEVEL_FORBIDDEN: 'LEVEL_FORBIDDEN',
  JOBID_INVALID: 'JOBID_INVALID',
  INTERVAL_TOO_SHORT: 'INTERVAL_TOO_SHORT',
  BUDGET_REQUIRED: 'BUDGET_REQUIRED',
  TYPE_INVALID: 'TYPE_INVALID',
  LEVEL_INVALID: 'LEVEL_INVALID',
};

class RegistryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RegistryError';
    this.code = code;
  }
}

function _validateJobId(s) {
  if (typeof s !== 'string') return false;
  if (!s.length || s.length > 200) return false;
  // kebab/snake identifiers only; no path separators or punctuation
  if (!/^[A-Za-z0-9_.\-:]+$/.test(s)) return false;
  return true;
}

class JobRegistry {
  /**
   * @param {object} opts
   * @param {object} opts.state    the learning-state MODULE (provides
   *                               getJobs / getJobDef / addJobDef / etc.).
   *                               The actual data blob is passed via the
   *                               first argument of those module functions.
   * @param {object} opts.data     the data blob (loaded from
   *                               learningState.loadState()).
   * @param {function} opts.logger
   */
  constructor({ state, data, logger } = {}) {
    if (!state || typeof state !== 'object' || typeof state.getJobs !== 'function') {
      throw new RegistryError('STATE_NOT_READY', 'JobRegistry needs a state MODULE (with getJobs)');
    }
    if (!data || typeof data !== 'object') {
      throw new RegistryError('STATE_NOT_READY', 'JobRegistry needs a data blob');
    }
    this.state = state;   // module
    this.data = data;     // data blob
    this.log = typeof logger === 'function' ? logger : () => {};
  }

  _mod(name) {
    const fn = this.state && this.state[name];
    if (typeof fn !== 'function') {
      throw new RegistryError('STATE_NOT_READY', 'learning-state is missing ' + name);
    }
    return fn;
  }

  /**
   * Register a job. Returns the created JobDef, or throws RegistryError with
   * one of the rejection codes. The runner is NEVER instantiated here.
   */
  register(input) {
    if (!input || typeof input !== 'object') {
      throw new RegistryError(REJECTION_CODES.JOBID_INVALID, 'register() needs a job object');
    }
    const { jobId, type, level } = input;
    if (!_validateJobId(jobId)) {
      throw new RegistryError(REJECTION_CODES.JOBID_INVALID, 'jobId invalid: ' + String(jobId));
    }
    if (!VALID_TYPES.has(type)) {
      throw new RegistryError(REJECTION_CODES.TYPE_INVALID, 'type invalid: ' + String(type));
    }
    if (!VALID_LEVELS.has(level)) {
      // 34 §1.1: level='C' is structurally unreachable. We treat it as a
      // single forbidden case (LEVEL_FORBIDDEN) so the message is meaningful;
      // any other unknown level gets LEVEL_INVALID.
      if (level === 'C') {
        throw new RegistryError(REJECTION_CODES.LEVEL_FORBIDDEN,
          'level C is structurally unreachable (34 §1.1)');
      }
      throw new RegistryError(REJECTION_CODES.LEVEL_INVALID, 'level invalid: ' + String(level));
    }
    const intervalMs = Number(input.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
      throw new RegistryError(REJECTION_CODES.INTERVAL_TOO_SHORT,
        `intervalMs must be >= ${MIN_INTERVAL_MS}`);
    }
    const budgetModelCalls = level === 'A'
      ? 0
      : Number(input.budgetModelCalls);
    if (level === 'B' && !(budgetModelCalls > 0)) {
      throw new RegistryError(REJECTION_CODES.BUDGET_REQUIRED,
        'B-level job needs budgetModelCalls > 0');
    }
    // Idempotent register: if jobId exists and shape matches, return existing.
    const existing = this._mod('getJobDef')(this.data, jobId);
    const now = Date.now();
    if (existing) {
      // Same id + same type + same level: treat as no-op (defensive: tests may
      // re-register). Return current shape rather than mutate.
      if (existing.type !== type || existing.level !== level) {
        throw new RegistryError(REJECTION_CODES.JOBID_INVALID,
          'jobId already registered with different type/level');
      }
      return existing;
    }
    const def = {
      jobId,
      type,
      level,
      scopeWorkspace: input.scopeWorkspace || null,
      // 34 §1.1 + §4.2: B-level default disabled; A-level default enabled.
      enabled: typeof input.enabled === 'boolean'
        ? input.enabled
        : (level === 'A'),
      intervalMs,
      budgetModelCalls,
      createdAt: now,
      lastRunAt: null,
      nextRunAt: now + intervalMs,
      lastStatus: null,
      lastError: null,
      runCount: 0,
    };
    this._mod('addJobDef')(this.data, def);
    this.log(`register job ${def.jobId} level=${def.level} type=${def.type} enabled=${def.enabled}`);
    return def;
  }

  list() {
    return this._mod('listJobDefs')(this.data);
  }

  get(jobId) {
    return this._mod('getJobDef')(this.data, jobId);
  }

  update(jobId, patch) {
    return this._mod('updateJobDef')(this.data, jobId, patch);
  }

  remove(jobId) {
    return this._mod('removeJobDef')(this.data, jobId);
  }

  removeByWorkspace(workspaceId) {
    if (!workspaceId) return [];
    const all = this.list();
    const removed = [];
    for (const d of all) {
      if (d.scopeWorkspace === workspaceId) {
        this.remove(d.jobId);
        removed.push(d.jobId);
      }
    }
    return removed;
  }

  /**
   * Find a def that is due (nextRunAt <= now). Returns the def or null.
   * Skips disabled defs.
   */
  findDue(now) {
    const ts = Number.isFinite(now) ? now : Date.now();
    const all = this.list();
    for (const d of all) {
      if (!d.enabled) continue;
      if (d.nextRunAt > ts) continue;
      return d;
    }
    return null;
  }

  /**
   * Pick a synthetic runId for a def at a given scheduledForTime. Must equal
   * the value used in the run record; persistence keys off this.
   */
  static runIdFor(jobId, scheduledForTime) {
    return String(jobId) + ':' + Number(scheduledForTime);
  }
}

module.exports = {
  JobRegistry,
  RegistryError,
  REJECTION_CODES,
  VALID_TYPES,
  VALID_LEVELS,
  MIN_INTERVAL_MS,
};
