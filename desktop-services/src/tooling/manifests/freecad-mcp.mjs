// Trylo Desktop Services — FreeCAD MCP tool package manifest (pinned).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §6.2 (pinned-pypi-env, wheels mode).
// Static data only — see manifests/officecli.mjs for the invariants.
//
// Explicit-computer activation ONLY: enters runs solely via work.cad.v1.
//
// PR pinned surface (verified 2026-09-04):
//   - upstream neka-nat/freecad-mcp @ 0ff3dd380f0deb13677aff4d9a0c94fae326c
//     44a (2026-08-27, includes the parts-library path-traversal fix PR
//     #122) — the PyPI 0.1.22 wheel was verified code-identical to that
//     commit; the wheel sha256 below + the 40-wheel closure in
//     ./wheels/freecad-mcp.wheels.mjs are the trust boundary;
//   - a real stdio initialize + tools/list smoke of the pinned wheel
//     returned EXACTLY the 15 tool names below;
//   - no telemetry, no non-loopback network anywhere in server or addon.
//   - `execute_code` / `execute_code_async` are arbitrary Python execution
//     inside FreeCAD by design — classified destructive (always prompts).
//
// Connection model: XML-RPC to the FreeCAD addon on 127.0.0.1:9875 (port
// hardcoded upstream on both ends). The addon must be copied into
// %APPDATA%\FreeCAD\Mod\ and its RPC Server started — the installCondition
// below degrades the package to condition-missing until it answers.

import { FREECAD_MCP_WHEELS, FREECAD_MCP_STATE_DIGEST } from './wheels/freecad-mcp.wheels.mjs';

export const FREECAD_MCP_ALLOWED_TOOLS = Object.freeze([
  'create_document',
  'create_object',
  'edit_object',
  'delete_object',
  'execute_code_async',
  'execute_code',
  'get_view',
  'insert_part_from_library',
  'get_objects',
  'get_object',
  'get_parts_list',
  'reload_document',
  'list_documents',
  'get_rpc_status',
  'run_fem_analysis',
]);

export const FREECAD_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'freecad-mcp',
  displayName: 'FreeCAD 自动化',
  version: '0.1.22',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/neka-nat/freecad-mcp',
    license: 'MIT',
    releaseUrl: 'https://pypi.org/project/freecad-mcp/0.1.22/',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    installStrategy: 'pinned-pypi-env',
    archiveSha256: FREECAD_MCP_STATE_DIGEST,
    pythonVersion: '3.12',
    pythonPackage: 'freecad-mcp',
    wheels: FREECAD_MCP_WHEELS,
    executableRelativePath: '.venv/Scripts/freecad-mcp.exe',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-freecad',
    transport: 'stdio',
    args: Object.freeze([]),
    env: Object.freeze({}),
    // EXACT tool set of the pinned wheel, from a real stdio tools/list smoke
    // (2026-09-04). A drift is degraded, never silently accepted.
    expectedTools: FREECAD_MCP_ALLOWED_TOOLS,
  }),

  installCondition: Object.freeze({
    kind: 'app-bridge',
    label: 'FreeCAD',
    roots: Object.freeze(['${ProgramFiles}', '${LOCALAPPDATA}\\Programs']),
    markers: Object.freeze(['FreeCAD*/bin/FreeCAD.exe']),
    bridge: Object.freeze({ host: '127.0.0.1', from: 9875, to: 9875 }),
    remediation:
      '已检测到 FreeCAD 但其 MCP 插件 RPC 未运行：请将插件（freecad-mcp 仓库 addon/FreeCADMCP/）复制到 %APPDATA%\\FreeCAD\\Mod\\ 并重启 FreeCAD，在「MCP Addon」工作台点击 Start RPC Server。',
  }),

  activation: 'explicit-computer',
  classifierId: 'freecad-mcp',
  healthCheck: 'python-metadata',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default FREECAD_MCP_MANIFEST;
