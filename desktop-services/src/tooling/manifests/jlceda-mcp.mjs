// Trylo Desktop Services — 嘉立创EDA专业版 MCP tool package manifest (pinned).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §6.3 (release-archive + npm-ci-build).
// Static data only — see manifests/officecli.mjs for the invariants.
//
// Explicit-computer activation ONLY: enters runs solely via work.cad.v1.
//
// PR pinned surface (verified 2026-09-04):
//   - upstream hyl64/jlcmcp @ 5e53ddaa07e1763de6c1b17a82aafa2cb1476d4b (==
//     tag v1.4.0, 2026-08-15, MIT). NOT published to npm (`private: true`;
//     the npm mirror `@iflow-mcp/hyl64-jlcmcp` is UNRELATED third-party
//     code and must never be used) — hence release-archive SOURCE mode:
//     tarball digest → the repo's committed package-lock.json integrity
//     hashes (npm ci --ignore-scripts) → `npm run build` (tsc).
//   - a real stdio initialize + tools/list smoke of the pinned build
//     returned EXACTLY the 59 tool names below. The 60th upstream tool
//     (`pcb_agent`) registers ONLY when ANTHROPIC_API_KEY is set — that
//     env is never injected here, so 59 is the complete audited surface.
//   - no telemetry; loopback-only network (bridge scan 49620-49629).
//   - `pcb_execute_code` runs arbitrary JS inside the EDA extension sandbox
//     — classified destructive (always prompts). The 7 pcb_delete_* tools
//     and the board-mutating auto tools are flagged per the audit table.
//
// Connection model: scans 127.0.0.1:49620-49629 for the official Bridge
// Server (vendored, spawned automatically), which the 嘉立创EDA专业版
// Run API Gateway extension connects to. The user must open the editor
// (≥3.2) with the extension enabled + 「允许外部交互」. Calculators work
// headless; everything else needs the editor — hence the app-bridge
// condition with allowBridgeOnly (install paths are not stable enough to
// marker-probe; a live bridge is the authoritative signal).

export const JLCEDA_MCP_ALLOWED_TOOLS = Object.freeze([
  // State / query (9)
  'pcb_get_state',
  'pcb_screenshot',
  'pcb_run_drc',
  'pcb_get_tracks',
  'pcb_get_pads',
  'pcb_get_net_primitives',
  'pcb_get_board_info',
  'pcb_get_feature_support',
  'pcb_ping',
  // Components (6)
  'pcb_move_component',
  'pcb_relocate_component',
  'pcb_batch_move',
  'pcb_select_component',
  'pcb_delete_selected',
  'pcb_create_component',
  // Tracks / vias (4)
  'pcb_route_track',
  'pcb_create_via',
  'pcb_delete_tracks',
  'pcb_delete_via',
  // Copper / keepout (4)
  'pcb_create_copper_pour',
  'pcb_delete_pour',
  'pcb_create_keepout',
  'pcb_delete_keepout',
  // Silkscreen (3)
  'pcb_get_silkscreens',
  'pcb_move_silkscreen',
  'pcb_auto_silkscreen',
  // Constraints (6)
  'pcb_create_diff_pair',
  'pcb_list_diff_pairs',
  'pcb_delete_diff_pair',
  'pcb_create_equal_length',
  'pcb_list_equal_lengths',
  'pcb_delete_equal_length',
  // Schematic / documents (4)
  'sch_get_state',
  'sch_get_netlist',
  'sch_run_drc',
  'pcb_open_document',
  // Bridge operations (4)
  'pcb_bridge_status',
  'pcb_list_eda_windows',
  'pcb_select_eda_window',
  'pcb_execute_code',
  // Calculators (2)
  'calc_impedance',
  'calc_trace_width',
  // Pro v1.1-v1.4 (17)
  'pcb_bom_export',
  'pcb_net_connectivity_check',
  'pcb_current_density_report',
  'pcb_fanout_component',
  'pcb_auto_route_nets',
  'pcb_drc_autofix',
  'pcb_component_clearance_check',
  'pcb_route_differential_pairs',
  'pcb_design_health_report',
  'pcb_auto_fanout_and_route',
  'pcb_auto_place_components',
  'pcb_netlist_report',
  'pcb_design_snapshot',
  'pcb_design_diff',
  'sch_generate_from_netlist',
  'sch_generate_from_pcb',
  'pcb_eprj3_project_info',
]);

export const JLCEDA_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'jlceda-mcp',
  displayName: '嘉立创EDA专业版 自动化',
  version: '1.4.0',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/hyl64/jlcmcp',
    license: 'MIT',
    releaseUrl: 'https://github.com/hyl64/jlcmcp/archive/5e53ddaa07e1763de6c1b17a82aafa2cb1476d4b.tar.gz',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    installStrategy: 'release-archive',
    archiveSha256: '185e77bffdbda08c0b8a53e66b30e9840f605db9bde7dc114555c5dcdeff2ebb',
    downloadUrl: 'https://github.com/hyl64/jlcmcp/archive/5e53ddaa07e1763de6c1b17a82aafa2cb1476d4b.tar.gz',
    // Source-only TypeScript server: extract → npm ci --ignore-scripts from
    // the committed lockfile → npm run build (tsc) → dist/index.js.
    build: Object.freeze({ kind: 'npm-ci-build' }),
    executableRelativePath: 'dist/index.js',
    // The built entry doubles as the health probe target: upstream answers
    // no `--version` (a version-handshake probe would hang the stdio server
    // until timeout), so health = the audited entry file exists.
    sourceEntry: 'dist/index.js',
    runner: 'node',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-jlceda',
    transport: 'stdio',
    args: Object.freeze([]),
    env: Object.freeze({}),
    // EXACT tool set of the pinned build WITHOUT ANTHROPIC_API_KEY (the
    // conditional pcb_agent never registers in the Trylo runtime), from a
    // real stdio tools/list smoke (2026-09-04).
    expectedTools: JLCEDA_MCP_ALLOWED_TOOLS,
  }),

  installCondition: Object.freeze({
    // Install detection via the ALL-USERS Start Menu shortcuts — the
    // installer's only machine-wide, drive-independent footprint (real
    // machines install to custom roots like D:\lceda-pro, which no
    // well-known env root can cover). The Bridge Server itself is
    // auto-spawned by the MCP server at run time and connects OUT to the
    // editor's Run API Gateway extension, so port liveness is NOT a health
    // concern: with the editor closed, tools fail with clean per-call
    // errors (「未发现 Bridge Server（端口 49620-49629）」).
    kind: 'executable-glob',
    label: '嘉立创EDA专业版',
    roots: Object.freeze([
      '${ProgramData}\\Microsoft\\Windows\\Start Menu\\Programs',
      '${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs',
    ]),
    markers: Object.freeze(['嘉立创EDA*/嘉立创EDA*.lnk']),
    remediation:
      '未检测到嘉立创EDA专业版：请安装嘉立创EDA专业版（≥3.2）。安装后若工具报未连接，请打开专业版并打开一个工程，在 高级 → 扩展管理器 中安装/启用「Run API Gateway」扩展，并在其配置中勾选「允许外部交互」。',
  }),

  activation: 'explicit-computer',
  classifierId: 'jlceda-mcp',
  healthCheck: 'source-entry',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default JLCEDA_MCP_MANIFEST;
