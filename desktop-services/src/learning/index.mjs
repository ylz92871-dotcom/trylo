// Trylo Desktop Services — learning domain composition root (Phase 3).
// See migration spec §7.
//
// Wires the vendored Hermes modules to the Service Host method surface. This
// file is lifecycle wiring only: it resolves paths, constructs the adapters
// and exposes one handler per `learning.*` / `session.*` method. No Hermes
// policy, allowlist or schema lives here (arch §2.3).
//
// Ownership: Desktop is the state authority for conversations; Hermes owns
// its own files under <app-data>/Trylo/hermes-capabilities/v1 and the learning
// orchestration state under <app-data>/Trylo/learning/state-v1.json.
//
// Failure policy: read-only queries degrade to `{ ok:false, error }`. Write
// paths (pending apply/rollback) are fail-closed — see pending-admin-service.

import { configureHermesEnv } from './hermes-env.mjs';
import { createMcpArgsService } from './mcp-args-service.mjs';
import { createSessionSyncService } from './session-sync-service.mjs';
import { createHealthService } from './health-service.mjs';
import { createFileMemento } from './file-memento.mjs';
import { legacyVendorUrl, requireLegacyVendor } from './vendor-path.mjs';
import { createSkillsClient } from './skills-client.mjs';
import { createPendingAdminService } from './pending-admin-service.mjs';
import { createShadowRunner } from './shadow-runner.mjs';
import { createLearningLoopService } from './learning-loop-service.mjs';
import { createLegacyImportService } from './legacy-import.mjs';
import { createCurationService } from './curation-service.mjs';
import { createHistoryMiningService } from './history-mining-service.mjs';
import { createJobsService } from './jobs-service.mjs';
import { copyTemplateUnderOut } from './template-copy.mjs';

/** Resolve the Hermes skills root from the storage root (spec §7.2). */
function pathJoinSkillRoot(root) {
  // {storageRoot}/hermes-capabilities/v1 — the same home getHermesHome() uses.
  const { getHermesHome } = requireLegacyVendor('hermes-capability-manager.js');
  return getHermesHome(root);
}

/**
 * @param {{ appDataDir?: string, sidecarsDir?: string,
 *            log?: (m: string) => void, seam?: object }} [options]
 *   Defaults to the Service Host env (spec §5.5). Tests pass explicit dirs.
 *   `seam` is a test-only injection point for the vendored modules
 *   (`{ manager, admin }`) so the method surface can be exercised without
 *   spawning Python.
 */
export function createLearningServices(options = {}) {
  const env = configureHermesEnv({
    appDataDir: options.appDataDir,
    sidecarsDir: options.sidecarsDir,
  });
  const log = options.log ?? null;
  const root = env.storageRoot;
  const hermesHome = root ? pathJoinSkillRoot(root) : '';

  const seam = options.seam ?? {};
  const mcpArgs = createMcpArgsService({ storageRoot: root, manager: seam.manager ?? null });
  const sessionSync = createSessionSyncService({ storageRoot: root, log, sync: seam.sync ?? null });
  const health = createHealthService({
    storageRoot: root,
    serverScript: env.serverScript,
    ...(seam.resolvers ? { resolvers: seam.resolvers, capabilities: seam.capabilities } : {}),
  });
  const memento = createFileMemento({ storageRoot: root, log });
  const skills = createSkillsClient({ storageRoot: root, capabilitiesDir: env.capabilitiesDir });
  const pending = createPendingAdminService({ storageRoot: root, admin: seam.admin ?? null });
  // 3C: the shadow runner spawns the CLI with the learning MCP profile; the
  // learning loop owns every trigger decision.
  const shadow = createShadowRunner({
    mcpArgs: mcpArgs,
    log,
    ...(seam.shadow ? { spawn: seam.shadow } : {}),
  });
  const legacyImport = createLegacyImportService({ storageRoot: root, log });
  const loop = createLearningLoopService({
    storageRoot: root,
    memento,
    shadow,
    log,
    ...(seam.orchestrator ? { orchestrator: seam.orchestrator } : {}),
  });
  const curation = createCurationService({
    storageRoot: root,
    capabilitiesDir: env.capabilitiesDir,
    memento,
    log,
    ...(seam.curationAdapter ? { runAdapter: seam.curationAdapter } : {}),
  });
  const historyMining = createHistoryMiningService({
    storageRoot: root,
    memento,
    shadow,
    pending,
    log,
    ...(seam.historyMiningModules ? { modules: seam.historyMiningModules } : {}),
  });
  const jobs = createJobsService({
    storageRoot: root,
    memento,
    sessionSync,
    pending,
    curation,
    historyMining,
    health,
    log,
    ...(seam.jobsModules ? { modules: seam.jobsModules } : {}),
  });

  return {
    env,
    memento,

    // ── 3A read-only ────────────────────────────────────────────────
    async healthCheck() {
      return health.health();
    },

    async mcpArgsFor(params = {}) {
      return mcpArgs.mcpArgs(params);
    },

    async memorySnapshot() {
      if (!root) return { ok: false, error: 'hermes storage root is not configured' };
      // Lazy import: the vendored client resolves its Python path at load,
      // and must resolve against the REAL vendor dir (src/learning/vendor-path.mjs).
      const { fetchMemorySnapshot } = await import(legacyVendorUrl('memory-context-client.js'));
      return fetchMemorySnapshot({ globalStoragePath: root });
    },

    async skillsQuery(params = {}) {
      const op = String(params.op || 'list');
      if (op === 'list') return skills.list();
      if (op === 'view') return skills.view(params.name);
      return { ok: false, error: `unsupported skills op '${op}'` };
    },

    // ── session mirror (spec §7.4) ──────────────────────────────────
    async sessionSync(params = {}) {
      jobs.rememberSession(params.session);
      return sessionSync.syncSession(params.session);
    },

    async sessionRebuild(params = {}) {
      jobs.rememberSessions(params.sessions);
      return sessionSync.rebuild(params.sessions);
    },

    async sessionFlush() {
      return sessionSync.shutdown();
    },

    // ── 3B staged write ─────────────────────────────────────────────
    async pendingList() {
      return pending.list();
    },
    async pendingDetail(params = {}) {
      return pending.detail(params);
    },
    async pendingApply(params = {}) {
      return pending.apply(params);
    },
    async pendingDiscard(params = {}) {
      return pending.discard(params);
    },
    async pendingBackupList() {
      return pending.listBackups();
    },
    async pendingRollback(params = {}) {
      return pending.rollback(params);
    },
    async pendingProposeSkill(params = {}) {
      return pending.proposeSkill(params);
    },

    // ── PR-6 template copy (spec §2.8 / §5) ─────────────────────────
    async copyTemplateUnderOut(params = {}) {
      return copyTemplateUnderOut({ ...params, hermesHome });
    },

    // ── 3C learning loop (spec §7.6) ────────────────────────────────
    async reviewImplicit(params = {}) {
      return loop.reviewImplicit(params);
    },
    async learnExplicit(params = {}) {
      return loop.learnExplicit(params);
    },
    async runStatus(params = {}) {
      return loop.runStatus(params);
    },
    async historySearch(params = {}) {
      return loop.historySearch(params);
    },

    // ── upstream journey / L4 / L5 / L6 completion ────────────────
    async graphSummary(params = {}) {
      return curation.graphSummary(params);
    },
    async qualityScan(params = {}) {
      return curation.qualityScan(params);
    },
    async historyMine(params = {}) {
      return historyMining.run(params);
    },
    async jobsManage(params = {}) {
      return jobs.manage(params);
    },
    async startMaintenance() {
      return jobs.start();
    },
    async stopMaintenance() {
      return jobs.stop();
    },

    // ── legacy data import (spec §7.5) ──────────────────────────────
    async importLegacyPlan(params = {}) {
      return legacyImport.plan(params);
    },
    async importLegacyCommit(params = {}) {
      return legacyImport.commit(params);
    },
  };
}
