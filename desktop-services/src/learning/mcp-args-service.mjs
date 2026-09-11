// Trylo Desktop Services — MCP profile args for the Trylo CLI. See migration
// spec §7.2 / architecture doc §6.3.
//
// Thin adapter over the vendored `hermes-capability-manager.js`. The three
// allowed-tools allowlists stay authoritative in the legacy manager — Desktop
// must never hand-write a second copy (spec §7.2: 禁止手写第二份).
//
// Ownership: this module decides WHICH profile a run needs; the legacy manager
// decides WHAT that profile means.
//
// Failure policy: never throws. `ok:false` carries the legacy `warning`, which
// is the documented degrade signal — the main Code/Work run continues without
// Hermes MCP (spec §7.3), while learning/history runners must fail closed.

import { requireLegacyVendor } from './vendor-path.mjs';

export const MCP_PROFILES = ['normal', 'learning', 'history'];

/**
 * @param {{ storageRoot: string, manager?: object|null }} options
 *   `storageRoot` is `<app-data>/Trylo`; the manager derives HERMES_HOME as
 *   `<storageRoot>/hermes-capabilities/v1` (spec §7.2).
 *   `manager` is a test seam only — production uses the vendored module.
 */
export function createMcpArgsService({ storageRoot, manager: injectedManager = null } = {}) {
  // Lazy require: the vendored module resolves its Python path at load time,
  // so it must not be required before configureHermesEnv() has run.
  let manager = injectedManager;
  function legacy() {
    if (!manager) {
      manager = requireLegacyVendor('hermes-capability-manager.js');
    }
    return manager;
  }

  const builders = {
    normal: (root) => legacy().tryGetMcpConfigArg(root),
    learning: (root) => legacy().tryGetLearningMcpConfigArg(root),
    history: (root) => legacy().tryGetHistoryMcpConfigArg(root),
  };

  return {
    /**
     * @param {{ profile?: 'normal'|'learning'|'history' }} [params]
     * @returns {{ ok: boolean, profile: string, arg: string[], warning: string|null,
     *             allowedTools?: string[], configPath?: string|null,
     *             hermesHome?: string|null }}
     */
    mcpArgs(params = {}) {
      const profile = String(params.profile || 'normal');
      const build = builders[profile];
      if (!build) {
        return {
          ok: false,
          profile,
          arg: [],
          warning: `unknown hermes mcp profile '${profile}'`,
          allowedTools: [],
          configPath: null,
          hermesHome: null,
        };
      }
      if (!storageRoot) {
        return {
          ok: false,
          profile,
          arg: [],
          warning: 'hermes storage root is not configured',
          allowedTools: [],
          configPath: null,
          hermesHome: null,
        };
      }
      const built = build(storageRoot);
      return {
        ok: Boolean(built.ok),
        profile,
        arg: Array.isArray(built.arg) ? built.arg.slice() : [],
        warning: built.warning ?? null,
        allowedTools: built.allowedTools ? built.allowedTools.slice() : undefined,
        configPath: built.configPath ?? null,
        hermesHome: built.hermesHome ?? null,
      };
    },
  };
}
