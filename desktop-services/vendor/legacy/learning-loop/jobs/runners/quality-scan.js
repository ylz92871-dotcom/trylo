'use strict';

/*
 * runners/quality-scan.js
 *
 * L6 (34 §3 / §4.1) B-level maintenance runner.
 * Wraps the L5 skill-quality scan + (G1) proposal staging. The actual scan
 * and proposal construction is injected via `deps.scan` so the runner file
 * is pure.  This runner NEVER auto-confirms a user action: it only stages
 * proposals into the lifecycle state, leaving human review to the existing
 * tryloCode.reviewHermesPending flow.
 *
 * Import ban (34 §1.3): no admin / apply / skill-governance imports here.
 */

async function run({ job, run, abortSignal, state, deps }) {
  if (abortSignal && abortSignal.aborted) {
    return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
  }
  const fn = deps && typeof deps.scan === 'function' ? deps.scan : null;
  if (!fn) {
    return { status: 'failed', errorCode: 'DEPS_MISSING', errorText: 'quality-scan needs deps.scan' };
  }
  try {
    const r = await fn({ abortSignal, state, job, run });
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    return {
      status: 'done',
      modelCalls: Number(r && r.modelCalls) || 0,
      artifacts: {
        signals: (r && r.signals) || 0,
        pairs: (r && r.pairs) || 0,
        proposals: (r && r.proposals) || 0,
      },
    };
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    return { status: 'failed', errorCode: 'QUALITY_SCAN_FAILED', errorText: err && err.message || String(err) };
  }
}

module.exports = { run };
