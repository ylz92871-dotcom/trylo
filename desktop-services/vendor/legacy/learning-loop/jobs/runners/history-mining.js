'use strict';

/*
 * runners/history-mining.js
 *
 * L6 (34 §3 / §4.1) B-level maintenance runner.
 * Wraps the L4 MiningOrchestrator.runOnce() with `source: 'job'`. The L4
 * orchestrator already enforces its own budget + cooldown + idempotency +
 * the pre/post pending diff. On top of that, the L6 wrapper enforces the
 * per-job L6 budget by inspecting the orchestrator's actual candidate
 * count (= its effective model-call count: each candidate consumes 1
 * model call inside the L4 runner).
 *
 * Import ban (34 §1.3): this file MUST NOT import admin / apply / merge /
 * skill-governance paths.  The orchestrator is an allowed module.
 */

async function run({ job, run, abortSignal, state, deps }) {
  if (abortSignal && abortSignal.aborted) {
    return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
  }
  const factory = deps && typeof deps.buildOrchestrator === 'function' ? deps.buildOrchestrator : null;
  if (!factory) {
    return { status: 'failed', errorCode: 'DEPS_MISSING', errorText: 'history-mining needs deps.buildOrchestrator' };
  }
  let orchestrator;
  try {
    orchestrator = factory({ job, run, abortSignal, state });
  } catch (e) {
    return { status: 'failed', errorCode: 'ORCHESTRATOR_BUILD_FAILED', errorText: e && e.message || String(e) };
  }
  try {
    const result = await orchestrator.runOnce({
      workspace: (deps.workspace && deps.workspace()) || { label: 'job', path: '' },
      currentTask: (deps.currentTask && deps.currentTask()) || 'history-mining job',
      source: 'job',
      state,
    });
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    const status = result.status === 'ok' ? 'done'
      : (result.status === 'aborted' ? 'aborted'
      : (result.status === 'rejected' ? 'skipped' : 'failed'));
    // P0 fix: the L4 orchestrator does 1 model call per cluster it
    // processes (see mining-orchestrator.js: `budget.remaining -= 1` per
    // cluster). The actual number of model calls the job made is the
    // number of clusters it attempted, which equals candidates.length +
    // (clusters skipped before reaching the runner).
    //
    // The simplest faithful report is `candidates.length + errors.length`
    // (each error represents one attempted cluster that the runner saw).
    // For a clean run with no errors, that is exactly candidates.length.
    // For runs with errors, the L4 still consumed a model call per error
    // (or it short-circuited — we approximate with the total attempts).
    const actualCalls = (result.candidates ? result.candidates.length : 0)
      + (result.errors ? result.errors.length : 0);
    return {
      status,
      modelCalls: actualCalls,
      errorCode: (result.errors && result.errors[0] && result.errors[0].code) || '',
      errorText: (result.errors && result.errors[0] && result.errors[0].message) || '',
      artifacts: { candidates: (result.candidates || []).length },
    };
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      return { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
    }
    return { status: 'failed', errorCode: err && err.name || 'ORCHESTRATOR_THREW', errorText: err && err.message || String(err) };
  }
}

module.exports = { run };
