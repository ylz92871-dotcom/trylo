'use strict';

/*
 * retrieval-planner.js
 *
 * 24 §3.D1 / 24 §3.D5 / 30 §1.1 + §2: the read-only, deterministic,
 * model-free query planner for L4 cross-session history mining.
 *
 * It turns a (sanitized) Trylo turn context into a minimal, auditable
 * set of FTS queries for the official `tools.session_search_tool.session_search`
 * (via history_adapter.py). The planner NEVER touches model / prompt /
 * session content: it only concatenates pre-sanitized facet tokens.
 *
 * Deterministic guarantees:
 *   - same input -> identical `queries` array AND identical `planHash`.
 *   - planHash = sha256(canonical(queries)) so audits & idempotency can
 *     compare two independently-computed plans.
 *
 * Pure function, no IO, no model.
 */

const crypto = require('node:crypto');

const DEFAULT_MAX_AGE_MS = 90 * 24 * 3600 * 1000; // 90 days, matches aggregator threshold
const MAX_QUERY_LEN = 256;
const MAX_GOAL_TOKENS = 8;

// ---------------------------------------------------------------------------
// canonical JSON (deterministic): sort object keys, stable array order kept.
// Line endings are `\n` only (30 §3.2).
// ---------------------------------------------------------------------------
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// token helpers
// ---------------------------------------------------------------------------
function cleanTokens(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (t == null) continue;
    const s = String(t).trim();
    if (!s) continue;
    out.push(s);
  }
  return out;
}

// 30 §2.1: a token is not a valid facet if it is a full sentence (whitespace
// > 1 token), or looks like a code block (4+ consecutive uppercase). The
// caller is expected to pre-sanitize; this is a defensive net.
function isFacetToken(s) {
  if (s.length === 0) return false;
  if (s.split(/\s+/).length > 2) return false; // >2 whitespace-separated tokens
  if (/[A-Z]{4,}/.test(s)) return false;      // 4+ consecutive uppercase -> code block
  return true;
}

// Relative-file basename without extension, deduped.
function fileBasenames(hints) {
  const seen = new Set();
  const out = [];
  for (const h of cleanTokens(hints)) {
    let base = String(h).split(/[\\/]/).pop() || '';
    base = base.replace(/\.(\w+)$/, ''); // strip extension
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

// ---------------------------------------------------------------------------
// planner
// ---------------------------------------------------------------------------
function runPlanner({ workspace, currentTask, historyMining }) {
  // 30 §1.1: missing any required input field -> planner_input_missing.
  // 32 G0-A: tolerate `workspace.path` being undefined; only `label` is required.
  if (!workspace || typeof workspace !== 'object' || !workspace.label ||
      typeof workspace.label !== 'string' ||
      !currentTask || typeof currentTask !== 'object' ||
      !historyMining || typeof historyMining !== 'object') {
    return { queries: [], rejectionReason: 'planner_input_missing' };
  }

  const workspaceLabel = (workspace.label != null ? String(workspace.label) : '').trim();
  const techTags = cleanTokens(currentTask.techTags).filter(isFacetToken);
  const errorCodes = cleanTokens(currentTask.errorCodes).filter(isFacetToken);
  let goalTokens = cleanTokens(currentTask.goalTokens).filter(isFacetToken);
  const fileHints = fileBasenames(currentTask.relativeFileHints);

  // 30 §1.1 constraint: goalTokens > 8 -> truncate to first 8 (alphabetical),
  // and mark the truncation in the reason.
  let goalTruncated = 0;
  if (goalTokens.length > MAX_GOAL_TOKENS) {
    goalTruncated = goalTokens.length - MAX_GOAL_TOKENS;
    goalTokens = goalTokens.slice().sort().slice(0, MAX_GOAL_TOKENS);
  }

  // 30 §2.3 expectedScope. sinceTs is rounded to a day boundary so the
  // planHash stays deterministic for two calls in the same day (30 §1.1:
  // "两条独立调用同一 input 时完全相同").
  const DAY_MS = 24 * 3600 * 1000;
  const sinceMs = Math.max(0, Date.now() - DEFAULT_MAX_AGE_MS);
  const expectedScope = {
    workspace: workspaceLabel,
    sinceTs: Math.floor(sinceMs / DAY_MS) * DAY_MS,
    // 32 G0-A: workspacePath carries the authoritative fs path so the
    // adapter can cross-check each hit against SessionDB.cwd. Optional;
    // if not provided, the adapter skips the cwd cross-check (backward
    // compatibility for callers that only have a label).
    workspacePath: (workspace && typeof workspace.path === 'string')
      ? String(workspace.path).trim() : '',
  };

  // Build one query per non-empty facet group, each with its own reason.
  const queries = [];
  if (techTags.length) {
    queries.push({
      query: techTags.join(' ').slice(0, MAX_QUERY_LEN),
      reason: 'shared tech tag with L0/L1',
      expectedScope,
    });
  }
  if (errorCodes.length) {
    queries.push({
      query: errorCodes.join(' ').slice(0, MAX_QUERY_LEN),
      reason: 'matches current error pattern',
      expectedScope,
    });
  }
  if (goalTokens.length) {
    const reason = goalTruncated > 0
      ? 'task goal token (truncated from ' + (goalTokens.length + goalTruncated) + ')'
      : 'task goal token';
    queries.push({
      query: goalTokens.join(' ').slice(0, MAX_QUERY_LEN),
      reason,
      expectedScope,
    });
  }
  if (fileHints.length) {
    queries.push({
      query: fileHints.join(' ').slice(0, MAX_QUERY_LEN),
      reason: 'current turn touches this file',
      expectedScope,
    });
  }

  // 30 §8 edge case: goalTokens empty (or no facet at all) -> reject.
  if (queries.length === 0) {
    return { queries: [], rejectionReason: 'planner_input_missing' };
  }

  const planHash = sha256hex(canonical(queries));
  return { queries, planHash, expectedScope };
}

module.exports = {
  runPlanner,
  canonical,
  sha256hex,
  fileBasenames,
  isFacetToken,
  MAX_GOAL_TOKENS,
  MAX_QUERY_LEN,
  DEFAULT_MAX_AGE_MS,
};