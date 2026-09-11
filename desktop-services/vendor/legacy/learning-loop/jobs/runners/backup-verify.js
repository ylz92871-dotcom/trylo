'use strict';

/*
 * runners/backup-verify.js
 *
 * L6 (34 §3 / §4.1) A-level maintenance runner.
 * Verifies the integrity of the most recent Hermes Skill backup. The actual
 * verification primitive is injected via `deps.verify` (read-only).
 */

async function run({ job, run, abortSignal, state, deps }) {
  if (abortSignal && abortSignal.aborted) {
    return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
  }
  const fn = deps && typeof deps.verify === 'function' ? deps.verify : null;
  if (!fn) {
    return { status: 'failed', errorCode: 'DEPS_MISSING', errorText: 'backup-verify needs deps.verify' };
  }
  try {
    const r = await fn({ abortSignal, state, job, run });
    return {
      status: 'done',
      modelCalls: 0,
      artifacts: { checked: (r && r.checked) || 0, latestOk: !!(r && r.latestOk) },
    };
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    return { status: 'failed', errorCode: 'BACKUP_VERIFY_FAILED', errorText: err && err.message || String(err) };
  }
}

module.exports = { run };
