// Trylo Desktop Services — SolidWorks MCP tool package manifest (pinned).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §6.2 (pinned-pypi-env, SOURCE mode).
// Static data only — see manifests/officecli.mjs for the invariants.
//
// Explicit-computer activation ONLY: enters runs solely via work.cad.v1.
//
// PR pinned surface (verified 2026-09-04):
//   - upstream wzyn20051216/solidworks-automation-skill @ c7ba77fe1207b3881d
//     36876c1abf128aa5e13056 (2026-09-02, MIT). NOT published on PyPI/npm
//     and not wheel-buildable (`[tool.uv] package = false`) — hence SOURCE
//     mode: the pinned GitHub tarball + the 44-wheel dependency closure in
//     ./wheels/solidworks-mcp.wheels.mjs (resolved from the upstream
//     pyproject constraints for CPython 3.12 win_amd64);
//   - the server is launched via the venv python on the source entry
//     script; the {installDir} argv token expands to the version directory;
//   - a real stdio initialize + tools/list smoke of the pinned source
//     returned EXACTLY the 45 tool names below (source == live, one
//     spelling note: wire name `solidworks_pack_and_go` for
//     solidworks_pack_and_go_tool). 2026-09-06: the controlled-modeling
//     channel adds 6 `solidworks_modeling_*` / probe_direction_semantics
//     primitives (31 native COM + 6 channel = 51 total pins);
//   - no telemetry; the server makes no network calls.
//   - NEVER run upstream's install.js / register_all_ai_mcp / setup.py —
//     they write into ~/.claude/skills and other clients' configs. The
//     transport never invokes them (no lifecycle hooks are executed).
//
// Destructive surface (classifier flags these): `solidworks_close_documents`
// (close-without-save on the single-doc path), `solidworks_save_document`
// (Save As overwrite), all exporters + pack_and_go (file writes),
// update_dimension / create_configuration (rebuild + save),
// cadstudio_run_fea / run_fea_convergence (allowlisted solver binaries).
// No delete-feature tools exist upstream.
//
// Connection model: solidworks_connect attaches to a RUNNING SolidWorks
// (GetActiveObject) first and starts one when absent — the launch happens
// on TOOL CALL (behind approval), never at server startup. The 14
// cadstudio_* tools are headless (STEP/STL/DXF/DFM/FEA) and work without
// SolidWorks entirely, so this manifest carries NO installCondition: the
// package is genuinely usable on machines without SolidWorks, and COM
// tools fail with honest per-call errors. PYTHONUTF8=1 mirrors upstream.

import { SOLIDWORKS_MCP_WHEELS } from './wheels/solidworks-mcp.wheels.mjs';

export const SOLIDWORKS_MCP_ALLOWED_TOOLS = Object.freeze([
  // cadstudio_* — headless, no SolidWorks required (14)
  'cadstudio_resolve_backend',
  'cadstudio_write_open_format',
  'cadstudio_build_dxf_preview_scene',
  'cadstudio_check_dfm',
  'cadstudio_check_routing',
  'cadstudio_routing_preflight',
  'solidworks_addin_host_status',
  'cadstudio_fea_preflight',
  'cadstudio_prepare_fea',
  'cadstudio_run_fea',
  'cadstudio_run_fea_convergence',
  'cadstudio_review_advanced_geometry',
  'cadstudio_create_ocp_loft',
  'cadstudio_create_ocp_surface',
  // solidworks_* — native COM (31)
  'solidworks_connect',
  'solidworks_health_check',
  'solidworks_new_document',
  'solidworks_create_basic_part',
  'solidworks_open_document',
  'solidworks_add_component',
  'solidworks_set_component_fixed',
  'solidworks_save_document',
  'solidworks_close_documents',
  'solidworks_add_coincident_mate',
  'solidworks_add_distance_mate',
  'solidworks_add_concentric_mate',
  'solidworks_set_appearance',
  'solidworks_export_active',
  'solidworks_inspect_configurations',
  'solidworks_create_configuration',
  'solidworks_activate_configuration',
  'solidworks_update_dimension',
  'solidworks_set_custom_properties',
  'solidworks_batch_export_files',
  'solidworks_export_assembly_bom',
  'solidworks_pack_and_go',
  'solidworks_review_active',
  'solidworks_generate_drawing',
  'solidworks_review_drawing',
  'solidworks_inspect_drawing',
  'solidworks_create_hole_feature',
  'solidworks_inspect_hole_features',
  'solidworks_add_rotary_motor',
  'solidworks_inspect_motion_studies',
  'solidworks_validate_motion_study',
  // Controlled modeling channel (2026-09-06): stateful mm-world
  // modeling primitives over the verified sw_part surface.
  'solidworks_modeling_begin',
  'solidworks_modeling_sketch',
  'solidworks_modeling_feature',
  'solidworks_modeling_measure',
  'solidworks_modeling_commit',
  'solidworks_probe_direction_semantics',
]);

export const SOLIDWORKS_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'solidworks-mcp',
  displayName: 'SolidWorks 自动化',
  version: '1.3.0',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/wzyn20051216/solidworks-automation-skill',
    license: 'MIT',
    releaseUrl: 'https://github.com/wzyn20051216/solidworks-automation-skill/archive/c7ba77fe1207b3881d36876c1abf128aa5e13056.tar.gz',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    installStrategy: 'pinned-pypi-env',
    // SOURCE mode: the source tarball digest is the state digest resolve()
    // vouches installs by; the venv is built from the pinned wheel closure.
    archiveSha256: '983ef0245da64551e97d74089cd22546ad4d547a5c31e8d060300519ff300c1e',
    pythonVersion: '3.12',
    sourceTarballUrl:
      'https://github.com/wzyn20051216/solidworks-automation-skill/archive/c7ba77fe1207b3881d36876c1abf128aa5e13056.tar.gz',
    sourceTarballSha256: '983ef0245da64551e97d74089cd22546ad4d547a5c31e8d060300519ff300c1e',
    sourceCommit: 'c7ba77fe1207b3881d36876c1abf128aa5e13056',
    sourceEntry: 'mcp-server/server.py',
    wheels: SOLIDWORKS_MCP_WHEELS,
    executableRelativePath: '.venv/Scripts/python.exe',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-solidworks',
    transport: 'stdio',
    // The source entry script; {installDir} expands to the version directory.
    args: Object.freeze(['{installDir}/mcp-server/server.py']),
    env: Object.freeze({
      PYTHONUTF8: '1',
    }),
    // EXACT tool set of the pinned source + the 5 controlled-modeling
    // channel tools added 2026-09-06 (stateful mm-world modeling over the
    // verified sw_part surface). From a real stdio tools/list smoke.
    // Drift is degraded, never silently accepted.
    expectedTools: SOLIDWORKS_MCP_ALLOWED_TOOLS,
  }),

  activation: 'explicit-computer',
  classifierId: 'solidworks-mcp',
  healthCheck: 'source-entry',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default SOLIDWORKS_MCP_MANIFEST;
