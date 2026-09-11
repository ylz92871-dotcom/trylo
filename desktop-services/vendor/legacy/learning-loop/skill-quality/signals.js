'use strict';

/*
 * signals.js
 *
 * L5 §3 / 30 (doc 31) §1.1 + §2: deterministic quality-signal aggregation.
 * For every Skill it produces one `QualitySignal` DTO whose fields are all
 * derivable from the official graph / usage / scan data — NO model scores,
 * NO free text. Each field records its `signalSource` so the signal is
 * auditable (27 §4.3 "质量信号必须可解释").
 *
 * Phase 0 probe established the REAL Hermes 0.19.0 shapes:
 *   - usage_report() -> LIST of records: { name, use_count, view_count,
 *     patch_count, last_used_at, last_activity_at, state, provenance, ... }
 *     (NOT the doc's `{skills:{...}}` object; field names are snake_case)
 *   - build_learning_graph() -> { nodes:[], edges:[], clusters:[], memory:[],
 *     stats:{} }; node has name/category/description/adjacency/metadata
 *   - scan_skill(Path) -> ScanResult{ verdict, findings, ... }
 *
 * The doc's `verifiedOk/verifiedFailed` are NOT in the usage record; they map
 * to null (per §2.1 "缺 -> null + signalSource null"). `platforms/workspaces`
 * are read from the SKILL.md frontmatter (applies_to_platform/
 * applies_to_workspace) via the curation_adapter, else null.
 *
 * Pure function, no IO, no model.
 */

const MAX_SIGNALS = 500;

function _toMs(iso) {
  if (iso == null) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

function _int(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

function _stripSecrets(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/gi, '[REDACTED]')
    .replace(/\b(AKIA[0-9A-Z]{16})\b/gi, '[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{36,})\b/gi, '[REDACTED]')
    .replace(/\b(Bearer\s+)([A-Za-z0-9._\-]{8,})/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key\s*[:=]\s*)([^\s,;]{8,})/gi, '$1[REDACTED]')
    .replace(/\b(token\s*[:=]\s*)([^\s,;]{8,})/gi, '$1[REDACTED]')
    .replace(/\b(password\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]')
    .replace(/\b(secret\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]')
    .replace(/\b(credential[s]?\s*[:=]\s*)([^\s,;]{3,})/gi, '$1[REDACTED]');
}

function _setFieldWithSource(sig, field, value, source) {
  if (value == null) {
    sig[field] = null;
    sig.signalSource[field] = null;
  } else {
    sig[field] = value;
    sig.signalSource[field] = source;
  }
}

/**
 * Build QualitySignals from the curation_adapter output.
 *
 * @param {object} input
 * @param {object} input.graphSummary     build_learning_graph() result
 * @param {Array}  input.usageRecords     usage_report() LIST of records
 * @param {object} [input.frontmatter]    { [skillName]: { applies_to_platform, applies_to_workspace, deprecated, archive, security_blocked } } (from curation_adapter)
 * @param {object} [input.stateSnapshot]  { skillQuality: { signals: {...} } } for incremental
 * @returns {{ signals: object, generatedAt: number, missingUsage: string[], conflictFlags: Array }}
 */
function buildSignals({ graphSummary, usageRecords, frontmatter, stateSnapshot }) {
  const generatedAt = Date.now();
  const stats = { INVALID: 0, USAGE_MISSING: 0 };
  const signals = {};
  const missingUsage = [];
  const conflictFlags = [];

  const nodes = (graphSummary && Array.isArray(graphSummary.nodes)) ? graphSummary.nodes : [];
  const usageByName = new Map();
  for (const rec of Array.isArray(usageRecords) ? usageRecords : []) {
    if (rec && rec.name) usageByName.set(String(rec.name), rec);
  }

  for (const node of nodes) {
    // 33 F1 (audit P0-1): the real curation_adapter.build_summary() emits
    // safe_nodes with {id, label, kind} — NOT {name, category, description}.
    // Accept any of {name, id, label} for the skill key, and fall back for
    // category (kind) + description (label) so signals build from the REAL
    // adapter output, not just a hand-crafted test input.
    const name = String(node.name || node.id || node.label || '').trim();
    if (!name) continue;

    const categoryRaw = node.category != null ? node.category : (node.kind != null ? node.kind : null);
    const descriptionRaw = node.description != null ? node.description : (node.label != null ? node.label : null);
    const usage = usageByName.get(name);
    const fm = (frontmatter && frontmatter[name]) || {};
    const sig = {
      skillName: name,
      category: (categoryRaw != null ? String(categoryRaw) : null),
      description: descriptionRaw != null ? _stripSecrets(String(descriptionRaw)).slice(0, 200) : null,
      usedCount: null,
      lastUsedAt: null,
      lastVerifiedAt: null,
      verifiedOk: null,
      verifiedFailed: null,
      platforms: null,
      workspaces: null,
      sourceCount: 0,
      conflictFlags: [],
      generatedAt,
      signalSource: {
        category: categoryRaw != null ? 'graph.metadata' : null,
        description: descriptionRaw != null ? 'graph.metadata' : null,
        usedCount: null,
        lastUsedAt: null,
        lastVerifiedAt: null,
        verifiedOk: null,
        verifiedFailed: null,
        platforms: null,
        workspaces: null,
      },
    };

    if (usage) {
      _setFieldWithSource(sig, 'usedCount', _int(usage.use_count), 'usage_report');
      _setFieldWithSource(sig, 'lastUsedAt', _toMs(usage.last_used_at), 'usage_report');
      _setFieldWithSource(sig, 'lastVerifiedAt', _toMs(usage.last_activity_at), 'usage_report');
      // verifiedOk/verifiedFailed are not in the usage record -> null.
      _setFieldWithSource(sig, 'verifiedOk', null, null);
      _setFieldWithSource(sig, 'verifiedFailed', null, null);
    } else {
      missingUsage.push(name);
      stats.USAGE_MISSING++;
      sig.INVALID = true;
      sig.excludeFromDetector = true;
    }

    // platforms/workspaces from SKILL.md frontmatter (metadata read).
    if (Array.isArray(fm.applies_to_platform) && fm.applies_to_platform.length) {
      const plats = fm.applies_to_platform.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
      _setFieldWithSource(sig, 'platforms', plats, 'graph.metadata');
    }
    if (Array.isArray(fm.applies_to_workspace) && fm.applies_to_workspace.length) {
      const ws = [...new Set(fm.applies_to_workspace.map((w) => String(w).trim()).filter(Boolean))].sort();
      _setFieldWithSource(sig, 'workspaces', ws, 'graph.metadata');
    }
    sig.sourceCount = (Array.isArray(sig.workspaces) ? new Set(sig.workspaces).size : 0);

    // 31 §2.2 consistency: verifiedOk + verifiedFailed <= usedCount.
    if (sig.usedCount != null && sig.verifiedOk != null && sig.verifiedFailed != null) {
      if (sig.verifiedOk + sig.verifiedFailed > sig.usedCount) {
        stats.INVALID++;
        conflictFlags.push({ skillName: name, reason: 'USAGE_DATA_INCONSISTENT', sources: [{ kind: 'usage', value: { usedCount: sig.usedCount, verifiedOk: sig.verifiedOk, verifiedFailed: sig.verifiedFailed } }] });
        sig.INVALID = true;
        sig.excludeFromDetector = true;
      }
    }

    signals[name] = sig;
  }

  return { signals, generatedAt, missingUsage, conflictFlags, stats };
}

/**
 * Cap signals at MAX_SIGNALS (500): drop oldest by (lastUsedAt DESC, name ASC);
 * a signal with INVALID/exclude is never dropped ahead of a healthy one except
 * by the same rule (signals have no staged semantic).
 */
function capSignals(signals) {
  const entries = Object.entries(signals);
  if (entries.length <= MAX_SIGNALS) return signals;
  entries.sort((a, b) => {
    const aT = a[1].lastUsedAt || 0;
    const bT = b[1].lastUsedAt || 0;
    if (bT !== aT) return bT - aT;
    return a[0].localeCompare(b[0]);
  });
  const dropped = entries.slice(MAX_SIGNALS).map(([n]) => n);
  const out = Object.fromEntries(entries.slice(0, MAX_SIGNALS));
  return { signals: out, dropped };
}

// Export the normalization helpers for detector + tests.
function normalizeName(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function normalizeDesc(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeCategory(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim();
}
function jaccardNgrams(a, b, n = 1) {
  const ng = (s) => { const out = new Set(); for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n)); return out; };
  const A = ng(a), B = ng(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

module.exports = {
  buildSignals,
  capSignals,
  normalizeName,
  normalizeDesc,
  normalizeCategory,
  jaccardNgrams,
  MAX_SIGNALS,
  _stripSecrets,
};