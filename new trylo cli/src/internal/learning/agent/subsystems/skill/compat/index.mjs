// Preserve the existing Hermes peripheral contracts inside the skill subsystem.
// The copied adapters own their original validation, envelopes and approval
// semantics; this composition adds only local wiring for the Node worker.
import path from 'node:path';
import { createSkillsClient } from './skills-client.mjs';
import { createPendingAdminService } from './pending-admin-service.mjs';

export { createFileMemento } from './file-memento.mjs';

// The legacy CJS helpers capture these paths on their first require. Each
// worker configures one capabilities installation before loading those helpers,
// just as the existing peripheral composition did in configureHermesEnv().
function configureCapabilities(capabilitiesDir, environment = process.env) {
  if (!capabilitiesDir) return;
  environment.TRYLO_HERMES_CAPABILITIES_DIR = capabilitiesDir;
  environment.TRYLO_HERMES_SERVER_SCRIPT = path.join(capabilitiesDir, 'server.py');
}

export function createHermesSkillCompatibility(options = {}) {
  configureCapabilities(options.capabilitiesDir);
  // Python's native file operations need Windows extended paths for deep homes.
  // This preserves the same directory and the original pending approval owner.
  const nativeOptions = typeof options.storageRoot === 'string' && path.isAbsolute(options.storageRoot)
    ? { ...options, storageRoot: path.toNamespacedPath(options.storageRoot) } : options;
  const skills = createSkillsClient(nativeOptions);
  const pending = createPendingAdminService(nativeOptions);
  return {
    async skillsQuery(params = {}) {
      const op = String(params.op || 'list');
      if (op === 'list') return skills.list();
      if (op === 'view') return skills.view(params.name);
      return { ok: false, error: `unsupported skills op '${op}'` };
    },
    list: skills.list,
    view: skills.view,
    pendingProposeSkill: (params = {}) => pending.proposeSkill(params),
    pendingList: () => pending.list(),
    pendingDetail: (params = {}) => pending.detail(params),
    pendingApply: (params = {}) => pending.apply(params),
    pendingDiscard: (params = {}) => pending.discard(params),
    pendingBackupList: () => pending.listBackups(),
    pendingRollback: (params = {}) => pending.rollback(params),
  };
}
