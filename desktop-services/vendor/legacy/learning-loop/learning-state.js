'use strict';

/*
 * learning-state.js
 *
 * Persistent learning state via VS Code globalState.
 * No database, no daemon — just a versioned JSON blob per workspace.
 *
 * Schema:
 * {
 *   schemaVersion: 1,
 *   workspaces: {
 *     "<workspaceId>": {
 *       meaningfulIterations: 0,
 *       processedEvidenceHashes: [],  // max 100, newest first
 *       latestStableTurn: { sessionId, turnId, mode } | null,
 *       deferredCandidate: { sessionId, turnId, mode, events, ... } | null,
 *       nextEligibleAt: 0  // epoch ms cooldown
 *     }
 *   }
 * }
 */

const STATE_KEY = 'tryloCode.learning.state';
const STATE_SCHEMA_VERSION = 1;
const MAX_PROCESSED_HASHES = 100;
const MAX_HISTORY_CANDIDATES = 200;
const MAX_SKILL_SIGNALS = 500;
const MAX_SKILL_PROPOSALS = 200;
const MAX_JOB_DEFS = 50;
const MAX_JOB_RUNS = 500;
const INTERRUPTED_MAX_AGE_MS = 30 * 86400 * 1000;   // 30 days

// ---------------------------------------------------------------------------
// L4 history-mining section (24 §3.D6 / 30 §4).
// The `historyMining` section is OPTIONAL at the top level of the state
// blob. It must DEFAULT-ABSENT: old persistence files (no historyMining)
// get the default shape on read, and writes deep-merge without touching
// other top-level fields.
// ---------------------------------------------------------------------------
function defaultHistoryMiningShape() {
  return {
    enabled: false,                 // background mode default off
    budgetModelCalls: 3,            // hard per-run model-call budget
    budgetMs: 30000,                // 30s per-run hard timeout
    lastRunAt: 0,
    cooldownUntil: 0,
    cooldownMsDefault: 24 * 3600 * 1000, // background once per day
    runs: [],
    candidates: [],
  };
}

/**
 * Get (and lazily materialise) the historyMining section. 30 §4.1: the
 * section defaults to absent, so a missing field yields the default shape
 * without erroring on old persistence files.
 */
function getHistoryMining(state) {
  if (!state || typeof state !== 'object') state = { schemaVersion: STATE_SCHEMA_VERSION, workspaces: {} };
  if (!state.historyMining || typeof state.historyMining !== 'object') {
    state.historyMining = defaultHistoryMiningShape();
  }
  return state.historyMining;
}

/**
 * Append a run record and stamp lastRunAt.
 */
function addHistoryRun(state, run) {
  const hm = getHistoryMining(state);
  hm.runs = Array.isArray(hm.runs) ? hm.runs : [];
  hm.runs.push(run);
  hm.lastRunAt = (run && run.startedAt) || Date.now();
  return hm.runs.length;
}

/**
 * Append a candidate, enforcing the 200 cap: FIFO evict the OLDEST TERMINAL
 * (state !== 'staged'); a `staged` candidate is never evicted (30 §4.3).
 */
function pushHistoryCandidate(state, candidate) {
  const hm = getHistoryMining(state);
  hm.candidates = Array.isArray(hm.candidates) ? hm.candidates : [];
  hm.candidates.push(candidate);
  if (hm.candidates.length > MAX_HISTORY_CANDIDATES) {
    const result = hm.candidates.slice();
    while (result.length > MAX_HISTORY_CANDIDATES) {
      const idx = result.findIndex((c) => c && c.state !== 'staged');
      if (idx < 0) break; // all staged — cannot evict
      result.splice(idx, 1);
    }
    hm.candidates = result;
  }
  return hm.candidates.length;
}

function findHistoryCandidate(state, candidateId) {
  const hm = getHistoryMining(state);
  return (Array.isArray(hm.candidates) ? hm.candidates : []).find(
    (c) => c && c.candidateId === candidateId,
  ) || null;
}

/**
 * Apply a mutation to one candidate's stored object (used for provenance
 * delete-propagation and proposal state sync).
 */
function updateHistoryCandidate(state, candidateId, updater) {
  const hm = getHistoryMining(state);
  hm.candidates = (Array.isArray(hm.candidates) ? hm.candidates : []).map((c) =>
    c && c.candidateId === candidateId ? updater(c) : c,
  );
  return findHistoryCandidate(state, candidateId);
}

// ---------------------------------------------------------------------------
// L5 skill-quality section (30/doc-31 §8). Add-only top-level section:
// absent on old files -> default shape on read; staged proposals are never
// evicted.
// ---------------------------------------------------------------------------
function defaultSkillQualityShape() {
  return { signals: {}, proposals: [], versions: {}, lastScanAt: 0, cooldownUntil: 0 };
}

function getSkillQuality(state) {
  if (!state || typeof state !== 'object') state = { schemaVersion: STATE_SCHEMA_VERSION, workspaces: {} };
  if (!state.skillQuality || typeof state.skillQuality !== 'object') {
    state.skillQuality = defaultSkillQualityShape();
  }
  return state.skillQuality;
}

function updateSignals(state, signals, cappedMeta) {
  const sq = getSkillQuality(state);
  sq.signals = signals || {};
  if (cappedMeta && cappedMeta.dropped && cappedMeta.dropped.length) sq._signalsCapped = cappedMeta;
  return sq.signals;
}

/**
 * Append a proposal, enforcing the 200 cap (FIFO evict oldest TERMINAL;
 * staged never evicted).
 */
function addProposal(state, proposal) {
  const sq = getSkillQuality(state);
  sq.proposals = Array.isArray(sq.proposals) ? sq.proposals : [];
  sq.proposals.push(proposal);
  if (sq.proposals.length > MAX_SKILL_PROPOSALS) {
    const result = sq.proposals.slice();
    while (result.length > MAX_SKILL_PROPOSALS) {
      const idx = result.findIndex((p) => p && p.state !== 'staged');
      if (idx < 0) break;
      result.splice(idx, 1);
    }
    sq.proposals = result;
  }
  return sq.proposals.length;
}

function findProposal(state, proposalId) {
  const sq = getSkillQuality(state);
  return (Array.isArray(sq.proposals) ? sq.proposals : []).find((p) => p && p.proposalId === proposalId) || null;
}

function updateProposal(state, proposalId, updater) {
  const sq = getSkillQuality(state);
  sq.proposals = (Array.isArray(sq.proposals) ? sq.proposals : []).map((p) =>
    p && p.proposalId === proposalId ? updater(p) : p,
  );
  return findProposal(state, proposalId);
}

function addHistoryScan(state, run) {
  const sq = getSkillQuality(state);
  sq.lastScanAt = (run && run.startedAt) || Date.now();
  return sq.lastScanAt;
}

// ---------------------------------------------------------------------------
// L6 jobs section (34 §1.1 / §1.3 / §13). Add-only top-level section:
// absent on old files -> default shape on read. FIFO cap: defs<=50, runs<=500.
// running/interrupted entries are NEVER evicted.
// ---------------------------------------------------------------------------
function defaultJobsShape() {
  return { lock: null, defs: {}, runs: [] };
}

function getJobs(state) {
  if (!state || typeof state !== 'object') state = { schemaVersion: STATE_SCHEMA_VERSION, workspaces: {} };
  if (!state.jobs || typeof state.jobs !== 'object') {
    state.jobs = defaultJobsShape();
  }
  // Defensive: a partial/corrupt jobs object is filled in place.
  if (typeof state.jobs.defs !== 'object' || state.jobs.defs === null) state.jobs.defs = {};
  if (!Array.isArray(state.jobs.runs)) state.jobs.runs = [];
  if (state.jobs.lock !== null && typeof state.jobs.lock !== 'object') state.jobs.lock = null;
  return state.jobs;
}

function _jobRunIsProtected(run) {
  if (!run) return false;
  return run.status === 'running' || run.status === 'interrupted';
}

function _capJobDefs(state) {
  const jobs = getJobs(state);
  const entries = Object.entries(jobs.defs);
  if (entries.length <= MAX_JOB_DEFS) return jobs.defs;
  // Evict the oldest non-protected def. Defs are not flagged running/interrupted
  // (those states live on runs), so FIFO by createdAt is the cap policy.
  entries.sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
  const evictCount = entries.length - MAX_JOB_DEFS;
  for (let i = 0; i < evictCount; i++) {
    delete jobs.defs[entries[i][0]];
  }
  return jobs.defs;
}

function _capJobRuns(state) {
  const jobs = getJobs(state);
  if (jobs.runs.length <= MAX_JOB_RUNS) return jobs.runs;
  // P0 fix: enforce a HARD cap even when all runs are protected. Strategy:
  //   1. First evict oldest non-protected runs.
  //   2. If still over cap (e.g. all 500 are running/interrupted), evict
  //      the OLDEST protected run that's older than INTERRUPTED_MAX_AGE
  //      (30 days). An 'interrupted' run from 6 months ago has zero value
  //      and would otherwise leak the array indefinitely.
  const indexed = jobs.runs.map((r, idx) => ({ r, idx }));
  indexed.sort((a, b) => Number(a.r.startedAt || 0) - Number(b.r.startedAt || 0));
  const evictCount = indexed.length - MAX_JOB_RUNS;
  const evictSet = new Set();
  // Pass 1: non-protected.
  for (let i = 0; i < indexed.length && evictSet.size < evictCount; i++) {
    if (!_jobRunIsProtected(indexed[i].r)) evictSet.add(indexed[i].idx);
  }
  // Pass 2: protected-but-stale (only if still over cap).
  if (evictSet.size < evictCount) {
    const cutoff = Date.now() - INTERRUPTED_MAX_AGE_MS;
    for (let i = 0; i < indexed.length && evictSet.size < evictCount; i++) {
      if (evictSet.has(indexed[i].idx)) continue;
      if (!_jobRunIsProtected(indexed[i].r)) continue;
      if (Number(indexed[i].r.startedAt || 0) < cutoff) evictSet.add(indexed[i].idx);
    }
  }
  if (evictSet.size > 0) {
    jobs.runs = jobs.runs.filter((_, i) => !evictSet.has(i));
  }
  return jobs.runs;
}

function addJobDef(state, def) {
  const jobs = getJobs(state);
  jobs.defs[def.jobId] = def;
  _capJobDefs(state);
  return jobs.defs[def.jobId];
}

function getJobDef(state, jobId) {
  const jobs = getJobs(state);
  return jobs.defs[jobId] || null;
}

function updateJobDef(state, jobId, patch) {
  const jobs = getJobs(state);
  const cur = jobs.defs[jobId];
  if (!cur) return null;
  const next = typeof patch === 'function' ? patch(cur) : Object.assign({}, cur, patch || {});
  jobs.defs[jobId] = next;
  return next;
}

function removeJobDef(state, jobId) {
  const jobs = getJobs(state);
  if (jobs.defs[jobId]) {
    delete jobs.defs[jobId];
    return true;
  }
  return false;
}

function listJobDefs(state) {
  const jobs = getJobs(state);
  return Object.values(jobs.defs);
}

function listJobRuns(state, opts) {
  const jobs = getJobs(state);
  let arr = jobs.runs.slice();
  if (opts && opts.jobId) arr = arr.filter((r) => r && r.jobId === opts.jobId);
  if (opts && opts.status) arr = arr.filter((r) => r && r.status === opts.status);
  return arr;
}

function findJobRun(state, runId) {
  const jobs = getJobs(state);
  return jobs.runs.find((r) => r && r.runId === runId) || null;
}

function addJobRun(state, run) {
  const jobs = getJobs(state);
  jobs.runs.push(run);
  _capJobRuns(state);
  return run;
}

function updateJobRun(state, runId, patch) {
  const jobs = getJobs(state);
  const idx = jobs.runs.findIndex((r) => r && r.runId === runId);
  if (idx < 0) return null;
  const cur = jobs.runs[idx];
  const next = typeof patch === 'function' ? patch(cur) : Object.assign({}, cur, patch || {});
  jobs.runs[idx] = next;
  return next;
}

function setJobLock(state, lock) {
  const jobs = getJobs(state);
  jobs.lock = lock;
  return jobs.lock;
}

function getJobLock(state) {
  const jobs = getJobs(state);
  return jobs.lock;
}

function clearRunsForJob(state, jobId) {
  const jobs = getJobs(state);
  const before = jobs.runs.length;
  jobs.runs = jobs.runs.filter((r) => !r || r.jobId !== jobId || _jobRunIsProtected(r));
  return before - jobs.runs.length;
}

// ---------------------------------------------------------------------------
// L7-E telemetry section (依 `L7_EXECUTION_TASK.md` §4.7). Privacy-bounded
// counters + latency buckets + error-code tallies. **Only** numeric fields
// and errorCode strings are stored; any PII-shaped field is rejected at
// write time (L7-P1-2).
// ---------------------------------------------------------------------------
const TELEMETRY_ALLOWED_FIELDS = new Set(['kind', 'name', 'value', 'errorCode', 'latencyMs', 'ts']);
const TELEMETRY_BUCKETS = { l0: 100, l1: 100, l4: 200, l5: 200, l6: 100, install: 50 };
const TELEMETRY_PII_KEYS = /^(sessionId|turnId|workspaceId|workspaceRoot|skillName|memoryBlock|prompt|rawPayload|body|userBlock)$/i;

function _defaultTelemetryShape() {
  // `counters` is a flat map: name -> {ok, failed, latencyMs:{p50,p95}, lastTs}
  // Bounded to TELEMETRY_BUCKETS[*] entries.
  return { counters: {}, lastResetAt: 0 };
}

function getTelemetry(state) {
  if (!state || typeof state !== 'object') state = { schemaVersion: STATE_SCHEMA_VERSION, workspaces: {} };
  if (!state.telemetry || typeof state.telemetry !== 'object') {
    state.telemetry = _defaultTelemetryShape();
  }
  return state.telemetry;
}

/**
 * Write a telemetry entry. Privacy-bounded: rejects any field that
 * looks like a PII key (sessionId / workspaceId / body / etc.) or
 * has a non-allowed key. Returns true if accepted, false if rejected.
 */
function writeTelemetry(state, entry) {
  if (!entry || typeof entry !== 'object') return false;
  // 1) Field whitelist.
  for (const k of Object.keys(entry)) {
    if (!TELEMETRY_ALLOWED_FIELDS.has(k)) return false;
    if (TELEMETRY_PII_KEYS.test(k)) return false;
  }
  // 2) Shape validation.
  if (entry.kind !== 'counter' && entry.kind !== 'latency' && entry.kind !== 'error') return false;
  if (typeof entry.name !== 'string' || !entry.name) return false;
  if (entry.kind === 'counter' && typeof entry.value !== 'number') return false;
  if (entry.kind === 'latency' && typeof entry.latencyMs !== 'number') return false;
  if (entry.kind === 'error' && typeof entry.errorCode !== 'string') return false;
  if (typeof entry.ts !== 'number') return false;
  // 3) Persist (bounded).
  const tel = getTelemetry(state);
  const key = entry.name;
  let bucket = tel.counters[key];
  if (!bucket) {
    bucket = { ok: 0, failed: 0, lastTs: 0 };
    tel.counters[key] = bucket;
    if (Object.keys(tel.counters).length > 500) {
      // Evict oldest by lastTs.
      const oldest = Object.entries(tel.counters)
        .sort((a, b) => Number(a[1].lastTs || 0) - Number(b[1].lastTs || 0))
        .slice(0, 50);
      for (const [k] of oldest) delete tel.counters[k];
    }
  }
  if (entry.kind === 'counter') {
    // value=1 -> ok+=1, value=0 -> no change; >=1 or negative are
    // explicit increments/decrements (clamped at 0).
    if (entry.value > 0) bucket.ok = (bucket.ok || 0) + 1;
    else if (entry.value < 0) bucket.failed = Math.max(0, (bucket.failed || 0) + entry.value);
    else bucket.failed = (bucket.failed || 0) + 1;
  } else if (entry.kind === 'error') {
    bucket.failed = (bucket.failed || 0) + 1;
  }
  bucket.lastTs = entry.ts;
  if (entry.errorCode) bucket.lastErrorCode = entry.errorCode;
  return true;
}

const MAX_TELEMETRY_KEYS = 500;

function _emptyWorkspaceState() {
  return {
    meaningfulIterations: 0,
    processedEvidenceHashes: [],
    latestStableTurn: null,
    deferredCandidate: null,
    nextEligibleAt: 0,
  };
}

function _normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    return { schemaVersion: STATE_SCHEMA_VERSION, workspaces: {} };
  }
  if (!raw.workspaces || typeof raw.workspaces !== 'object') {
    raw.workspaces = {};
  }
  return raw;
}

function _getWorkspaceId(workspaceRoot) {
  if (!workspaceRoot) return '_default';
  return String(workspaceRoot).replace(/[/\\]/g, '_').slice(0, 200);
}

/**
 * Load the full learning state from globalState.
 * @param {object} globalState - VS Code Memento
 * @returns {object} normalized state
 */
function loadState(globalState) {
  if (!globalState || typeof globalState.get !== 'function') {
    return _normalizeState(null);
  }
  const raw = globalState.get(STATE_KEY);
  return _normalizeState(raw);
}

/**
 * Save the full learning state to globalState.
 * @param {object} globalState
 * @param {object} state
 */
async function saveState(globalState, state) {
  if (!globalState || typeof globalState.update !== 'function') return;
  await globalState.update(STATE_KEY, state);
}

/**
 * Get or create workspace state.
 */
function getWorkspaceState(state, workspaceRoot) {
  const id = _getWorkspaceId(workspaceRoot);
  if (!state.workspaces[id]) {
    state.workspaces[id] = _emptyWorkspaceState();
  }
  return state.workspaces[id];
}

/**
 * Record a stable turn reference.
 */
function recordStableTurn(state, workspaceRoot, sessionId, turnId, mode) {
  const ws = getWorkspaceState(state, workspaceRoot);
  ws.latestStableTurn = {
    sessionId: String(sessionId || ''),
    turnId: String(turnId || ''),
    mode: String(mode || 'agent'),
  };
}

/**
 * Get the latest stable turn.
 */
function getLatestStableTurn(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  return ws.latestStableTurn || null;
}

/**
 * Add meaningful iterations.
 */
function addIterations(state, workspaceRoot, count) {
  const ws = getWorkspaceState(state, workspaceRoot);
  ws.meaningfulIterations += Math.max(0, Number(count) || 0);
  return ws.meaningfulIterations;
}

/**
 * Get current iteration count.
 */
function getIterations(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  return ws.meaningfulIterations;
}

/**
 * Reset iterations to zero (after a learning run is started).
 */
function resetIterations(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  ws.meaningfulIterations = 0;
}

/**
 * Check if an evidence hash has been processed.
 */
function isHashProcessed(state, workspaceRoot, hash) {
  const ws = getWorkspaceState(state, workspaceRoot);
  return ws.processedEvidenceHashes.includes(hash);
}

/**
 * Mark a hash as processed. Keeps max 100, newest first.
 */
function markHashProcessed(state, workspaceRoot, hash) {
  const ws = getWorkspaceState(state, workspaceRoot);
  ws.processedEvidenceHashes = [hash, ...ws.processedEvidenceHashes].slice(0, MAX_PROCESSED_HASHES);
}

/**
 * Set cooldown.
 */
function setCooldown(state, workspaceRoot, cooldownMs) {
  const ws = getWorkspaceState(state, workspaceRoot);
  ws.nextEligibleAt = Date.now() + Math.max(0, Number(cooldownMs) || 0);
}

/**
 * Check if cooldown has passed.
 */
function isEligible(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  return Date.now() >= ws.nextEligibleAt;
}

/**
 * Save a deferred candidate (when review is pending).
 * 05 §4 A4 — the deferred ref now carries its own reviewResolution
 * (accepted/rejected/settled numbers) so the next run can use the
 * resolution that belongs to THIS source turn, never a previous turn's
 * leftover. Content (taskGoal/resultSummary/events/fileHints/verification)
 * is recovered from the Trylo session JSON at trigger time.
 *
 * iterationsApplied: tracked so that the deferred state machine only adds
 * iterationIncrement to the cumulative count once (03A §4).
 */
function setDeferredCandidate(state, workspaceRoot, candidate) {
  const ws = getWorkspaceState(state, workspaceRoot);
  ws.deferredCandidate = candidate ? {
    sessionId: String(candidate.sessionId || ''),
    turnId: String(candidate.turnId || ''),
    mode: String(candidate.mode || 'agent'),
    iterationIncrement: Number(candidate.iterationIncrement) || 0,
    iterationsApplied: candidate.iterationsApplied === true, // exactly-once guard
    reviewResolution: candidate.reviewResolution && typeof candidate.reviewResolution === 'object'
      ? {
          accepted: Math.max(0, Number(candidate.reviewResolution.accepted) || 0),
          rejected: Math.max(0, Number(candidate.reviewResolution.rejected) || 0),
          settled: candidate.reviewResolution.settled !== false,
        }
      : null,
    savedAt: Date.now(),
  } : null;
}

/**
 * Get and clear deferred candidate.
 */
function consumeDeferredCandidate(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  const candidate = ws.deferredCandidate || null;
  ws.deferredCandidate = null;
  return candidate;
}

/**
 * Check if a deferred candidate exists.
 */
function hasDeferredCandidate(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  return ws.deferredCandidate !== null;
}

/**
 * Peek at deferred candidate without consuming (P1-3).
 */
function peekDeferredCandidate(state, workspaceRoot) {
  const ws = getWorkspaceState(state, workspaceRoot);
  return ws.deferredCandidate || null;
}

/**
 * Clean up references when a session is deleted.
 */
function cleanSessionReferences(state, workspaceRoot, sessionId) {
  const ws = getWorkspaceState(state, workspaceRoot);
  if (ws.latestStableTurn && ws.latestStableTurn.sessionId === sessionId) {
    ws.latestStableTurn = null;
  }
  if (ws.deferredCandidate && ws.deferredCandidate.sessionId === sessionId) {
    ws.deferredCandidate = null;
  }
}

// ---------------------------------------------------------------------------
// Turn-level learning state (04 §4 — lives on session.turns[].learning)
// These helpers operate on a turn object, NOT on globalState.
// ---------------------------------------------------------------------------

/**
 * Create a fresh learning state object for a source turn.
 * @param {object} [overrides]
 * @returns {object}
 */
function createTurnLearningState(overrides) {
  const base = {
    schemaVersion: 1,
    policyVersion: 1,
    state: 'ineligible',
    action: 'none',
    reasonCodes: [],
    exclusionCodes: [],
    evidenceHash: '',
    candidateId: '',
    pendingId: '',
    updatedAt: Date.now(),
  };
  if (overrides && typeof overrides === 'object') {
    return { ...base, ...overrides, updatedAt: Date.now() };
  }
  return base;
}

/**
 * Update the learning state on a turn object.
 * Mutates the turn in-place and returns it.
 *
 * @param {object} turn - session turn object
 * @param {Partial<ReturnType<typeof createTurnLearningState>>} updates
 * @returns {object} the updated turn
 */
function setTurnLearningState(turn, updates) {
  if (!turn || typeof turn !== 'object') return turn;
  const current = turn.learning || createTurnLearningState();
  turn.learning = {
    ...current,
    ...updates,
    updatedAt: Date.now(),
  };
  return turn;
}

/**
 * Get the learning state from a turn, or null if not set.
 * @param {object} turn
 * @returns {object|null}
 */
function getTurnLearningState(turn) {
  if (!turn || typeof turn !== 'object') return null;
  return turn.learning || null;
}

/**
 * Check if a turn's learning state is terminal (staged, no_learning, skipped).
 * @param {object} turn
 * @returns {boolean}
 */
function isTurnLearningTerminal(turn) {
  const ls = getTurnLearningState(turn);
  if (!ls) return false;
  return ls.state === 'staged' || ls.state === 'no_learning' || ls.state === 'skipped';
}

module.exports = {
  STATE_KEY,
  STATE_SCHEMA_VERSION,
  MAX_PROCESSED_HASHES,
  MAX_HISTORY_CANDIDATES,
  defaultHistoryMiningShape,
  getHistoryMining,
  addHistoryRun,
  pushHistoryCandidate,
  findHistoryCandidate,
  updateHistoryCandidate,
  defaultSkillQualityShape,
  getSkillQuality,
  updateSignals,
  addProposal,
  findProposal,
  updateProposal,
  addHistoryScan,
  defaultJobsShape,
  getJobs,
  addJobDef,
  getJobDef,
  updateJobDef,
  removeJobDef,
  listJobDefs,
  listJobRuns,
  findJobRun,
  addJobRun,
  updateJobRun,
  setJobLock,
  getJobLock,
  clearRunsForJob,
  MAX_JOB_DEFS,
  MAX_JOB_RUNS,
  INTERRUPTED_MAX_AGE_MS,
  getTelemetry,
  writeTelemetry,
  MAX_TELEMETRY_KEYS,
  TELEMETRY_ALLOWED_FIELDS,
  TELEMETRY_PII_KEYS,
  loadState,
  saveState,
  getWorkspaceState,
  recordStableTurn,
  getLatestStableTurn,
  addIterations,
  getIterations,
  resetIterations,
  isHashProcessed,
  markHashProcessed,
  setCooldown,
  isEligible,
  setDeferredCandidate,
  consumeDeferredCandidate,
  peekDeferredCandidate,
  hasDeferredCandidate,
  cleanSessionReferences,
  createTurnLearningState,
  setTurnLearningState,
  getTurnLearningState,
  isTurnLearningTerminal,
};