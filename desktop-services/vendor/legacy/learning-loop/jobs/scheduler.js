'use strict';

/*
 * scheduler.js
 *
 * L6 (34 §3) in-process job scheduler. Driven by Node setInterval (the
 * upstream Hermes cron daemon is a separate gateway that executes jobs in
 * isolated Agent sessions — it cannot be reused as a library inside the
 * Trylo extension host, per L6 §2 + §10 Phase 0).
 *
 * Hard rules (34 §3 + §4 + §17):
 *   - cross-window lock via state.jobs.lock (NO file lock)
 *   - stale lock preempt when heartbeat > 2*tickMs
 *   - idempotency: runId = jobId + ':' + scheduledForTime
 *   - mark run 'running' and persist BEFORE the side-effect
 *   - B-level budget enforced at the wrapper (not the runner)
 *   - AbortController per run, child of scheduler.abortController
 *   - interrupted runs on startup (NOT auto-resumed; A-level next tick
 *     recurs naturally, B-level needs explicit user action)
 *   - 3 consecutive A-level failures -> auto disable
 *   - same errorCode 24h -> single notification
 *   - errorText scrubbed: max 200 chars + body redaction
 */

const { JobRegistry } = require('./registry');
const { redactErrorText } = require('./redact');

const FORBIDDEN_FALLBACK_LEVEL = 'C';

class SchedulerError extends Error { }

class Scheduler {
  /**
   * @param {object} opts
   * @param {JobRegistry} opts.registry
   * @param {object} opts.runners          { [type: string]: async ({job, run, abortSignal, state, budget}) => {status, modelCalls?, errorCode?, errorText?, artifacts?} }
   * @param {object} opts.state            learning-state module (provides getJobs / setJobLock / addJobRun / etc.)
   * @param {function} opts.logger         (msg, meta?) => void
   * @param {function} opts.persist        async () => void   - persists the state
   * @param {function} opts.notify         async (level, title, body) => void  - shows a VS Code message; level='info'|'warn'|'error'
   * @param {string} opts.ownerId          unique id for this scheduler instance
   * @param {number} opts.tickMs           scheduler tick interval (default 30_000)
   * @param {number} opts.settleMs         max wait for in-flight to settle on stop() (default 2_000)
   * @param {number} opts.staleMs          stale lock threshold (default 2*tickMs)
   * @param {function} opts.getActiveWorkspace  () => string | null — used to enforce
   *                                            scopeWorkspace at dispatch (34 §4.7).
   *                                            When null/undefined, scoped jobs are
   *                                            never dispatched (safe fallback).
   */
  constructor(opts) {
    if (!opts || !opts.registry) throw new SchedulerError('scheduler needs a registry');
    if (!opts.runners || typeof opts.runners !== 'object') throw new SchedulerError('scheduler needs a runners map');
    if (!opts.state || typeof opts.state !== 'object' || typeof opts.state.getJobs !== 'function') {
      throw new SchedulerError('scheduler needs a learning-state MODULE (with getJobs)');
    }
    if (!opts.data || typeof opts.data !== 'object') {
      throw new SchedulerError('scheduler needs a data blob');
    }
    if (!opts.persist) throw new SchedulerError('scheduler needs a persist() callback');
    this.registry = opts.registry;
    this.runners = opts.runners;
    this.state = opts.state;     // module
    this.data = opts.data;       // data blob
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.persist = opts.persist;
    this.notify = typeof opts.notify === 'function' ? opts.notify : async () => {};
    this.ownerId = String(opts.ownerId || ('owner-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)));
    this.tickMs = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : 30_000;
    this.settleMs = Number(opts.settleMs) > 0 ? Number(opts.settleMs) : 2_000;
    this.staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : this.tickMs * 2;
    // F2 (P1-3): real cross-window lock via FS-level lockfile. The
    // state.jobs.lock field is now an audit mirror only — the
    // authoritative mutex lives at `{lockDir}/trylo-jobs.lock` and
    // is shared between windows via the OS filesystem. If lockDir
    // is not provided (e.g. tests), we fall back to the in-process
    // Map-based lock — still works for unit tests that share data.
    this.lockDir = typeof opts.lockDir === 'string' ? opts.lockDir : null;
    this._timer = null;
    this._abortController = null;
    this._runControllers = new Map();   // runId -> AbortController
    this._inflight = new Set();          // runId
    this._busy = false;                  // re-entrancy guard
    this._stopping = false;
    this._notifiedKeys = new Set();
    this._notifiedKeysMax = 1000;   // P2 fix: bound the dedupe set.
    this._catchUpRan = false;
    this._catchUpLockTs = 0;
    this.getActiveWorkspace = typeof opts.getActiveWorkspace === 'function' ? opts.getActiveWorkspace : null;
    // L7-B: optional degraded-state predicate. When the predicate
    // returns true, tick() and runNow() refuse to dispatch. Production
    // code wires this to `health.isDegraded(data)`.
    this.isDegraded = typeof opts.isDegraded === 'function' ? opts.isDegraded : null;
    // F2: keep a fast in-process mirror so single-process tests
    // (no lockDir) still serialize ticks. The real cross-window
    // lock is the lockfile when lockDir is set.
    this._inProcessLock = null;
  }

  _mod(name) {
    const fn = this.state && this.state[name];
    if (typeof fn !== 'function') {
      throw new SchedulerError('learning-state is missing ' + name);
    }
    return fn;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  start() {
    if (this._timer) return;
    this._stopping = false;
    this._abortController = new AbortController();
    // 34 §4.4: recover interrupted runs on startup; do NOT auto-resume.
    this._recoverInterrupted();
    this._timer = setInterval(() => {
      // microtask: never run two ticks concurrently in this instance.
      this._safeTick();
    }, this.tickMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    // v2-audit fix (P1): a separate heartbeat timer refreshes the
    // lockfile mtime every tickMs/2 while a dispatch is in flight.
    // Without this, a long B-level run (history-mining / quality-scan
    // with model calls) can take longer than staleMs, and another
    // window would see the lock as stale and preempt mid-run.
    if (this.lockDir) {
      this._heartbeatTimer = setInterval(() => {
        if (this._inflight.size > 0) {
          this._heartbeatLockfile().catch(() => {});
        }
      }, Math.max(1000, Math.floor(this.tickMs / 2)));
      if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
    }
    this.log(`scheduler started ownerId=${this.ownerId} tickMs=${this.tickMs}`);
  }

  async stop() {
    if (this._stopping) return;
    this._stopping = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // L6 v2 fix: stop the lockfile heartbeat before settle.
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    // wait for in-flight to settle (≤ settleMs)
    const deadline = Date.now() + this.settleMs;
    while (this._inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // Force-abort stragglers (only on stop, not in tick).
    for (const c of this._runControllers.values()) {
      try { c.abort(); } catch {}
    }
    // v2-audit fix: release the lockfile we acquired on the last
    // tick. Without this, the lockfile is left on disk for the
    // lifetime of the OS, accumulating per activate. The next
    // activate's ownerId is different (has a nonce) and will
    // adopt it via stale-preempt, but cleanup is still correct.
    await this._releaseLockfile();
    this.log(`scheduler stopped ownerId=${this.ownerId} inflightLeft=${this._inflight.size}`);
  }

  isRunning() {
    return !!this._timer && !this._stopping;
  }

  // ── cross-window lock (F2 / 34 §3.2) ────────────────────────────────────
  // The authoritative mutex is the FS-level lockfile at
  // {lockDir}/trylo-jobs.lock. The state.jobs.lock field is an
  // AUDIT MIRROR (UI display / post-mortem) and is kept in sync
  // after a successful lockfile acquire. When lockDir is not set
  // (unit tests), we fall back to the in-process Map which still
  // serializes ticks within one process.
  //
  // `_acquireLock`, `_heartbeat`, `_releaseLock` are sync
  // (callers expect sync return). When lockDir is set they
  // return the SYNC result of the in-process mirror — the
  // lockfile acquire is kicked off as a fire-and-forget, and
  // the state.jobs.lock mirror is updated when the lockfile
  // promise resolves. This keeps the call site unchanged while
  // letting the lockfile be the real arbiter across processes.
  //
  // For TICK dispatch, the cross-process serialization matters:
  //  - Within a single process, _inProcessLock synchronizes.
  //  - Across processes, the lockfile (which uses fsp.open('wx')
  //    for atomic create) does the real work.
  //  - To bridge, the tick path awaits the lockfile acquire
  //    BEFORE writing the in-process lock, and awaits the
  //    lockfile release after clearing the in-process lock.
  //
  // See _tickAsync for the full async path. The sync methods
  // here are kept for runNow / API consumers that want a quick
  // "am I the owner right now" check; they use the in-process
  // mirror only.

  _acquireLock() {
    const now = Date.now();
    // Sync in-process mirror.
    if (this._inProcessLock && this._inProcessLock.ownerId !== this.ownerId) {
      // Stale?
      if (now - this._inProcessLock.heartbeatAt > this.staleMs) {
        this.log(`in-process stale lock preempted from=${this._inProcessLock.ownerId} to=${this.ownerId}`);
        this._inProcessLock = { ownerId: this.ownerId, acquiredAt: now, heartbeatAt: now };
        this._mirrorAuditLock(this._inProcessLock);
        return { ok: true, preempted: true };
      }
      return { ok: false, lockState: this._inProcessLock };
    }
    this._inProcessLock = { ownerId: this.ownerId, acquiredAt: now, heartbeatAt: now };
    this._mirrorAuditLock(this._inProcessLock);
    return { ok: true, preempted: false };
  }

  _releaseLock() {
    if (this._inProcessLock && this._inProcessLock.ownerId === this.ownerId) {
      this._inProcessLock = null;
      this._mirrorAuditLock(null);
    }
  }

  _heartbeat() {
    if (this._inProcessLock && this._inProcessLock.ownerId === this.ownerId) {
      this._inProcessLock.heartbeatAt = Date.now();
      this._mirrorAuditLock(this._inProcessLock);
    }
  }

  // Audit mirror write — non-throwing. state.jobs.lock is for UI.
  _mirrorAuditLock(lockState) {
    try { this._mod("setJobLock")(this.data, lockState); } catch {}
  }

  /**
   * Async cross-process lockfile acquire. Tick path calls this
   * before doing the in-process acquire, so two windows of the same
   * VS Code install get serialized by the FS even if they have
   * independent state.jobs.lock mirrors.
   */
  async _acquireLockfile() {
    if (!this.lockDir) return { ok: true, preempted: false, lockState: null };
    const lockfile = require('./lockfile');
    try {
      return await lockfile.acquire(this.lockDir, this.ownerId, this.staleMs);
    } catch (e) {
      this.log(`lockfile acquire threw: ${e && e.message || e}; failing closed`);
      return { ok: false, lockState: { error: (e && e.message) || 'lockfile_error' } };
    }
  }

  async _heartbeatLockfile() {
    if (!this.lockDir) return false;
    const lockfile = require('./lockfile');
    try { return await lockfile.heartbeat(this.lockDir, this.ownerId); }
    catch { return false; }
  }

  async _releaseLockfile() {
    if (!this.lockDir) return false;
    const lockfile = require('./lockfile');
    try { return await lockfile.release(this.lockDir, this.ownerId); }
    catch { return false; }
  }

  // ── interrupted recovery (34 §4.4 / §8) ───────────────────────────────

  _recoverInterrupted() {
    const jobs = this._mod("getJobs")(this.data);
    const runs = Array.isArray(jobs.runs) ? jobs.runs : [];
    const interrupted = runs.filter((r) => r && r.status === 'running');
    if (interrupted.length === 0) return { recovered: 0 };
    const now = Date.now();
    for (const r of interrupted) {
      r.status = 'interrupted';
      r.finishedAt = now;
      r.errorCode = r.errorCode || 'INTERRUPTED_BY_RESTART';
      r.errorText = redactErrorText(r.errorText || '');
    }
    this.log(`recovered ${interrupted.length} interrupted run(s)`);
    // Persist (caller's persist fn is async; fire-and-forget is fine because
    // start() does not need to await it).
    try { Promise.resolve(this.persist()).catch(() => {}); } catch {}
    return { recovered: interrupted.length };
  }

  // ── tick (34 §3.1) ─────────────────────────────────────────────────────

  _safeTick() {
    if (this._busy || this._stopping) return;
    this._busy = true;
    // Use a promise chain so re-entrancy stays serial.
    Promise.resolve()
      .then(() => this.tick())
      .catch((err) => this.log(`tick error: ${err && err.message || err}`))
      .finally(() => { this._busy = false; });
  }

  async tick() {
    if (this._stopping) return { ran: 0, reason: 'stopping' };
    // L7-B: pause dispatch when health is degraded (HERMES missing,
    // version mismatch, etc.). A-level and B-level both pause.
    if (this.isDegraded && this.isDegraded()) {
      return { ran: 0, reason: 'degraded' };
    }
    const due = this._findDue();
    if (!due) {
      // No due job: release lock if we hold it.
      this._releaseLock();
      return { ran: 0, reason: 'no-due' };
    }
    // 34 §4.7 / P0 fix: enforce scopeWorkspace. A job scoped to workspace
    // W must NOT run when the active workspace is anything else (including
    // null/empty). Unscoped jobs (scopeWorkspace=null) always run.
    if (due.scopeWorkspace && !this._isWorkspaceActive(due.scopeWorkspace)) {
      this._advanceNextRun(due, due.nextRunAt);
      this._releaseLock();
      return { ran: 0, reason: 'wrong-workspace' };
    }
    // F2 (P1-3): cross-window serialization via lockfile FIRST. The
    // in-process lock below would let two VS Code windows both
    // dispatch because they don't share memory. The lockfile is the
    // shared FS substrate.
    //
    // 39 C3 (P1): every "acquired lockfile" path now goes through
    // a single try/finally so the lockfile is ALWAYS released, on
    // normal return, on already-run / interrupted-B / in-process
    // lock failure, on dispatch throw, on every early return. The
    // ownership check (current.ownerId === this.ownerId) inside
    // _releaseLockfile prevents accidentally clearing a lock that
    // belongs to a different owner (e.g. preempted on stale).
    let lfLock = null;
    if (this.lockDir) {
      lfLock = await this._acquireLockfile();
      if (!lfLock.ok) {
        return { ran: 0, reason: 'locked', lockState: lfLock.lockState };
      }
    }
    let lfReleased = false;
    const releaseLockfileOnce = () => {
      if (lfReleased) return;
      lfReleased = true;
      if (this.lockDir) {
        // fire-and-forget: don't block tick return on release.
        this._releaseLockfile().catch(() => {});
      }
    };
    try {
    const lock = this._acquireLock();
    if (!lock.ok) {
      // another instance owns the lock; skip. The finally below
      // releases the lockfile (acquired above).
      return { ran: 0, reason: 'locked' };
    }
    this._heartbeat();
    // 34 §3.1 step 3a: mark run 'running' + persist BEFORE side-effect.
    const scheduledForTime = due.nextRunAt;
    const runId = JobRegistry.runIdFor(due.jobId, scheduledForTime);
    const existing = this._mod("findJobRun")(this.data, runId);
    if (existing) {
      // P1 fix (F1): an 'interrupted' run is retried ONLY for A-level
      // jobs. B-level interrupted runs (history-mining / quality-scan)
      // must NOT auto-resume — they cost model calls + may stage
      // proposals. The user invokes them via runNow explicitly. Other
      // terminal statuses (done/failed/aborted/skipped) are skipped
      // via idempotency.
      if (existing.status !== 'interrupted') {
        this._advanceNextRun(due, scheduledForTime);
        this._releaseLock();
        return { ran: 0, reason: 'already-run' };
      }
      if (due.level !== 'A') {
        // B-level interrupted: advance past this slot. The run record
        // stays as 'interrupted' for audit; the next tick will
        // consider the NEXT scheduled run (later scheduledForTime).
        this.log(`B-level interrupted run ${runId} not auto-resuming; user must runNow`);
        this._advanceNextRun(due, scheduledForTime);
        this._releaseLock();
        return { ran: 0, reason: 'interrupted-b-needs-user' };
      }
      // A-level: re-use the existing run record, flip back to 'running'
      // with a new startedAt. The audit trail (status='interrupted' ->
      // 'running') is preserved by NOT deleting the record.
      this._mod("updateJobRun")(this.data, runId, (cur) => ({
        ...cur,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        modelCalls: 0,
        errorCode: '',
        errorText: '',
        retryOf: cur.startedAt,
      }));
    }
    const startedAt = Date.now();
    const run = existing || {
      runId,
      jobId: due.jobId,
      type: due.type,
      level: due.level,
      startedAt,
      finishedAt: null,
      status: 'running',
      modelCalls: 0,
      errorCode: '',
      errorText: '',
      artifacts: null,
    };
    if (!existing) this._mod("addJobRun")(this.data, run);
    try { await this.persist(); } catch (e) { this.log(`persist (pre-run) failed: ${e && e.message || e}`); }
    // Catch-up: 34 §4.5 / §9. Only mark this if we are at-or-after a missed
    // boundary. We allow at most one catch-up per scheduler instance.
    const isCatchUp = !this._catchUpRan && scheduledForTime < (startedAt - this.tickMs);
    if (isCatchUp) {
      this._catchUpRan = true;
      run.catchUpRan = true;
    }
    // Spawn dispatch. The lockfile is released after dispatch
    // completes (P0 production fix: per-tick release per 34 §3.1
    // "single-run tick: always clear"). stop() is a safety net for
    // crash/shutdown; happy-path release happens in the .then.
    this._dispatch(due, run, scheduledForTime)
      .catch((err) => {
        this.log(`dispatch unhandled: ${err && err.message || err}`);
      })
      .finally(() => {
        // v3-audit P0: release the lockfile after every dispatch so
        // other windows can preempt us between ticks. (Without this,
        // the lockfile is held for the lifetime of the scheduler,
        // which over-serializes — the spec only requires per-tick.)
        if (this.lockDir) {
          this._releaseLockfile().catch(() => {});
        }
      });
    return { ran: 1, runId };
    } finally {
      // 39 C3 (P1): single point of release. Replaces the prior
      // scattered calls + the .finally() on dispatch — both of
      // which leaked on early-return / in-process-lock-fail / etc.
      // `_releaseLockfile()` is owner-checked so it is a no-op
      // when the lock was never acquired or was already released.
      releaseLockfileOnce();
    }
  }

  _isWorkspaceActive(target) {
    // 34 §4.7: scheduler consults the injected getter (or, when absent,
    // runs only the unscoped jobs).
    if (!target) return true;
    if (typeof this.getActiveWorkspace !== 'function') return false;
    try {
      const active = this.getActiveWorkspace();
      if (!active) return false;
      return String(active) === String(target);
    } catch {
      return false;
    }
  }

  _findDue() {
    const now = Date.now();
    // Single tick dispatches at most ONE due job (34 §4.5).
    const defs = this.registry.list();
    let best = null;
    for (const d of defs) {
      if (!d.enabled) continue;
      if (d.nextRunAt > now) continue;
      if (!best || d.nextRunAt < best.nextRunAt) best = d;
    }
    return best;
  }

  _advanceNextRun(def, scheduledForTime) {
    const now = Date.now();
    const next = Math.max(scheduledForTime + def.intervalMs, now + def.intervalMs);
    this.registry.update(def.jobId, { nextRunAt: next });
  }

  // ── dispatch (34 §3.4 + §10) ───────────────────────────────────────────

  async _dispatch(def, run, scheduledForTime) {
    this._inflight.add(run.runId);
    const childCtrl = new AbortController();
    // F4 (P2-3): the abort listener is `{ once: true }` so it
    // auto-removes after firing. Also a per-run cleanup removes
    // it on the early-return / finally paths in case the abort
    // never fires (so listeners don't accumulate for the lifetime
    // of the scheduler).
    const onAbort = () => { try { childCtrl.abort(); } catch {} };
    if (this._abortController) {
      this._abortController.signal.addEventListener('abort', onAbort, { once: true });
    }
    this._runControllers.set(run.runId, childCtrl);

    // P0 fix: cleanup is in `finally` so dispatch errors (or unhandled
    // throws from updateJobRun/registry.update) never leak the run from
    // _inflight / _runControllers / the cross-window lock.
    try {
      let out;
      try {
        // F4 (P2-2): PRE-BLOCK when the B-level budget is already
        // exhausted. We refuse to even invoke the runner so the
        // model calls + staging side-effects of the runner are
        // never made. The wrapper's post-run check stays as
        // defence-in-depth (in case a runner somehow reports
        // modelCalls > limit).
        if (def.level === 'B' && def.budgetModelCalls > 0) {
          // F4 (P2-2): PRE-BLOCK when the PREVIOUS run (NOT the
          // current one, which is just-created with status='running')
          // already exhausted its budget. We refuse to invoke the
          // runner so model calls + staging side-effects are
          // never made.
          const prev = this._mod("listJobRuns")(this.data, { jobId: def.jobId })
            .filter((r) => r && r.runId !== run.runId);
          if (prev.length > 0) {
            const last = prev[prev.length - 1];
            if (last && last.status === 'failed' && last.errorCode === 'BUDGET_EXHAUSTED') {
              // Refuse this run; advance nextRunAt to spread the
              // load out (don't hammer on the same interval).
              this._mod("updateJobRun")(this.data, run.runId, (cur) => ({
                ...cur,
                status: 'failed',
                finishedAt: Date.now(),
                errorCode: 'BUDGET_BLOCKED',
                errorText: 'previous run exhausted budget; not invoking runner',
                modelCalls: 0,
              }));
              this.registry.update(def.jobId, (cur) => ({
                ...cur,
                lastStatus: 'failed',
                lastError: { code: 'BUDGET_BLOCKED', text: 'previous run exhausted budget' },
                runCount: Number(cur.runCount || 0) + 1,
                nextRunAt: Math.max(scheduledForTime + cur.intervalMs, Date.now() + cur.intervalMs),
              }));
              try { await this.persist(); } catch {}
              this._runControllers.delete(run.runId);
              this._inflight.delete(run.runId);
              this._releaseLock();
              return;
            }
          }
        }
        const runner = this.runners[def.type];
        if (typeof runner !== 'function') {
          out = { status: 'failed', errorCode: 'RUNNER_NOT_FOUND', errorText: 'no runner for ' + def.type };
        } else {
          // 34 §3.5: budget enforcement at the wrapper, not the runner.
          const wrapped = this._wrapWithBudget(runner, def);
          out = await wrapped({
            job: def,
            run,
            abortSignal: childCtrl.signal,
            state: this.state,
          });
          // Normalize runner output.
          if (!out || typeof out !== 'object') {
            out = { status: 'failed', errorCode: 'RUNNER_INVALID_OUTPUT', errorText: 'runner returned non-object' };
          }
        }
      } catch (err) {
        if (childCtrl.signal.aborted) {
          out = { status: 'aborted', errorCode: 'ABORTED', errorText: '' };
        } else {
          out = { status: 'failed', errorCode: err && err.name || 'RUNNER_THREW', errorText: err && err.message || String(err) };
        }
      }

      // 34 §3.4 step 3: persist terminal status.
      if (childCtrl.signal.aborted && out.status !== 'aborted') {
        out.status = 'aborted';
        out.errorCode = out.errorCode || 'ABORTED';
      }
      if (out.status !== 'aborted' && out.status !== 'done' && out.status !== 'failed' && out.status !== 'skipped') {
        out.status = 'failed';
        out.errorCode = out.errorCode || 'RUNNER_INVALID_STATUS';
      }
      out.errorText = redactErrorText(out.errorText || '');
      const finishedAt = Date.now();
      this._mod("updateJobRun")(this.data, run.runId, (cur) => ({
        ...cur,
        status: out.status,
        finishedAt,
        modelCalls: Number(out.modelCalls) || 0,
        errorCode: out.errorCode || '',
        errorText: out.errorText || '',
        artifacts: out.artifacts || cur.artifacts || null,
      }));
      this.registry.update(def.jobId, (cur) => ({
        ...cur,
        lastRunAt: finishedAt,
        lastStatus: out.status,
        lastError: out.errorCode ? { code: out.errorCode, text: out.errorText } : null,
        runCount: Number(cur.runCount || 0) + 1,
        nextRunAt: Math.max(scheduledForTime + cur.intervalMs, finishedAt + cur.intervalMs),
      }));

      // 34 §4.8: degradation — 3 consecutive failed A-level -> auto disable.
      if (out.status === 'failed' && def.level === 'A') {
        this._maybeAutoDisable(def, out);
      }
      // 34 §4.8: 24h error-code dedupe notification.
      if (out.status === 'failed' || out.status === 'aborted') {
        this._maybeNotify(def, out);
      }
      try { await this.persist(); } catch (e) { this.log(`persist (post-run) failed: ${e && e.message || e}`); }
    } finally {
      this._runControllers.delete(run.runId);
      this._inflight.delete(run.runId);
      // F4 (P2-3): remove the per-run abort listener explicitly.
      // `{ once: true }` already auto-removes on fire; this is the
      // backstop for the case where abort never fires.
      if (this._abortController) {
        try { this._abortController.signal.removeEventListener('abort', onAbort); } catch {}
      }
      // 34 §3.1 step 3c: clear lock if we still own it AND we are not part
      // of a multi-run batch. (single-run tick: always clear.)
      this._releaseLock();
    }
  }

  _wrapWithBudget(runner, def) {
    if (def.level !== 'B' || !(def.budgetModelCalls > 0)) return runner;
    const limit = Number(def.budgetModelCalls) || 0;
    let used = 0;
    const budget = {
      limit,
      get modelCalls() { return used; },
      remaining() { return Math.max(0, limit - used); },
      charge() { used += 1; },
    };
    return async (args) => {
      const result = await runner({ ...args, budget });
      const reported = Number(result && result.modelCalls) || 0;
      if (reported > limit || budget.remaining() < 0) {
        return {
          status: 'failed',
          errorCode: 'BUDGET_EXHAUSTED',
          errorText: 'model calls ' + reported + ' > limit ' + limit,
          modelCalls: Math.min(reported, limit),
        };
      }
      return result;
    };
  }

  _maybeAutoDisable(def, out) {
    // F3 (P2-1): take the last 3 runs of ANY status, sorted by
    // startedAt. Only auto-disable when ALL 3 are 'failed' — a
    // successful run in between breaks the streak. (The previous
    // implementation filtered to only `status === 'failed'`, which
    // would disable on F,F,S,F because the failed filter still
    // returned 3 entries.)
    const allRuns = this._mod("listJobRuns")(this.data, { jobId: def.jobId });
    allRuns.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
    const last3 = allRuns.slice(0, 3);
    if (last3.length === 3 && last3.every((r) => r && r.status === 'failed')) {
      this.registry.update(def.jobId, { enabled: false });
      this._notifyOnce('autodisable:' + def.jobId, 'error',
        'Job auto-disabled',
        `${def.jobId} disabled after 3 consecutive failures (last: ${out.errorCode})`);
    }
  }

  _maybeNotify(def, out) {
    const dayKey = Math.floor(Date.now() / 86400000);
    const notifKey = def.jobId + ':' + (out.errorCode || 'unknown') + ':' + dayKey;
    this._notifyOnce(notifKey, 'warn',
      'Job failed: ' + def.jobId,
      out.errorCode + (out.errorText ? ' — ' + out.errorText.slice(0, 100) : ''));
  }

  _notifyOnce(key, level, title, body) {
    if (this._notifiedKeys.has(key)) return;
    // P2 fix: bound the dedupe set. When the cap is hit, drop the oldest
    // ~half (Sets preserve insertion order in JS). This keeps the set
    // bounded at the cost of "forgetting" the oldest dedupe keys, which
    // is acceptable — the next failure of an evicted key just re-fires
    // the notification (1 extra notification per eviction cycle, not a
    // correctness issue).
    if (this._notifiedKeys.size >= this._notifiedKeysMax) {
      const drop = Math.floor(this._notifiedKeysMax / 2);
      const it = this._notifiedKeys.values();
      for (let i = 0; i < drop; i++) {
        const v = it.next();
        if (v.done) break;
        this._notifiedKeys.delete(v.value);
      }
    }
    this._notifiedKeys.add(key);
    try { Promise.resolve(this.notify(level, title, body)).catch(() => {}); } catch {}
  }

  // ── manual runNow / abortJob (34 §1.4) ─────────────────────────────────

  /**
   * Run a job immediately, regardless of schedule. Respects the
   * cross-window lock (P1 fix): if another owner holds the lock, returns
   * LOCK_NOT_ACQUIRED. The lock is released when the dispatch finishes.
   * Returns a promise that resolves with the run summary (post-completion).
   */
  async runNow(jobId) {
    const def = this.registry.get(jobId);
    if (!def) return { ok: false, code: 'JOBID_NOT_FOUND' };
    if (this.isDegraded && this.isDegraded()) {
      return { ok: false, code: 'DEGRADED' };
    }
    if (def.scopeWorkspace && !this._isWorkspaceActive(def.scopeWorkspace)) {
      return { ok: false, code: 'WRONG_WORKSPACE', expected: def.scopeWorkspace };
    }
    // F2 (P1-3): cross-window lockfile FIRST.
    // 39 C3 (P1): every "acquired lockfile" path goes through a
    // single try/finally so the lockfile is always released. The
    // owner-check inside `_releaseLockfile()` makes it a no-op when
    // we never owned it (already-released / different owner).
    let runNowLfAcquired = false;
    const releaseLfOnce = () => {
      if (runNowLfAcquired) return;
      runNowLfAcquired = true;
      if (this.lockDir) this._releaseLockfile().catch(() => {});
    };
    try {
      if (this.lockDir) {
        const lfLock = await this._acquireLockfile();
        if (!lfLock.ok) return { ok: false, code: 'LOCK_NOT_ACQUIRED' };
      }
      // In-process mirror (also catches single-process concurrency).
      const lock = this._acquireLock();
      if (!lock.ok) return { ok: false, code: 'LOCK_NOT_ACQUIRED' };
      const scheduledForTime = Date.now();
      const runId = JobRegistry.runIdFor(jobId, scheduledForTime);
      if (this._mod("findJobRun")(this.data, runId)) {
        this._releaseLock();
        return { ok: false, code: 'ALREADY_RUNNING', runId };
      }
      const startedAt = Date.now();
      const run = {
        runId, jobId, type: def.type, level: def.level, startedAt, finishedAt: null,
        status: 'running', modelCalls: 0, errorCode: '', errorText: '', artifacts: null, source: 'runNow',
      };
      this._mod("addJobRun")(this.data, run);
      try { await this.persist(); } catch {}
      return await new Promise((resolve) => {
        this._inflight.add(runId);
        const childCtrl = new AbortController();
        this._runControllers.set(runId, childCtrl);
        this._dispatch(def, run, scheduledForTime)
          .catch(() => {})
          .finally(() => resolve({ ok: true, runId }));
      });
    } finally {
      // 39 C3: single point of release. `_releaseLockfile` is
      // owner-checked; the in-process mirror is released by
      // `_dispatch`'s own finally. The finally here guarantees the
      // lockfile is released on every early return path.
      releaseLfOnce();
    }
  }

  abortJob(jobId) {
    // 34 §4.7: abort in-flight runs of this job; deletion propagation calls
    // this BEFORE registry.remove() so no new tick dispatches it.
    let aborted = 0;
    for (const r of this._runControllers.entries()) {
      if (r[0].startsWith(jobId + ':')) {
        try { r[1].abort(); aborted += 1; } catch {}
      }
    }
    return { aborted };
  }

  // 34 §4.6: getter for tests; the list of in-flight run ids.
  inflightRunIds() {
    return Array.from(this._inflight);
  }
}

module.exports = { Scheduler, SchedulerError, FORBIDDEN_FALLBACK_LEVEL };
