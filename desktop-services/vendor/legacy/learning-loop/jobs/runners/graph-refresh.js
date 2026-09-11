'use strict';

/*
 * runners/graph-refresh.js
 *
 * L6 (34 §3 / §4.1) A-level maintenance runner.
 * Refreshes the cached Skill-quality signals by re-reading the official
 * curation graph. The actual refresh primitive is injected via `deps.refresh`
 * (read-only, 0 model calls).
 */

async function run({ job, run, abortSignal, state, deps }) {
  if (abortSignal && abortSignal.aborted) {
    return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
  }
  const fn = deps && typeof deps.refresh === 'function' ? deps.refresh : null;
  if (!fn) {
    return { status: 'failed', errorCode: 'DEPS_MISSING', errorText: 'graph-refresh needs deps.refresh' };
  }
  try {
    const r = await fn({ abortSignal, state, job, run });
    return {
      status: 'done',
      modelCalls: 0,
      artifacts: { signals: (r && r.signals) || 0 },
    };
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    return { status: 'failed', errorCode: 'GRAPH_REFRESH_FAILED', errorText: err && err.message || String(err) };
  }
}

module.exports = { run };
