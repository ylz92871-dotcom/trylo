// Trylo Desktop Services — L6 maintenance scheduler composition.
//
// Scheduler/registry/runners are reused unchanged from the old plugin. This
// file only supplies Desktop ports (file Memento, session snapshot, Python
// graph adapter, pending backup reader and isolated history runner).

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { requireLegacyVendor } from './vendor-path.mjs';

const TYPE_LEVEL = Object.freeze({
  'index-rebuild': 'A',
  'backup-verify': 'A',
  'graph-refresh': 'A',
  'history-mining': 'B',
  'quality-scan': 'B',
});

function publicJob(def) {
  return {
    jobId: def.jobId,
    type: def.type,
    level: def.level,
    enabled: Boolean(def.enabled),
    intervalMs: def.intervalMs,
    budgetModelCalls: def.budgetModelCalls,
    nextRunAt: def.nextRunAt,
    lastRunAt: def.lastRunAt,
    lastStatus: def.lastStatus,
    lastError: def.lastError ? { code: def.lastError.code } : null,
    runCount: def.runCount,
    scopeWorkspace: def.scopeWorkspace,
  };
}

/**
 * @param {{ storageRoot: string, memento: object, sessionSync: object,
 *           pending: object, curation: object, historyMining: object,
 *           health: object, log?: (message: string) => void,
 *           modules?: object|null }} options
 */
export function createJobsService({
  storageRoot,
  memento,
  sessionSync,
  pending,
  curation,
  historyMining,
  health,
  log = null,
  modules: injectedModules = null,
} = {}) {
  let modules = injectedModules;
  let state = null;
  let registry = null;
  let scheduler = null;
  let starting = null;
  let degraded = false;
  let activeWorkspace = null;
  let sessionSnapshot = [];
  let runContext = {};

  function rememberSession(session) {
    if (!session || !session.id) return;
    const id = String(session.id);
    const index = sessionSnapshot.findIndex((item) => String(item?.id || '') === id);
    if (index >= 0) sessionSnapshot[index] = session;
    else sessionSnapshot.push(session);
  }

  function rememberSessions(sessions) {
    sessionSnapshot = Array.isArray(sessions)
      ? sessions.filter((session) => session && session.id).slice()
      : [];
  }

  function legacy() {
    if (!modules) {
      modules = {
        state: requireLegacyVendor('learning-loop/learning-state.js'),
        JobRegistry: requireLegacyVendor('learning-loop/jobs/registry.js').JobRegistry,
        Scheduler: requireLegacyVendor('learning-loop/jobs/scheduler.js').Scheduler,
        health: requireLegacyVendor('learning-loop/jobs/health.js'),
        runners: {
          'index-rebuild': requireLegacyVendor('learning-loop/jobs/runners/index-rebuild.js'),
          'backup-verify': requireLegacyVendor('learning-loop/jobs/runners/backup-verify.js'),
          'graph-refresh': requireLegacyVendor('learning-loop/jobs/runners/graph-refresh.js'),
          'history-mining': requireLegacyVendor('learning-loop/jobs/runners/history-mining.js'),
          'quality-scan': requireLegacyVendor('learning-loop/jobs/runners/quality-scan.js'),
        },
      };
    }
    return modules;
  }

  function persist() {
    return legacy().state.saveState(memento, state);
  }

  function buildRunners() {
    const runner = legacy().runners;
    return {
      'index-rebuild': (args) => runner['index-rebuild'].run({
        ...args,
        deps: {
          rebuild: async () => {
            const result = await sessionSync.rebuild(sessionSnapshot);
            if (!result?.ok) throw new Error(result?.error || 'session rebuild failed');
            return { rebuiltSessions: sessionSnapshot.length };
          },
        },
      }),
      'backup-verify': (args) => runner['backup-verify'].run({
        ...args,
        deps: {
          verify: async () => {
            const result = await pending.listBackups();
            if (!result?.ok) throw new Error(result?.error || 'backup list failed');
            const backups = result.backups || [];
            return { checked: backups.length, latestOk: backups.length > 0 };
          },
        },
      }),
      'graph-refresh': (args) => runner['graph-refresh'].run({
        ...args,
        deps: {
          refresh: async ({ abortSignal } = {}) => {
            const result = await curation.qualityScan({ signal: abortSignal });
            if (!result?.ok) throw new Error(result?.error || 'graph refresh failed');
            return { signals: result.signals };
          },
        },
      }),
      'history-mining': (args) => runner['history-mining'].run({
        ...args,
        deps: {
          buildOrchestrator: ({ abortSignal, state: runState } = {}) => ({
            runOnce: async () => historyMining.run({
              ...runContext,
              workspaceRoot: activeWorkspace || runContext.workspaceRoot || '',
              signal: abortSignal,
              state: runState,
              persist: false,
            }),
          }),
          workspace: () => ({ label: runContext.workspaceLabel || 'job', path: activeWorkspace || '' }),
          currentTask: () => runContext.currentTask || {},
        },
      }),
      'quality-scan': (args) => runner['quality-scan'].run({
        ...args,
        deps: {
          scan: async ({ abortSignal } = {}) => {
            const result = await curation.qualityScan({ signal: abortSignal });
            if (!result?.ok) throw new Error(result?.error || 'quality scan failed');
            return {
              signals: result.signals,
              pairs: result.candidates.length,
              proposals: 0,
              modelCalls: 0,
            };
          },
        },
      }),
    };
  }

  async function start() {
    if (scheduler) return { ok: true, running: true };
    if (starting) return starting;
    starting = (async () => {
      if (!storageRoot) return { ok: false, running: false, error: 'jobs: storage root is not configured' };
      const mod = legacy();
      state = mod.state.loadState(memento);
      registry = new mod.JobRegistry({ state: mod.state, data: state, logger: log || (() => {}) });
      const lockDir = path.join(storageRoot, 'learning', 'locks');
      mkdirSync(lockDir, { recursive: true });
      scheduler = new mod.Scheduler({
        registry,
        runners: buildRunners(),
        state: mod.state,
        data: state,
        logger: log || (() => {}),
        persist,
        notify: async () => {},
        ownerId: `desktop:${process.pid}:${randomBytes(4).toString('hex')}`,
        tickMs: 30_000,
        settleMs: 2_000,
        lockDir,
        isDegraded: () => degraded,
        getActiveWorkspace: () => activeWorkspace,
      });

      // Learning degradation never blocks Code/Work. It only pauses this
      // scheduler. A timeout/error is represented by health().available=false.
      try {
        const report = await health.health();
        degraded = report?.available !== true;
        mod.health.persistHealth(state, {
          ok: !degraded,
          checks: [{ name: 'hermes', ok: !degraded, errorCode: degraded ? 'HERMES_UNAVAILABLE' : '', hint: '', ts: Date.now() }],
          lastErrorCode: degraded ? 'HERMES_UNAVAILABLE' : '',
        });
        await persist();
      } catch {
        degraded = true;
      }
      scheduler.start();
      if (log) log(`learning jobs scheduler started; degraded=${degraded}`);
      return { ok: true, running: true, degraded };
    })().finally(() => { starting = null; });
    return starting;
  }

  async function ready() {
    const result = await start();
    if (!result.ok || !registry || !scheduler) return result;
    return null;
  }

  return {
    start,
    rememberSession,
    rememberSessions,

    async stop() {
      if (starting) await starting.catch(() => null);
      if (!scheduler) return { ok: true, stopped: true };
      await scheduler.stop();
      scheduler = null;
      registry = null;
      state = null;
      return { ok: true, stopped: true };
    },

    async manage(params = {}) {
      const unavailable = await ready();
      if (unavailable) return unavailable;
      const action = String(params.action || 'list');
      activeWorkspace = params.workspaceRoot ? String(params.workspaceRoot) : activeWorkspace;
      if (Array.isArray(params.sessions)) rememberSessions(params.sessions);
      if (params.cli || params.currentTask || params.workspaceLabel) {
        runContext = {
          cli: params.cli,
          currentTask: params.currentTask,
          workspaceLabel: params.workspaceLabel,
          workspaceRoot: params.workspaceRoot,
          timeoutMs: params.timeoutMs,
        };
      }

      if (action === 'list') {
        return {
          ok: true,
          jobs: registry.list().map(publicJob),
          runs: legacy().state.listJobRuns(state).slice(-100),
          inflightRunIds: scheduler.inflightRunIds(),
          degraded,
        };
      }
      if (action === 'register') {
        const type = String(params.type || '');
        const level = TYPE_LEVEL[type];
        if (!level) return { ok: false, errorCode: 'TYPE_INVALID', error: `unsupported job type '${type}'` };
        try {
          const def = registry.register({
            jobId: String(params.jobId || `job-${type}-${Date.now().toString(36)}`),
            type,
            level,
            enabled: typeof params.enabled === 'boolean' ? params.enabled : level === 'A',
            intervalMs: Number(params.intervalMs) || 5 * 60_000,
            budgetModelCalls: level === 'B' ? Number(params.budgetModelCalls) : 0,
            scopeWorkspace: params.scopeWorkspace ? String(params.scopeWorkspace) : null,
          });
          await persist();
          return { ok: true, job: publicJob(def) };
        } catch (err) {
          return { ok: false, errorCode: err.code || 'REGISTER_FAILED', error: err.message };
        }
      }
      const jobId = String(params.jobId || '');
      if (!jobId) return { ok: false, errorCode: 'JOBID_REQUIRED', error: 'jobId is required' };
      if (action === 'remove') {
        scheduler.abortJob?.(jobId);
        const removed = registry.remove(jobId);
        await persist();
        return { ok: removed, errorCode: removed ? null : 'JOBID_NOT_FOUND' };
      }
      if (action === 'enable' || action === 'disable') {
        const def = registry.get(jobId);
        if (!def) return { ok: false, errorCode: 'JOBID_NOT_FOUND' };
        const enabled = action === 'enable';
        registry.update(jobId, {
          enabled,
          nextRunAt: enabled ? Date.now() + def.intervalMs : def.nextRunAt,
        });
        await persist();
        return { ok: true, job: publicJob(registry.get(jobId)) };
      }
      if (action === 'runNow') {
        if (degraded) return { ok: false, errorCode: 'HERMES_UNAVAILABLE', error: 'learning scheduler is degraded' };
        const result = await scheduler.runNow(jobId);
        return { ok: result?.ok !== false, ...result };
      }
      return { ok: false, errorCode: 'UNKNOWN_ACTION', error: `unknown jobs action '${action}'` };
    },
  };
}

export const JOB_TYPES = Object.keys(TYPE_LEVEL);
