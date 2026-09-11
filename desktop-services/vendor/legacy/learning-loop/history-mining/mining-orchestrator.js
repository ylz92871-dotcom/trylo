'use strict';

/*
 * mining-orchestrator.js
 *
 * 24 §3.D5 / 24 §3.D9 / 30 §1.4 + §7: the L4 orchestration core.
 *
 *   plan -> fetch -> aggregate -> [miner runner] -> pre/post pending diff
 *        -> candidate persist
 *
 * The orchestrator is dependency-injected so it is testable without a real
 * VS Code / Hermes runtime:
 *   - planner      : retrieval-planner.runPlanner
 *   - fetch        : history-mining-client.runHistorySearch
 *   - aggregator   : aggregator.runAggregator
 *   - provenance   : provenance module (build/validate)
 *   - runner       : async (candidate, untrustedEvidence) => proposal | throws
 *                    (the HISTORY-profile miner, isolated; counts model calls)
 *   - writeApproval: { listPending(), stage(payload) }  (official staging)
 *   - state        : learning-state module (getHistoryMining/addHistoryRun/...)
 *   - logger       : (msg) => void
 *   - abortSignal  : AbortSignal for cancellation
 *
 * Hard rules (30 §7):
 *   - non-reentrant single-instance lock
 *   - model-call hard budget (BudgetExhausted -> failed/BUDGET_EXHAUSTED)
 *   - 30s budgetMs timeout via AbortSignal.timeout
 *   - background cooldown (rejected('COOLDOWN'))
 *   - `runs[]` is persisted BEFORE `candidates[]`
 *   - status precedence: failed > aborted > rejected > ok
 */

const crypto = require('node:crypto');

const DEFAULT_BUDGET_MODEL_CALLS = 3;
const DEFAULT_BUDGET_MS = 30000;
const RUNNER_OUTPUT_KEYS = ['subsystem', 'action', 'target', 'content', 'rationale'];
const FORBIDDEN_RUNNER_KEYS = ['rawPayload', 'body', 'before', 'after', 'diff', 'content_raw', 'model_choice', 'profile'];
const MAX_CONTENT_CHARS = 20000;

class BudgetExhausted extends Error {
  constructor() { super('model-call budget exhausted'); this.name = 'BudgetExhausted'; }
}
class AlreadyRunning extends Error {
  constructor() { super('a mining run is already in progress'); this.name = 'AlreadyRunning'; }
}

function _now() { return Date.now(); }

function _validateRunnerOutput(out) {
  if (!out || typeof out !== 'object') return { valid: false, error: 'runner output is not an object' };
  if (typeof out.subsystem !== 'string' || !['memory', 'skills'].includes(out.subsystem)) {
    return { valid: false, error: 'runner output.subsystem must be memory|skills' };
  }
  if (typeof out.action !== 'string' || !out.action) return { valid: false, error: 'runner output.action missing' };
  if (typeof out.target !== 'string' || !out.target) return { valid: false, error: 'runner output.target missing' };
  if (typeof out.content !== 'string' || out.content.length > MAX_CONTENT_CHARS) {
    return { valid: false, error: 'runner output.content missing or exceeds length cap' };
  }
  for (const k of RUNNER_OUTPUT_KEYS) {
    if (!(k in out)) return { valid: false, error: `runner output missing key: ${k}` };
  }
  for (const k of Object.keys(out)) {
    if (FORBIDDEN_RUNNER_KEYS.includes(k)) return { valid: false, error: `runner output carries forbidden field: ${k}` };
  }
  return { valid: true };
}

class MiningOrchestrator {
  constructor(deps) {
    this.planner = deps.planner;
    this.fetch = deps.fetch;
    this.aggregator = deps.aggregator;
    this.provenance = deps.provenance;
    this.runner = typeof deps.runner === 'function' ? deps.runner : null;
    this.writeApproval = deps.writeApproval || {};
    this.state = deps.state;
    this.log = typeof deps.logger === 'function' ? deps.logger : () => {};
    this.abortSignal = deps.abortSignal || null;
    this._running = false;
  }

  _aborted() {
    return !!(this.abortSignal && this.abortSignal.aborted);
  }

  _throwIfAborted() {
    if (this._aborted()) throw new Error('aborted');
  }

  async runOnce({ workspace, currentTask, source = 'command', thresholds, limit, state, abortSignal: callerSignal }) {
    if (this._running) throw new AlreadyRunning();
    this._running = true;
    // The caller loads the real state and passes it in; the orchestrator
    // mutates it in place via the injected `this.state` helpers and returns
    // it so the caller can save exactly once (load -> mutate -> single save).
    const targetState = (state && typeof state === 'object')
      ? state
      : { schemaVersion: 1, workspaces: {} };
    const runId = 'history-' + crypto.randomBytes(6).toString('hex');
    const startedAt = _now();
    const errors = [];
    const candidates = [];
    let status = 'ok';
    let queryPlanHash = '';
    let stats = { total: 0, kept: 0, conflicted: 0, stale: 0 };
    // B.3: declared in the function scope so the outer `finally`
    // can clear the timer regardless of which branch we exit through.
    let timeoutTimer = null;
    let timeoutCtrl = null;
    // C2 (P1) fix: composedSignal is the OR of the constructor-time
    // signal (this.abortSignal) and the per-call signal (callerSignal).
    // Previously runOnce silently dropped the caller-side signal, so
    // T3 caller-abort propagation FAILED in production.
    const baseSignal = callerSignal || this.abortSignal || null;
    const composedSignal = baseSignal;
    let _onTimeout = null;

    try {
      // hold the model budget BEFORE the runner phase (30 §7.1)
      const budget = { remaining: this._budgetModelCalls() };

      // --- background gating (30 §7.3 / §8) ---
      const hm = this.state.getHistoryMining(targetState);
      if (source === 'background') {
        if (hm.enabled !== true) {
          this._running = false;
          return { runId, startedAt, finishedAt: _now(), status: 'rejected', rejectionCode: 'DISABLED', errors, state: targetState };
        }
        if (_now() < (hm.cooldownUntil || 0)) {
          this._running = false;
          return { runId, startedAt, finishedAt: _now(), status: 'rejected', rejectionCode: 'COOLDOWN', errors, state: targetState };
        }
      }

      this._throwIfAborted();

      // --- plan (deterministic, no model) ---
      const plan = this.planner.runPlanner({ workspace, currentTask, historyMining: hm });
      if (plan.rejectionReason) {
        this._running = false;
        return { runId, startedAt, finishedAt: _now(), status: 'rejected', rejectionCode: plan.rejectionReason, errors, state: targetState };
      }
      queryPlanHash = plan.planHash;

      // --- fetch (official session_search via adapter) ---
      let fetched;
      try {
        // 30 §3 P1-5 (B.3 v2): the composed signal (caller cancel +
        // 30s timeout) is propagated to the fetch call.
        fetched = await this.fetch({ queries: plan.queries, limit, abortSignal: composedSignal });
      } catch (err) {
        errors.push({ stage: 'fetch', code: 'SEARCH_FAILED', message: err.message });
        status = 'failed';
        this._running = false;
        return { runId, startedAt, finishedAt: _now(), status, queryPlanHash, stats, candidates, errors, state: targetState };
      }
      if (!fetched || !fetched.ok) {
        errors.push({ stage: 'fetch', code: 'SEARCH_FAILED', message: (fetched && fetched.error) || 'search failed' });
        status = 'failed';
        this._running = false;
        return { runId, startedAt, finishedAt: _now(), status, queryPlanHash, stats, candidates, errors, state: targetState };
      }
      this._throwIfAborted();

      // --- aggregate (deterministic, no model) ---
      const agg = this.aggregator.runAggregator({
        evidence: fetched.results,
        thresholds,
        allowSingleSource: source === 'command',
      });
      stats = agg.stats;
      this._log(`aggregated: ${stats.total} evidence, ${stats.kept} kept, ${stats.conflicted} conflicted, ${stats.stale} stale`);

      // writeApproval must expose listPending (for the pre/post pending diff).
      const hasWriteApproval = this.writeApproval &&
        typeof this.writeApproval.listPending === 'function';
      if (!hasWriteApproval) {
        errors.push({ stage: 'stage', code: 'WRITE_APPROVAL_UNAVAILABLE', message: 'no writeApproval.listPending' });
      }

      // --- runner + proposal staging per cluster ---
      // 24 §4.3: the RUNNER stages (via HISTORY-profile memory_propose /
      // skill_propose). The orchestrator only wraps the runner call in a
      // pre/post pending diff to capture the unique pendingId (30 §7.4).
      for (const cluster of agg.clusters) {
        this._throwIfAborted();
        if (cluster.confidence === 'conflicted') continue; // never a candidate
        if (budget.remaining <= 0) {
          const e = new BudgetExhausted();
          errors.push({ stage: 'runner', code: 'BUDGET_EXHAUSTED', message: e.message });
          status = 'failed';
          break;
        }
        budget.remaining -= 1;

        const candidate = this.provenance.build({
          patternKey: cluster.patternKey,
          summary: cluster.summary,
          // 30 §3 P0-1 (A.1 v2): carry the untrusted flag through
          // the provenance DTO so every consumer sees the trust
          // level explicitly. This is the single source of truth;
          // downstream code MUST NOT infer trust from the field name.
          summaryUntrusted: cluster.summaryUntrusted === true,
          confidence: cluster.confidence,
          rationale: cluster.rejectionReason || 'cross-session pattern',
          sources: cluster.sources,
          workspace: (workspace && workspace.label) || '',
          queryPlanHash,
          now: _now,
        });

        // pre-run pending list (fail-closed)
        let before = new Set();
        if (hasWriteApproval) {
          try {
            const pre = await this.writeApproval.listPending();
            before = new Set(Array.isArray(pre) ? pre : []);
          } catch (err) {
            errors.push({ stage: 'stage', code: 'STAGE_PRE_LIST_FAILED', message: err.message });
            continue;
          }
        }

        // run the isolated miner (HISTORY profile) — model call that stages
        let proposal;
        try {
          // 30 §3 P1-5 (B.3 v2): the composed signal is also passed to
          // the runner so it can abort mid-model-call.
          proposal = await this.runner({ candidate, untrustedEvidence: cluster.sources, abortSignal: composedSignal });
        } catch (err) {
          // 31 F3 (audit P1-3): an in-flight abort mid-run must flip status to
          // 'aborted' (not be swallowed as a plain RUNNER_ERROR->continue).
          if (this._aborted() || (composedSignal && composedSignal.aborted)) {
            errors.push({ stage: 'runner', code: 'RUN_ABORTED', message: 'aborted (timeout or caller cancel)' });
            status = 'aborted';
            break;
          }
          const code = err instanceof BudgetExhausted ? 'BUDGET_EXHAUSTED' : 'RUNNER_ERROR';
          errors.push({ stage: 'runner', code, message: err.message });
          if (err instanceof BudgetExhausted) { status = 'failed'; break; }
          continue; // skip this candidate, keep the run going
        }

        // post-run pending diff (fail-closed)
        let added = [];
        if (hasWriteApproval) {
          try {
            const post = await this.writeApproval.listPending();
            added = (Array.isArray(post) ? post : []).filter((id) => !before.has(id));
          } catch (err) {
            errors.push({ stage: 'stage', code: 'STAGE_POST_LIST_FAILED', message: err.message });
            continue;
          }
        }

        const vout = _validateRunnerOutput(proposal);
        if (!vout.valid) {
          errors.push({ stage: 'runner', code: 'RUNNER_OUTPUT_INVALID', message: vout.error });
          continue; // no pending staged for this candidate
        }
        if (added.length !== 1) {
          errors.push({
            stage: 'stage',
            code: added.length > 1 ? 'AMBIGUOUS_PROPOSALS' : 'NO_PENDING_STAGED',
            message: added.length > 1 ? `staged ${added.length} pendings` : 'runner produced no pending',
          });
          continue;
        }

        candidate.proposal = {
          subsystem: proposal.subsystem,
          pendingId: String(added[0]),
          state: 'staged',
          errorCode: '',
          updatedAt: _now(),
        };
        const vCand = this.provenance.validate(candidate);
        if (!vCand.ok) {
          errors.push({ stage: 'persist', code: 'CANDIDATE_INVALID', message: vCand.reason });
          continue;
        }
        candidates.push(candidate);
      }

      // persist runs[] BEFORE candidates[] (30 §1.4)
      this.state.addHistoryRun(targetState, {
        runId, startedAt, finishedAt: _now(), status,
        queryPlanHash, stats: { ...stats },
      });
      for (const c of candidates) {
        this.state.pushHistoryCandidate(targetState, c);
      }
      this._running = false;
      return { runId, startedAt, finishedAt: _now(), status, queryPlanHash, stats, candidates, errors, state: targetState };
    } catch (err) {
      status = this._aborted() ? 'aborted' : 'failed';
      if (err instanceof AlreadyRunning) { this._running = false; throw err; }
      errors.push({ stage: 'run', code: err.name === 'BudgetExhausted' ? 'BUDGET_EXHAUSTED' : 'RUN_ERROR', message: err.message });
      // persist runs[] (status reflects the abort/failure) — candidates may be absent
      this.state.addHistoryRun(targetState, {
        runId, startedAt, finishedAt: _now(), status, queryPlanHash, stats: { ...stats }, errors,
      });
      this._running = false;
      return { runId, startedAt, finishedAt: _now(), status, queryPlanHash, stats, candidates, errors, state: targetState };
    } finally {
      // B.3: clean up the timeout controller + timer so a slow
      // run doesn't leave a dangling setTimeout or an un-aborted
      // AbortController behind. (Node will GC them, but explicit
      // cleanup is the production contract.)
      if (timeoutTimer) {
        try { clearTimeout(timeoutTimer); } catch {}
      }
    }
  }

  _budgetModelCalls() {
    return DEFAULT_BUDGET_MODEL_CALLS;
  }

  _log(msg) { try { this.log(msg); } catch {} }
}

module.exports = { MiningOrchestrator, BudgetExhausted, AlreadyRunning, _validateRunnerOutput };