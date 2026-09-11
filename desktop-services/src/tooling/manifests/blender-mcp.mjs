// Trylo Desktop Services — Blender MCP tool package manifest (pinned).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §6.2 (pinned-pypi-env, wheels mode).
// Static data only — see manifests/officecli.mjs for the invariants.
//
// Explicit-computer activation ONLY: this package never enters a default
// Profile; work.cad.v1 is opt-in via the workCad capability toggle.
//
// PR pinned surface (verified 2026-09-04):
//   - upstream ahujasid/blender-mcp @ 5866814479b4e2ca674d8d44969a9a2a78fd
//     c8bb ("hygiene: version bump", 2026-09-02) — the PyPI 1.9.1 wheel was
//     verified code-identical to that commit by the audit (modulo line
//     endings); the wheel sha256 below is the trust boundary for the whole
//     dependency closure in ./wheels/blender-mcp.wheels.mjs (31 wheels);
//   - a real stdio initialize + tools/list smoke of the pinned wheel
//     returned EXACTLY the 28 tool names below;
//   - telemetry: upstream ships Supabase telemetry ON BY DEFAULT (prompts,
//     code, screenshots — verified POSTing at startup). The env below is
//     the kill switch, verified against the pinned source; it must never be
//     dropped from this manifest.
//   - `execute_blender_code` is arbitrary Python execution inside Blender by
//     design — classified destructive (always prompts) in the classifier.
//
// Connection model: the server talks raw TCP to the Blender addon socket on
// 127.0.0.1:9876. The addon must be installed (blender-mcp install-addon)
// and its server started in the Blender UI — the installCondition below
// degrades the package to condition-missing until the bridge answers.

import { BLENDER_MCP_WHEELS, BLENDER_MCP_STATE_DIGEST } from './wheels/blender-mcp.wheels.mjs';

export const BLENDER_MCP_ALLOWED_TOOLS = Object.freeze([
  'get_addon_status',
  'disable_telemetry',
  'get_scene_info',
  'get_object_info',
  'get_viewport_screenshot',
  'execute_blender_code',
  'get_polyhaven_categories',
  'search_polyhaven_assets',
  'download_polyhaven_asset',
  'set_texture',
  'get_polyhaven_status',
  'get_hyper3d_status',
  'get_sketchfab_status',
  'search_sketchfab_models',
  'get_sketchfab_model_preview',
  'download_sketchfab_model',
  'get_polypizza_status',
  'search_polypizza_models',
  'download_polypizza_model',
  'generate_hyper3d_model_via_text',
  'generate_hyper3d_model_via_images',
  'poll_rodin_job_status',
  'import_generated_asset',
  'get_hunyuan3d_status',
  'generate_hunyuan3d_model',
  'poll_hunyuan_job_status',
  'import_generated_asset_hunyuan',
  'record_trajectory_feedback',
]);

export const BLENDER_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'blender-mcp',
  displayName: 'Blender 自动化',
  version: '1.9.1',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/ahujasid/blender-mcp',
    license: 'MIT',
    releaseUrl: 'https://pypi.org/project/blender-mcp/1.9.1/',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    installStrategy: 'pinned-pypi-env',
    // The wheel-set state digest — resolve() vouches installs by it (the
    // transport writes the same value into install-state.json).
    archiveSha256: BLENDER_MCP_STATE_DIGEST,
    pythonVersion: '3.12',
    pythonPackage: 'blender-mcp',
    wheels: BLENDER_MCP_WHEELS,
    executableRelativePath: '.venv/Scripts/blender-mcp.exe',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-blender',
    transport: 'stdio',
    args: Object.freeze([]),
    env: Object.freeze({
      // The telemetry kill switch (verified: collector init is gated on it).
      // Without this the pinned wheel posts prompts/screenshots to Supabase.
      DISABLE_TELEMETRY: '1',
    }),
    // EXACT tool set of the pinned wheel, from a real stdio tools/list smoke
    // (2026-09-04). A drift is degraded, never silently accepted.
    expectedTools: BLENDER_MCP_ALLOWED_TOOLS,
  }),

  installCondition: Object.freeze({
    kind: 'app-bridge',
    label: 'Blender',
    roots: Object.freeze(['${ProgramFiles}\\Blender Foundation', '${ProgramFiles}\\Steam\\steamapps\\common']),
    markers: Object.freeze(['Blender*/blender.exe', 'Blender/blender.exe']),
    bridge: Object.freeze({ host: '127.0.0.1', from: 9876, to: 9876 }),
    remediation:
      '已检测到 Blender 但其 MCP 插件服务未运行：请在 Blender 中安装 blender-mcp 插件（或运行 blender-mcp install-addon 后重启），并在 3D 视图侧栏启动 MCP Server。',
  }),

  activation: 'explicit-computer',
  classifierId: 'blender-mcp',
  healthCheck: 'python-metadata',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default BLENDER_MCP_MANIFEST;
