// Trylo Desktop Services — Hermes health probe (Phase 3A). See migration spec
// §7.5 and architecture doc §6.6.
//
// Answers one question: "can a Hermes-backed run start right now?" It composes
// only the legacy resolvers — no policy of its own:
//   - `hermes-python-resolver.resolveHermesPython()` (HERMES_PYTHON env wins),
//   - `hermes-capability-manager` for HERMES_HOME + the server script.
//
// Failure policy: never throws. `ok:false` always carries a `reason` the UI can
// show verbatim as the install hint (spec §9.1: 缺失时显示安装指引，主功能降级).
// Health is a query, never a mutation: it does not create HERMES_HOME.

import { promises as fs } from 'node:fs';

import { requireLegacyVendor } from './vendor-path.mjs';

const INSTALL_HINT =
  'Install Hermes with `uv tool install hermes-agent==0.19.0`, or set HERMES_PYTHON to an interpreter that has it.';

/**
 * @param {{ storageRoot: string, serverScript?: string,
 *            resolvers?: { resolveHermesPython: () => string }|null,
 *            capabilities?: { getHermesHome: (r: string) => string,
 *                             getServerScriptPath: () => string }|null }} options
 *   `resolvers` / `capabilities` are test seams only.
 */
export function createHealthService({
  storageRoot,
  serverScript = '',
  resolvers: injectedResolvers = null,
  capabilities: injectedCapabilities = null,
} = {}) {
  let resolver = injectedResolvers;
  let manager = injectedCapabilities;
  function legacy() {
    if (!resolver) resolver = requireLegacyVendor('hermes-python-resolver.js');
    if (!manager) manager = requireLegacyVendor('hermes-capability-manager.js');
    return { resolver, manager };
  }

  return {
    async health() {
      if (!storageRoot) {
        return { ok: false, available: false, reason: 'Hermes storage root is not configured' };
      }
      const { resolver: pythonResolver, manager: capabilityManager } = legacy();

      let pythonExe = '';
      try {
        pythonExe = pythonResolver.resolveHermesPython();
      } catch (err) {
        return {
          ok: false,
          available: false,
          storageRoot,
          hermesHome: capabilityManager.getHermesHome(storageRoot),
          reason: err && err.message ? err.message : 'Hermes Python could not be resolved',
          installHint: INSTALL_HINT,
        };
      }

      const script = serverScript || capabilityManager.getServerScriptPath();
      let serverScriptFound = false;
      try {
        const stat = await fs.stat(script);
        serverScriptFound = stat.isFile();
      } catch {
        serverScriptFound = false;
      }

      const hermesHome = capabilityManager.getHermesHome(storageRoot);
      let hermesHomeReady = false;
      try {
        const stat = await fs.stat(hermesHome);
        hermesHomeReady = stat.isDirectory();
      } catch {
        hermesHomeReady = false;
      }

      // config.yaml is written by ensureDataDir on the first MCP build; its
      // absence only means "not initialised yet", not "broken".
      if (!serverScriptFound) {
        return {
          ok: false,
          available: false,
          storageRoot,
          hermesHome,
          pythonExe,
          serverScript: script,
          serverScriptFound: false,
          reason: `Hermes MCP server script not found: ${script}`,
        };
      }

      return {
        ok: true,
        available: true,
        storageRoot,
        hermesHome,
        hermesHomeReady,
        pythonExe,
        serverScript: script,
        serverScriptFound: true,
        reason: null,
      };
    },
  };
}
