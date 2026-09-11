'use strict';

/*
 * detector.js
 *
 * L5 §3 / 30 (doc 31) §1.2 + §3: deterministic pre-filter that narrows the
 * set of Skills possibly-redundant with each other. Pure — no model. Each
 * candidate carries a deterministic `reason` and Jaccard scores (never a
 * model score). Cross-platform / cross-workspace conflicts are absolute
 * hard-rejects (runner never sees them).
 */

const { normalizeName, normalizeDesc, normalizeCategory, jaccardNgrams } = require('./signals');

const DEFAULT_THRESHOLDS = { minNameSim: 0.6, minDescSim: 0.5, maxPairs: 200 };

function computeHardRejects(a, b) {
  const rejects = [];
  if (a.platforms && b.platforms && a.platforms.length && b.platforms.length) {
    const inter = a.platforms.filter((p) => b.platforms.includes(p));
    if (inter.length === 0) rejects.push(`platform:${a.platforms.join('|')} vs ${b.platforms.join('|')}`);
  }
  if (a.workspaces && b.workspaces && a.workspaces.length && b.workspaces.length) {
    const inter = a.workspaces.filter((w) => b.workspaces.includes(w));
    if (inter.length === 0) rejects.push(`workspace:${a.workspaces.join('|')} vs ${b.workspaces.join('|')}`);
  }
  return rejects;
}

function buildReason(scores, hardRejects) {
  if (hardRejects.length) return 'hard-reject: ' + hardRejects.join('; ');
  const parts = [];
  if (scores.name >= 0.6) parts.push('name-similar');
  if (scores.desc >= 0.5) parts.push('desc-similar');
  if (scores.category === 1) parts.push('same-category');
  if (parts.length === 0) return 'below-threshold';
  return parts.join(' + ');
}

/**
 * @param {object} input
 * @param {object} input.signals  { [skillName]: QualitySignal }
 * @param {object} [input.thresholds]
 * @param {object} [input.scope]  { skillNames?: string[] } | null
 * @returns {{ pairs: Array, stats: { considered, kept, conflict, rejected } }}
 */
function detectCandidates({ signals, thresholds, scope }) {
  const th = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
  const maxPairs = Number(th.maxPairs) || DEFAULT_THRESHOLDS.maxPairs;
  const names = Object.keys(signals || {});
  const scopeNames = (scope && Array.isArray(scope.skillNames)) ? new Set(scope.skillNames) : null;
  const active = scopeNames ? names.filter((n) => scopeNames.has(n)) : names;

  // Normalize once per signal.
  const norm = {};
  for (const n of names) {
    const s = signals[n];
    norm[n] = {
      name: normalizeName(s.skillName),
      desc: normalizeDesc(s.description || ''),
      category: normalizeCategory(s.category || ''),
    };
  }

  const pairs = [];
  const stats = { considered: 0, kept: 0, conflict: 0, rejected: 0 };

  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    for (let j = i + 1; j < names.length; j++) {
      const b = names[j];
      if (a === b) continue;
      const sa = signals[a], sb = signals[b];
      if (!sa || !sb) continue;
      // Signals excluded from the detector (INVALID / USAGE_MISSING) are skipped.
      if (sa.excludeFromDetector || sb.excludeFromDetector) { stats.rejected++; continue; }
      stats.considered++;

      const scores = {
        name: jaccardNgrams(norm[a].name, norm[b].name, 1),
        desc: jaccardNgrams(norm[a].desc, norm[b].desc, 1),
        category: norm[a].category === norm[b].category && norm[a].category !== '' ? 1 : 0,
      };
      const hardRejects = computeHardRejects(sa, sb);
      if (hardRejects.length) { stats.conflict++; continue; } // absolutely out

      const reason = buildReason(scores, hardRejects);
      if (reason === 'below-threshold') { stats.rejected++; continue; }

      pairs.push({
        a, b,
        aNormalized: norm[a],
        bNormalized: norm[b],
        scores,
        hardRejects,
        reason,
        evidenceRefs: [
          { kind: 'usage', value: { a: sa.usedCount, b: sb.usedCount } },
          { kind: 'platforms', value: { a: sa.platforms, b: sb.platforms } },
          { kind: 'workspaces', value: { a: sa.workspaces, b: sb.workspaces } },
        ],
      });
      stats.kept++;
    }
  }

  // maxPairs truncation by composite score.
  if (pairs.length > maxPairs) {
    pairs.sort((x, y) => {
      const sx = x.scores.name * 0.5 + x.scores.desc * 0.3 + x.scores.category * 0.2;
      const sy = y.scores.name * 0.5 + y.scores.desc * 0.3 + y.scores.category * 0.2;
      return sy - sx;
    });
    stats.rejected += pairs.length - maxPairs;
    pairs.length = maxPairs;
  }

  return { pairs, stats };
}

module.exports = { detectCandidates, computeHardRejects, buildReason, DEFAULT_THRESHOLDS };