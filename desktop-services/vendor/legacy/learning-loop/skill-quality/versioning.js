'use strict';

/*
 * versioning.js
 *
 * L5 §3 / 30 (doc 31) §1.4 + §5: per-Skill provenance/version chain stored in
 * learning-state.skillQuality.versions. It stores ONLY governance metadata
 * (snapshotId references to the official backup), never Skill content.
 * Rollback is always done through the official `rollback`.
 */

const MAX_LINEAGE = 50;

function _defaultChain(skillName) {
  return {
    skillName,
    current: { snapshotId: '', parentSnapshotId: null, changeReason: '', changeAction: 'edit', changedAt: 0, actor: 'system' },
    lineage: [],
  };
}

function getChain(state, skillName) {
  const v = state.skillQuality && state.skillQuality.versions;
  if (!v || !v[skillName]) return null;
  return v[skillName];
}

/**
 * Append a lineage entry and update `current`.
 * @param {object} state
 * @param {string} skillName
 * @param {object} change { parentSnapshotId, changeReason, changeAction, actor }
 * @returns updated VersionChain
 */
function appendLineage(state, skillName, change) {
  if (!state.skillQuality) state.skillQuality = { signals: {}, proposals: [], versions: {}, lastScanAt: 0, cooldownUntil: 0 };
  if (!state.skillQuality.versions) state.skillQuality.versions = {};
  const chain = state.skillQuality.versions[skillName] || _defaultChain(skillName);
  const changedAt = Date.now();
  const entry = {
    snapshotId: String(change.parentSnapshotId || chain.current.snapshotId || ''),
    parentSnapshotId: change.parentSnapshotId != null ? String(change.parentSnapshotId) : (chain.lineage.length ? chain.lineage[chain.lineage.length - 1].snapshotId : null),
    changeReason: String(change.changeReason || ''),
    changeAction: String(change.changeAction || 'edit'),
    changedAt,
  };
  chain.lineage.push(entry);
  if (chain.lineage.length > MAX_LINEAGE) {
    chain.lineage = chain.lineage.slice(chain.lineage.length - MAX_LINEAGE);
  }
  chain.current = {
    snapshotId: entry.snapshotId,
    parentSnapshotId: entry.parentSnapshotId,
    changeReason: entry.changeReason,
    changeAction: entry.changeAction,
    changedAt,
    actor: String(change.actor || 'system'),
  };
  state.skillQuality.versions[skillName] = chain;
  return chain;
}

/**
 * Detect a broken lineage chain (a parentSnapshotId no longer exists in the
 * official backup set).
 */
function validateLineage(chain, officialBackupsExist) {
  if (!chain || !Array.isArray(chain.lineage)) return { ok: true };
  for (const entry of chain.lineage) {
    if (entry.parentSnapshotId && officialBackupsExist && !officialBackupsExist.has(entry.parentSnapshotId)) {
      return { ok: false, reason: 'BROKEN_PARENT', atEntry: entry };
    }
  }
  return { ok: true };
}

module.exports = { appendLineage, validateLineage, getChain, MAX_LINEAGE };