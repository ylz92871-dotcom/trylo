'use strict';

/*
 * memory-pending-detector.js
 *
 * Narrow helper that detects a NEW Memory pending proposal created during
 * a Trylo turn. Uses the existing pending store/Admin as the single source
 * of truth — no second pending payload is maintained in Trylo.
 *
 * 05 §7 Phase D1.
 *
 * Strategy:
 *   1. Take a "before" snapshot of memory pending IDs BEFORE the Agent
 *      run starts (call this just before runInShadow).
 *   2. Take an "after" snapshot AFTER the run finishes.
 *   3. Return the diff as { added: string[] }.
 *
 * The caller writes the first added pendingId back to the source turn
 * via `setMemoryProposal` and triggers a non-blocking notification.
 *
 * The detector never inspects the assistant text, never trusts the
 * webview for the pendingId, and never parses MEMORY/USER content.
 */

const hermesPendingAdmin = require('./hermes-pending-admin');

/**
 * Take a snapshot of current memory pending IDs.
 * Returns a Set<string>. On any failure, returns an empty Set
 * (fail-closed: the detector is a non-essential sidecar).
 */
function snapshotMemoryPendingIds(globalStoragePath) {
  const ids = new Set();
  try {
    const result = hermesPendingAdmin.listPending(globalStoragePath);
    if (result && result.success && Array.isArray(result.pending)) {
      for (const p of result.pending) {
        if (p && p.subsystem === 'memory' && p.id) ids.add(String(p.id));
      }
    }
  } catch {
    // fail-closed
  }
  return ids;
}

/**
 * Diff "after" against "before" and return the new memory pending IDs.
 * @returns {{ ok: boolean, added: string[], error?: string }}
 */
function diffMemoryPending(before, globalStoragePath) {
  const after = snapshotMemoryPendingIds(globalStoragePath);
  const added = [];
  for (const id of after) {
    if (!before.has(id)) added.push(id);
  }
  return { ok: true, added, count: added.length };
}

/**
 * Build the memoryProposal field that lives on the source turn's learning
 * object. Minimal metadata only — no content/old_text/operations/payload.
 *
 * @param {{ pendingId: string, state?: 'staged'|'approved'|'discarded'|'failed' }} params
 */
function buildMemoryProposal({ pendingId, state }) {
  return {
    schemaVersion: 1,
    state: state || 'staged',
    pendingId: String(pendingId || ''),
    updatedAt: Date.now(),
  };
}

module.exports = {
  snapshotMemoryPendingIds,
  diffMemoryPending,
  buildMemoryProposal,
};
