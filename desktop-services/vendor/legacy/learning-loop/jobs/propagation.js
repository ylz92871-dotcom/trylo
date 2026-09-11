'use strict';

/*
 * propagation.js
 *
 * L6 (34 §4.7 / §11) workspace deletion propagation. The order is
 * STRUCTURAL — abort in-flight job BEFORE purging derived state, so a
 * mid-purge tick cannot reach the cleaned area. T7 verifies the order.
 *
 *   1. scheduler.abortJob(jobId) for every def in this workspace
 *   2. registry.remove(jobId)
 *   3. learningState.clearRunsForJob(jobId)  (keeps running/interrupted)
 *   4. learningState.removeHistoryByWorkspace(workspaceId)
 *   5. learningState.removeSkillQualityByWorkspace(workspaceId)
 *   6. persist
 *
 * Helpers 4 & 5 are best-effort: the workspace's history / skillQuality
 * sections may not have the helper; we call them defensively.
 */

async function purgeWorkspace(opts) {
  const { workspaceId, scheduler, registry, state, learningState, persist, logger } = opts || {};
  if (!workspaceId) return { removed: [], aborted: 0 };
  if (!registry) return { removed: [], aborted: 0, error: 'NO_REGISTRY' };
  const log = typeof logger === 'function' ? logger : () => {};
  const aborted = [];
  const removed = [];

  // 1 + 2: cancel-then-remove for each scoped job.
  const defs = registry.list().filter((d) => d && d.scopeWorkspace === workspaceId);
  for (const d of defs) {
    if (scheduler && typeof scheduler.abortJob === 'function') {
      try {
        const r = scheduler.abortJob(d.jobId);
        if (r && r.aborted) aborted.push({ jobId: d.jobId, aborted: r.aborted });
      } catch (e) {
        log(`abortJob ${d.jobId} failed: ${e && e.message || e}`);
      }
    }
    // 34 §11: abort FIRST, then remove. T7 verifies this order with a
    // call-counting mock.
    try { registry.remove(d.jobId); removed.push(d.jobId); } catch (e) {
      log(`registry.remove ${d.jobId} failed: ${e && e.message || e}`);
    }
  }

  // 3: best-effort: drop terminal runs; running/interrupted are protected.
  for (const jobId of removed) {
    if (learningState && typeof learningState.clearRunsForJob === 'function') {
      try { learningState.clearRunsForJob(state, jobId); } catch {}
    }
  }

  // 4 + 5: workspace-scoped purges.
  if (learningState) {
    if (typeof learningState.removeHistoryByWorkspace === 'function') {
      try { learningState.removeHistoryByWorkspace(state, workspaceId); } catch {}
    }
    if (typeof learningState.removeSkillQualityByWorkspace === 'function') {
      try { learningState.removeSkillQualityByWorkspace(state, workspaceId); } catch {}
    }
  }

  // 6: persist (caller-supplied).
  if (typeof persist === 'function') {
    try { await persist(); } catch (e) { log(`persist failed: ${e && e.message || e}`); }
  }

  return { removed, aborted, defs: defs.length };
}

module.exports = { purgeWorkspace };
