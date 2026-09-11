'use strict';

/*
 * provenance.js
 *
 * 24 §3.D8 / 30 §1.3 + §3.2 + §6: provenance DTO construction, validation,
 * serialization, evidenceHash, and delete-propagation scanning for L4
 * cross-session history mining.
 *
 * CANONICAL RULE (30 §3.2) — MUST be byte-identical in history_adapter.py
 * (Python) and here (Node). The canonical shape:
 *   - keep only the whitelist fields:
 *       sessionId, turnId, timestamp, role, taskSummary, resultOutcome,
 *       verification, relativeFileHints, toolCategories
 *   - field keys sorted alphabetically
 *   - each field formatted as `key=value`
 *   - string fields trimmed of leading/trailing whitespace
 *   - array fields (relativeFileHints, toolCategories) SORTED then
 *     JSON-serialized with `,"` separators (no spaces)
 *   - object field (verification) JSON-serialized with sorted keys, no spaces
 *   - pairs joined with `\n` (NOT `\r\n`)
 *
 * Pure (build/validate/sha256/findAffectedCandidates) + one serialization
 * helper. No mutation of input objects.
 */

const crypto = require('node:crypto');
const { canonical: jsonCanonical } = require('./retrieval-planner');

const EVIDENCE_WHITELIST = ['sessionId', 'turnId', 'timestamp', 'role', 'taskSummary',
  'resultOutcome', 'verification', 'relativeFileHints', 'toolCategories'];
const ARRAY_FIELDS = new Set(['relativeFileHints', 'toolCategories']);

// ---------------------------------------------------------------------------
// canonical serialization (byte-identical contract with history_adapter.py)
// ---------------------------------------------------------------------------
function jsonStr(s) { return JSON.stringify(s); }

function canonicalValue(value) {
  if (value === null || value === undefined) return jsonStr('');
  const t = typeof value;
  if (t === 'string') return jsonStr(value.trim());
  if (t === 'number') {
    // integral floats serialize as integers so Python str() and JS String()
    // agree (e.g. epoch-ms timestamps).
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const sorted = value.map((x) => String(x)).sort();
    return '[' + sorted.map(jsonStr).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => jsonStr(k) + ':' + canonicalValue(value[k])).join(',') + '}';
  }
  return jsonStr(String(value));
}

function canonicalEvidence(ev) {
  const pairs = [];
  for (const key of EVIDENCE_WHITELIST) {
    if (ev && ev[key] !== undefined) {
      pairs.push(key + '=' + canonicalValue(ev[key]));
    }
  }
  return pairs.join('\n');
}

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// evidenceHash = sha256(canonical(evidence_minus_hash)) (30 §3.2).
function evidenceHashOf(evidence) {
  const copy = {};
  for (const k of EVIDENCE_WHITELIST) {
    if (evidence && evidence[k] !== undefined) copy[k] = evidence[k];
  }
  return sha256(canonicalEvidence(copy));
}

// ---------------------------------------------------------------------------
// build / validate
// ---------------------------------------------------------------------------
function build({ patternKey, summary, confidence, rationale, sources, workspace, queryPlanHash, createdAt, now, summaryUntrusted }) {
  const ts = typeof now === 'function' ? now() : Date.now();
  const created = createdAt || ts;
  const candidate = {
    candidateId: 'history-' + (patternKey || 'unknown') + '-' + created.toString(36),
    patternKey: String(patternKey || ''),
    summary: String(summary || '').slice(0, 200),
    // 30 §3 P0-1 (A.1 v2): the untrusted flag is carried in the
    // persisted candidate DTO so downstream consumers (extension.js
    // buildHistoryMiningPrompt, review UI) MUST see the trust level
    // explicitly and cannot infer it from the field name.
    summaryUntrusted: summaryUntrusted === true,
    confidence: confidence || 'low',
    rationale: String(rationale || ''),
    sources: (Array.isArray(sources) ? sources : []).map((s) => ({
      workspace: String(workspace || ''),
      sessionId: String(s.sessionId || ''),
      turnId: String(s.turnId || ''),
      timestamp: Number(s.timestamp) || 0,
      evidenceHash: String(s.evidenceHash || ''),
    })),
    proposal: {
      subsystem: 'memory',
      pendingId: '',
      state: 'none',
      errorCode: '',
      updatedAt: 0,
    },
    state: 'staged',
    queryPlanHash: String(queryPlanHash || ''),
    createdAt: created,
    updatedAt: ts,
  };
  return candidate;
}

function validate(candidate) {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'candidate missing' };
  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) {
    return { ok: false, reason: 'sources empty' };
  }
  for (const s of candidate.sources) {
    if (!s || !s.sessionId || !s.turnId || !s.evidenceHash) {
      return { ok: false, reason: 'source missing sessionId/turnId/evidenceHash' };
    }
  }
  if (!/^[a-z0-9_]{4,64}$/.test(candidate.patternKey || '')) {
    return { ok: false, reason: 'invalid patternKey' };
  }
  if (String(candidate.summary || '').length > 200) {
    return { ok: false, reason: 'summary > 200 chars' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// delete-propagation scan (30 §6.1) — pure, does not write.
// ---------------------------------------------------------------------------
function findAffectedCandidates({ sessionId, candidates }) {
  const affected = [];
  const transitionedToStale = [];
  if (!Array.isArray(candidates)) return { affected, transitionedToStale };
  for (const c of candidates) {
    if (!c || !Array.isArray(c.sources)) continue;
    const before = c.sources.length;
    const remaining = c.sources.filter((s) => String(s.sessionId) !== String(sessionId));
    if (remaining.length === before) continue; // this candidate doesn't reference the session
    const prevState = c.state;
    let nextState = prevState;
    // 30 §6.1: <2 sources && staged -> stale; ==0 -> stale.
    if (remaining.length === 0) nextState = 'stale';
    else if (remaining.length < 2 && prevState === 'staged') nextState = 'stale';
    affected.push({ candidate: c, remainingSources: remaining, nextState });
    if (nextState !== prevState) transitionedToStale.push({ candidate: c, nextState });
  }
  return { affected, transitionedToStale };
}

module.exports = {
  build,
  validate,
  evidenceHashOf,
  findAffectedCandidates,
  canonicalEvidence,
  canonicalValue,
  EVIDENCE_WHITELIST,
};