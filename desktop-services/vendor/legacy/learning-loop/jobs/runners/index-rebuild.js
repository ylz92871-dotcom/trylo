'use strict';

/*
 * runners/index-rebuild.js
 *
 * L6 (34 §3 / §4.1) A-level maintenance runner.
 * Calls the existing hermes-session-sync index rebuild (read-only, 0 model
 * calls).  The actual rebuild primitive is injected via `deps.rebuild` so
 * the runner file is pure (and tests can mock it).
 *
 * Import ban (34 §1.3): this file MUST NOT import any admin / apply /
 * skill-governance path.  This is enforced by the T3 grep guard.
 */

async function run({ job, run, abortSignal, state, deps }) {
  if (abortSignal && abortSignal.aborted) {
    return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
  }
  const fn = deps && typeof deps.rebuild === 'function' ? deps.rebuild : null;
  if (!fn) {
    return { status: 'failed', errorCode: 'DEPS_MISSING', errorText: 'index-rebuild needs deps.rebuild' };
  }
  try {
    const r = await fn({ abortSignal, state, job, run });
    return {
      status: 'done',
      modelCalls: 0,
      artifacts: { rebuiltSessions: (r && r.rebuiltSessions) || 0 },
    };
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    return { status: 'failed', errorCode: 'REBUILD_FAILED', errorText: err && err.message || String(err) };
  }
}

module.exports = { run };
