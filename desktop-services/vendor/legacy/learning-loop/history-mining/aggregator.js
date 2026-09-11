'use strict';

/*
 * aggregator.js
 *
 * 24 §3.D5 / 30 §1.2 + §5: the deterministic, model-free clustering layer
 * for L4 history mining. It groups the (already narrowed) evidence DTOs from
 * history_adapter.py by patternKey, applies the stability threshold (≥2
 * independent session sources by default), and flags conflicts (same pattern
 * -> both success and failure outcomes = `conflicted`, no candidate).
 *
 * Independent source = a distinct `sessionId` (30 §5.1). Multiple turns in the
 * same session do NOT count as multiple sources; a single-source candidate is
 * only allowed when the caller opts in via `allowSingleSource` (explicit
 * user command) and is marked confidence='low'.
 *
 * patternKey is derived ONLY from the domain facet (toolCategories, the
 * evidence-side proxy for tech tags) — NOT from goalTokens — so unrelated
 * tasks sharing a domain are not merged (30 §5.2).
 *
 * Pure function, no IO, no model.
 */

const { canonical, sha256hex } = require('./retrieval-planner');

const DEFAULT_THRESHOLDS = { minSources: 2, minTurnsPerSource: 1, maxAgeDays: 90 };

// White-listed evidence fields for clustering/summary (30 §4.1).
const EVIDENCE_KEYS = ['sessionId', 'turnId', 'timestamp', 'role', 'taskSummary',
  'resultOutcome', 'verification', 'relativeFileHints', 'toolCategories', 'evidenceHash'];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function sanitizeEvidence(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const out = {};
  for (const k of EVIDENCE_KEYS) {
    if (ev[k] !== undefined) out[k] = ev[k];
  }
  // 31 F2 (audit P0-2): carry `workspace` through for the aggregator-internal
  // workspace split. It is NOT added to EVIDENCE_KEYS (the 30 §4.1 whitelist
  // for the persisted DTO lives in provenance.js EVIDENCE_WHITELIST and is
  // unchanged); this is an aggregator-only read so the whitelist contract is
  // not weakened.
  if (ev.workspace !== undefined) out.workspace = ev.workspace;
  return out;
}

// patternKey = sha256(canonical(sorted(toolCategories))).slice(0,16) (30 §5.2).
function derivePatternKey(evidence) {
  const cats = Array.isArray(evidence.toolCategories) ? evidence.toolCategories.map(String) : [];
  const sorted = cats.slice().sort();
  return sha256hex(canonical({ techTags: sorted })).slice(0, 16);
}

function summarize(evidenceList) {
  // Most recent taskSummary (list is sorted timestamp DESC), sanitized <=200.
  const first = evidenceList[0];
  const raw = (first && first.taskSummary != null ? String(first.taskSummary) : '').trim();
  const s = raw.replace(/\s+/g, ' ').slice(0, 200);
  return s || '(no summary)';
}

function runAggregator({ evidence, thresholds, allowSingleSource }) {
  const th = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
  const minSources = clamp(Number(th.minSources) || DEFAULT_THRESHOLDS.minSources, 1, 100);
  const maxAgeDays = clamp(Number(th.maxAgeDays) || DEFAULT_THRESHOLDS.maxAgeDays, 1, 3650);
  const maxAgeMs = maxAgeDays * 24 * 3600 * 1000;
  const now = Date.now();

  const stats = { total: 0, kept: 0, conflicted: 0, stale: 0 };

  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { clusters: [], stats };
  }

  // 30 §3.1: evidence is sorted (timestamp DESC, sessionId ASC, turnId ASC).
  // We defensively re-sort so the dedupe is stable regardless of input order.
  const evs = evidence
    .map(sanitizeEvidence)
    .filter(Boolean)
    .sort((a, b) => {
      const ta = Number(a.timestamp) || 0, tb = Number(b.timestamp) || 0;
      if (tb !== ta) return tb - ta;               // timestamp DESC
      const sa = String(a.sessionId), sb = String(b.sessionId);
      if (sa !== sb) return sa < sb ? -1 : 1;      // sessionId ASC
      const ta2 = String(a.turnId), tb2 = String(b.turnId);
      return ta2 < tb2 ? -1 : ta2 > tb2 ? 1 : 0;   // turnId ASC
    });

  stats.total = evs.length;

  // Partition by patternKey.
  const groups = new Map();
  for (const ev of evs) {
    const ts = Number(ev.timestamp) || 0;
    if (ts > 0 && now - ts > maxAgeMs) { stats.stale++; continue; } // too old
    const pk = derivePatternKey(ev);
    // 31 F2 (audit P0-2): same patternKey across DIFFERENT workspaces must
    // NOT be merged into one cluster. The cluster key is the
    // (patternKey, workspace) composite. `workspace` is read directly from
    // each evidence (aggregator-internal read, not part of the persisted
    // EVIDENCE_WHITELIST). The derived patternKey formula is unchanged.
    const ws = String(ev.workspace != null ? ev.workspace : '');
    const key = pk + '@' + ws;
    if (!groups.has(key)) groups.set(key, { patternKey: pk, workspace: ws, items: [] });
    groups.get(key).items.push(ev);
  }

  const clusters = [];
  for (const { patternKey, workspace, items: group } of groups.values()) {
    // Dedup by sessionId+turnId (keep first, since sorted DESC) (30 §3.3).
    const seen = new Set();
    const deduped = [];
    for (const ev of group) {
      const key = String(ev.sessionId) + ':' + String(ev.turnId);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(ev);
    }

    const distinctSessions = new Set(deduped.map((e) => String(e.sessionId)));
    const sources = deduped.map((e) => ({
      sessionId: String(e.sessionId),
      turnId: String(e.turnId),
      timestamp: Number(e.timestamp) || 0,
      evidenceHash: String(e.evidenceHash || ''),
    }));

    // Conflict detection (30 §5.3): both success and failure in same cluster.
    const outcomes = new Set(deduped.map((e) => String(e.resultOutcome).toLowerCase()));
    const hasSuccess = outcomes.has('success');
    const hasFailure = outcomes.has('failure') || outcomes.has('failed');
    const conflicted = hasSuccess && hasFailure;

    if (conflicted) {
      stats.conflicted++;
      clusters.push({
        patternKey,
        workspace,
        summary: summarize(deduped),
        // 30 §3 P0-1 (A.1 v2): the cluster.summary field is derived
        // from a historical message body (UNTRUSTED per 27 §3 — "历史
        // 会话始终是非可信数据"). Downstream code MUST treat this as
        // untrusted reference data, NOT as instruction. The explicit
        // flag forces every consumer to acknowledge the trust level
        // instead of inferring it from the field name.
        summaryUntrusted: true,
        sources,
        confidence: 'conflicted',
        rejectionReason: 'conflicting outcomes in same cluster',
      });
      continue;
    }

    // Stability threshold (30 §5.1 / §5.4).
    if (distinctSessions.size < minSources) {
      if (allowSingleSource && distinctSessions.size === 1) {
        // Explicit command, single source -> low confidence, marked.
        stats.kept++;
        clusters.push({
          patternKey,
          workspace,
          summary: summarize(deduped),
          summaryUntrusted: true,   // 30 §3 P0-1 (A.1 v2): always untrusted
          sources,
          confidence: 'low',
          singleSource: true,
        });
      } else {
        stats.stale++;
      }
      continue;
    }

    stats.kept++;
    clusters.push({
      patternKey,
      workspace,
      summary: summarize(deduped),
      summaryUntrusted: true,   // 30 §3 P0-1 (A.1 v2): always untrusted
      sources,
      confidence: 'high',
    });
  }

  return { clusters, stats };
}

module.exports = { runAggregator, derivePatternKey, summarize, DEFAULT_THRESHOLDS, canonical, sha256hex };