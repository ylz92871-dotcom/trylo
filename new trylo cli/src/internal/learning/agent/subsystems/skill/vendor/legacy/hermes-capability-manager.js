'use strict';

/*
 * hermes-capability-manager.js
 *
 * Node-side lifecycle for the trylo-hermes-capabilities MCP server. The
 * extension calls into this to:
 *   - resolve the Hermes 0.19.0 Python interpreter,
 *   - own the Trylo-managed HERMES_HOME data directory + config.yaml,
 *   - generate the ``--mcp-config`` JSON the bundled Claude CLI consumes,
 *   - degrade gracefully (return no arg + a warning) when Hermes is absent,
 *     so the original agent keeps working without these capabilities.
 *
 * It is VS Code agnostic: callers pass the globalStorage path as a string so
 * the module is unit-testable in plain Node. No Hermes behaviour is
 * reimplemented here - this is path/process/config plumbing only.
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveHermesPython } = require('./hermes-python-resolver');

const DATA_DIR_NAME = 'hermes-capabilities';
const DATA_VERSION = 'v1';
const MCP_CONFIG_NAME = 'mcp-config.json';
const SERVER_NAME = 'trylo-hermes-capabilities'; // 11 §3 A1: normal-profile server name
// PATCH 1 (see desktop-services/vendor/PATCHES.md): the Python sources live in
// desktop/sidecars/hermes-capabilities/, not next to this vendored JS file.
const SERVER_SCRIPT = process.env.TRYLO_HERMES_SERVER_SCRIPT
  || path.join(__dirname, 'hermes-capabilities', 'server.py');

// config.yaml content. write_approval MUST be on for both subsystems so that
// every memory/skill mutation stages to the pending store instead of writing
// directly (HERMES_FUSION_ARCHITECTURE.md section 6.3 / 10). Trylo owns this
// file; Hermes reads it.
const CONFIG_YAML = [
  'memory:',
  '  write_approval: true',
  'skills:',
  '  write_approval: true',
  '',
].join('\n');

function getDataRoot(globalStoragePath) {
  return path.join(globalStoragePath, DATA_DIR_NAME);
}

function getHermesHome(globalStoragePath) {
  return path.join(getDataRoot(globalStoragePath), DATA_VERSION);
}

function getServerScriptPath() {
  return SERVER_SCRIPT;
}

/**
 * Ensure the Trylo-managed HERMES_HOME exists and has the required config.yaml.
 * Idempotent: writes config.yaml only when absent, never overwrites a user
 * edit. Returns the HERMES_HOME path.
 */
function ensureDataDir(globalStoragePath) {
  const home = getHermesHome(globalStoragePath);
  fs.mkdirSync(home, { recursive: true });
  const configYaml = path.join(home, 'config.yaml');
  if (!fs.existsSync(configYaml)) {
    fs.writeFileSync(configYaml, CONFIG_YAML, 'utf8');
  }
  return home;
}

/**
 * Build the MCP config file the bundled Claude CLI consumes via --mcp-config.
 * Returns { ok: true, configPath, hermesHome, pythonExe }. Throws if the
 * Hermes interpreter cannot be located - callers should catch and degrade.
 */
function buildMcpConfig(globalStoragePath) {
  const pythonExe = resolveHermesPython();
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error(`Hermes MCP server script not found: ${SERVER_SCRIPT}`);
  }
  const hermesHome = ensureDataDir(globalStoragePath);
  const config = {
    mcpServers: {
      'trylo-hermes-capabilities': {
        command: pythonExe,
        args: [SERVER_SCRIPT],
        env: { HERMES_HOME: hermesHome },
      },
    },
  };
  const configPath = path.join(getDataRoot(globalStoragePath), MCP_CONFIG_NAME);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { ok: true, configPath, hermesHome, pythonExe };
}

/**
 * Graceful entry point for the extension. Returns an object with:
 *   - arg: ['--mcp-config', <path>] when Hermes is available, else []
 *   - ok: boolean
 *   - warning: string when Hermes is unavailable (for the trace log)
 *   - hermesHome / pythonExe when available
 *
 * Never throws: a missing Hermes environment degrades to no MCP arg so the
 * original agent run is unaffected.
 */
function tryGetMcpConfigArg(globalStoragePath) {
  try {
    const built = buildMcpConfig(globalStoragePath);
    return {
      ok: true,
      arg: ['--mcp-config', built.configPath],
      configPath: built.configPath,
      hermesHome: built.hermesHome,
      pythonExe: built.pythonExe,
      warning: null,
    };
  } catch (error) {
    return {
      ok: false,
      arg: [],
      configPath: null,
      hermesHome: null,
      pythonExe: null,
      warning: `Hermes capabilities unavailable: ${error.message}`,
    };
  }
}

const LEARNING_MCP_CONFIG_NAME = 'mcp-config-learning.json';
const LEARNING_SERVER_NAME = 'trylo-hermes-learning';
// MCP tool names as the Claude CLI addresses them: mcp__<server>__<tool>.
// 11 §4 B1: four tools exactly - skills_list, skill_view, skill_propose,
// and learning_graph_summary. No Memory, no session_search, no pending.
const LEARNING_ALLOWED_TOOLS = [
  'mcp__trylo-hermes-learning__skills_list',
  'mcp__trylo-hermes-learning__skill_view',
  'mcp__trylo-hermes-learning__skill_propose',
  'mcp__trylo-hermes-learning__learning_graph_summary',
];

/**
 * Build a learning-specific MCP config that only exposes skills_list,
 * skill_view, and skill_propose. The same server.py is reused but with
 * TRYLO_MCP_PROFILE=learning so non-learning tools are not even advertised
 * to the model (runtime isolation, 02_LEARNING_L0_INTEGRATION_REPAIR §7.2).
 *
 * Returns { ok: true, configPath, hermesHome, pythonExe, allowedTools }.
 * Throws if the Hermes interpreter cannot be located.
 */
function buildLearningMcpConfig(globalStoragePath) {
  const pythonExe = resolveHermesPython();
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error(`Hermes MCP server script not found: ${SERVER_SCRIPT}`);
  }
  const hermesHome = ensureDataDir(globalStoragePath);
  const config = {
    mcpServers: {
      'trylo-hermes-learning': {
        command: pythonExe,
        args: [SERVER_SCRIPT],
        env: {
          HERMES_HOME: hermesHome,
          TRYLO_MCP_PROFILE: 'learning',
        },
      },
    },
  };
  const configPath = path.join(getDataRoot(globalStoragePath), LEARNING_MCP_CONFIG_NAME);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { ok: true, configPath, hermesHome, pythonExe, allowedTools: LEARNING_ALLOWED_TOOLS.slice() };
}

/**
 * Graceful entry point for the learning runner. Returns:
 *   - arg: ['--mcp-config', <path>, '--strict-mcp-config', '--allowed-tools', <tools>]
 *   - ok: boolean
 *   - warning: string when Hermes is unavailable
 *
 * --strict-mcp-config ensures user project MCP servers are NOT loaded.
 * --allowed-tools restricts the CLI to only the three learning MCP tools.
 */
function tryGetLearningMcpConfigArg(globalStoragePath) {
  try {
    const built = buildLearningMcpConfig(globalStoragePath);
    return {
      ok: true,
      arg: [
        '--mcp-config', built.configPath,
        '--strict-mcp-config',
        '--allowed-tools', built.allowedTools.join(','),
      ],
      configPath: built.configPath,
      hermesHome: built.hermesHome,
      pythonExe: built.pythonExe,
      allowedTools: built.allowedTools,
      warning: null,
    };
  } catch (error) {
    return {
      ok: false,
      arg: [],
      configPath: null,
      hermesHome: null,
      pythonExe: null,
      allowedTools: [],
      warning: `Hermes learning capabilities unavailable: ${error.message}`,
    };
  }
}

const HISTORY_MCP_CONFIG_NAME = 'mcp-config-history.json';
const HISTORY_SERVER_NAME = 'trylo-hermes-history';
// 24 §3.D2 / 30 §11.4 D2: the L4 HISTORY MCP profile — same five tools as
// learning PLUS `memory_propose` (so the miner can stage Memory/Skill
// proposals). No session_search (retrieval is control-plane), no
// memory_snapshot, no apply/discard/rollback.
const HISTORY_ALLOWED_TOOLS = [
  'mcp__trylo-hermes-history__skills_list',
  'mcp__trylo-hermes-history__skill_view',
  'mcp__trylo-hermes-history__skill_propose',
  'mcp__trylo-hermes-history__memory_propose',
  'mcp__trylo-hermes-history__learning_graph_summary',
];

/**
 * Build a history-specific MCP config that exposes the 5 L4-history tools.
 * Same server.py reused with TRYLO_MCP_PROFILE=history (30 §11.4 D2).
 */
function buildHistoryMcpConfig(globalStoragePath) {
  const pythonExe = resolveHermesPython();
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error(`Hermes MCP server script not found: ${SERVER_SCRIPT}`);
  }
  const hermesHome = ensureDataDir(globalStoragePath);
  const config = {
    mcpServers: {
      'trylo-hermes-history': {
        command: pythonExe,
        args: [SERVER_SCRIPT],
        env: {
          HERMES_HOME: hermesHome,
          TRYLO_MCP_PROFILE: 'history',
        },
      },
    },
  };
  const configPath = path.join(getDataRoot(globalStoragePath), HISTORY_MCP_CONFIG_NAME);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { ok: true, configPath, hermesHome, pythonExe, allowedTools: HISTORY_ALLOWED_TOOLS.slice() };
}

/**
 * Graceful entry point for the history runner. Same shape as the learning
 * variant; returns the --mcp-config / --strict-mcp-config / --allowed-tools
 * arg array, or { ok: false, warning } when Hermes is unavailable.
 */
function tryGetHistoryMcpConfigArg(globalStoragePath) {
  try {
    const built = buildHistoryMcpConfig(globalStoragePath);
    return {
      ok: true,
      arg: [
        '--mcp-config', built.configPath,
        '--strict-mcp-config',
        '--allowed-tools', built.allowedTools.join(','),
      ],
      configPath: built.configPath,
      hermesHome: built.hermesHome,
      pythonExe: built.pythonExe,
      allowedTools: built.allowedTools,
      warning: null,
    };
  } catch (error) {
    return {
      ok: false,
      arg: [],
      configPath: null,
      hermesHome: null,
      pythonExe: null,
      allowedTools: [],
      warning: `Hermes history capabilities unavailable: ${error.message}`,
    };
  }
}

module.exports = {
  DATA_DIR_NAME,
  DATA_VERSION,
  SERVER_NAME,
  getDataRoot,
  getHermesHome,
  getServerScriptPath,
  ensureDataDir,
  buildMcpConfig,
  tryGetMcpConfigArg,
  LEARNING_SERVER_NAME,
  LEARNING_ALLOWED_TOOLS,
  buildLearningMcpConfig,
  tryGetLearningMcpConfigArg,
  HISTORY_SERVER_NAME,
  HISTORY_ALLOWED_TOOLS,
  buildHistoryMcpConfig,
  tryGetHistoryMcpConfigArg,
};
