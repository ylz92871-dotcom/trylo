// Trylo Desktop Services — KiCad MCP tool package manifest (pinned).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §6.3 (release-archive + npm-ci-build +
// host-interpreter wheels). Static data only — see manifests/officecli.mjs
// for the invariants.
//
// Explicit-computer activation ONLY: enters runs solely via work.cad.v1.
//
// PR pinned surface (verified 2026-09-04):
//   - upstream mixelpixx/KiCAD-MCP-Server @ aa53d52c2e37a13cb3574a6e0acf2c7
//     28b4d6bfb (== tag v2.7.0, 2026-08-20, MIT; the "Konnect" successor is
//     AGPL — THIS repo is MIT). NOT published to npm or PyPI under its own
//     name (every registry name collides with unrelated third-party code —
//     never resolve by name) — hence release-archive SOURCE mode: tarball
//     digest → the repo's committed package-lock.json integrity hashes
//     (npm ci --ignore-scripts) → `npm run build` (tsc).
//   - a real stdio initialize + tools/list smoke of the pinned build
//     returned EXACTLY the 229 tool names below (source == live, zero
//     diff; the README's "169" is stale documentation).
//   - no telemetry. Optional JLCPCB API keys are never injected; the
//     download_jlcpcb_database tool (~1.5 GB) is classified destructive so
//     it can never run unattended.
//
// KiCad dependency chain (why this manifest is shaped like it is):
//   The Node MCP server spawns a Python helper (`kicad_interface.py`) whose
//   pcbnew / kipy imports exist ONLY inside KiCad's own bundled interpreter.
//   The transport therefore installs the pinned wheel closure in
//   ./wheels/kicad-mcp.wheels.mjs (resolved for KiCad 9's CPython 3.11)
//   INTO the detected KiCad python (`pythonWheelsTarget: 'kicad-bundled'`).
//   Without a KiCad installation the install honestly fails
//   (kicad_python_missing), and the installCondition below degrades the
//   package in Settings. Known limits, documented in the spec: a future
//   KiCad whose bundled CPython differs breaks the pinned wheel family
//   (fail-loud, remediation says re-pin); SWIG zone refill carries an
//   upstream-documented segfault risk (refill_zones prompts always).
//
// Destructive surface (classifier flags): the 10+ delete/overwrite tools
// (delete_component, delete_trace, clear_board_outline, replace_board_outline,
// delete_symbol, schematic deletes, save_board(force)/discard_or_reload),
// autoroute, and download_jlcpcb_database.

import { KICAD_MCP_WHEELS } from './wheels/kicad-mcp.wheels.mjs';

export const KICAD_MCP_ALLOWED_TOOLS = Object.freeze([
  // Router / discovery (3)
  'list_tool_categories',
  'get_category_tools',
  'search_tools',
  // Project (12)
  'create_project',
  'open_project',
  'open_board',
  'reload_board',
  'close_project',
  'save_project',
  'save_board',
  'save_as',
  'is_dirty',
  'discard_or_reload',
  'get_project_info',
  'snapshot_project',
  // Board (19)
  'set_board_size',
  'set_board_origin',
  'get_board_origin',
  'add_layer',
  'set_active_layer',
  'get_board_info',
  'get_layer_list',
  'add_board_outline',
  'clear_board_outline',
  'replace_board_outline',
  'list_graphics',
  'delete_graphic',
  'update_graphic',
  'add_mounting_hole',
  'add_board_text',
  'add_zone',
  'get_board_extents',
  'get_board_2d_view',
  'import_svg_logo',
  // Component (28)
  'place_component',
  'move_component',
  'batch_move_components',
  'rotate_component',
  'delete_component',
  'edit_component',
  'set_footprint_type',
  'find_component',
  'get_component_properties',
  'add_component_annotation',
  'group_components',
  'replace_component',
  'get_component_pads',
  'get_pads',
  'get_net_pads',
  'get_component_geometry',
  'get_component_list',
  'get_pad_position',
  'get_ratsnest',
  'estimate_airwire_lengths',
  'check_placement_clearance',
  'move_footprint_text',
  'place_component_array',
  'align_components',
  'check_courtyard_overlaps',
  'suggest_placement',
  'duplicate_component',
  'hierarchical_place',
  // Schematic (46)
  'create_schematic',
  'add_schematic_component',
  'delete_schematic_component',
  'edit_schematic_component',
  'set_schematic_component_property',
  'remove_schematic_component_property',
  'get_schematic_component',
  'add_schematic_wire',
  'add_schematic_net_label',
  'add_no_connect',
  'connect_to_net',
  'get_net_connections',
  'get_wire_connections',
  'get_schematic_pin_locations',
  'connect_passthrough',
  'list_schematic_components',
  'list_schematic_nets',
  'list_schematic_wires',
  'list_schematic_labels',
  'move_schematic_component',
  'rotate_schematic_component',
  'annotate_schematic',
  'delete_schematic_wire',
  'delete_schematic_net_label',
  'move_schematic_net_label',
  'export_schematic_svg',
  'export_schematic_pdf',
  'get_schematic_view',
  'run_erc',
  'generate_netlist',
  'sync_schematic_to_board',
  'backannotate_footprints',
  'create_board_from_schematic',
  'get_schematic_view_region',
  'find_overlapping_elements',
  'get_elements_in_region',
  'find_wires_crossing_symbols',
  'list_floating_labels',
  'find_orphaned_wires',
  'snap_to_grid',
  'lint_offgrid',
  'get_net_at_point',
  'add_schematic_hierarchical_label',
  'list_schematic_texts',
  'add_schematic_text',
  'add_sheet_pin',
  // Schematic hierarchy (5)
  'add_hierarchical_sheet',
  'remove_hierarchical_sheet',
  'set_sheet_property',
  'get_sheet_properties',
  'create_hierarchical_subsheet',
  // Schematic layout (5)
  'set_schematic_property_position',
  'batch_set_schematic_property_positions',
  'autoplace_schematic_fields',
  'lint_schematic_cosmetic',
  'suggest_schematic_declutter',
  // Schematic batch (9)
  'batch_add_components',
  'batch_edit_schematic_components',
  'update_symbol_from_library',
  'add_library_symbol_property',
  'replace_instance_lib_ids',
  'replace_schematic_component',
  'batch_add_no_connects',
  'batch_connect',
  'batch_add_and_connect',
  // Routing (16)
  'add_net',
  'route_trace',
  'route_arc_trace',
  'add_via',
  'add_copper_pour',
  'delete_trace',
  'query_traces',
  'query_zones',
  'add_gnd_stitching_vias',
  'get_nets_list',
  'modify_trace',
  'create_netclass',
  'route_differential_pair',
  'refill_zones',
  'route_pad_to_pad',
  'copy_routing_pattern',
  // Design rules (7)
  'set_design_rules',
  'get_design_rules',
  'run_drc',
  'assign_net_to_class',
  'set_layer_constraints',
  'check_clearance',
  'get_drc_violations',
  // Library footprints (7)
  'list_libraries',
  'search_footprints',
  'list_library_footprints',
  'get_footprint_info',
  'list_library_table',
  'remove_library_table_entry',
  'set_library_table_uri',
  // Library symbols (9)
  'list_symbol_libraries',
  'repair_flat_symbols',
  'search_symbols',
  'list_library_symbols',
  'get_symbol_info',
  'list_symbol_pins',
  'batch_list_symbol_pins',
  'set_symbol_pin_type',
  'find_duplicate_symbols',
  // Symbol creator (8)
  'create_symbol',
  'delete_symbol',
  'list_symbols_in_library',
  'register_symbol_library',
  'add_symbol_property',
  'import_symbol',
  'export_symbol',
  'rename_symbol',
  // Footprint (7)
  'create_footprint',
  'add_footprint_3d_model',
  'import_3d_model',
  'add_component_3d_model',
  'edit_footprint_pad',
  'register_footprint_library',
  'list_footprint_libraries',
  // Export / manufacturing (27)
  'export_gerber',
  'export_pdf',
  'export_svg',
  'export_3d',
  'export_bom',
  'export_netlist',
  'export_position_file',
  'export_vrml',
  'export_gerbers',
  'export_drill',
  'export_ipc2581',
  'export_odb',
  'export_ipcd356',
  'export_gencad',
  'export_pos',
  'export_pcb_pdf',
  'export_pcb_svg',
  'export_pcb_dxf',
  'export_gerber_single',
  'export_3d_cli',
  'export_sch_bom',
  'export_sch_pdf',
  'export_sch_svg',
  'export_sch_dxf',
  'export_sch_hpgl',
  'export_sch_ps',
  'export_sch_python_bom',
  // Datasheet (2)
  'enrich_datasheets',
  'get_datasheet_url',
  // Parts registry (3)
  'search_parts_registry',
  'get_registry_part',
  'download_registry_part',
  // JLCPCB API (5)
  'download_jlcpcb_database',
  'search_jlcpcb_parts',
  'get_jlcpcb_part',
  'get_jlcpcb_database_stats',
  'suggest_jlcpcb_alternatives',
  // Freerouting (4)
  'autoroute',
  'export_dsn',
  'import_ses',
  'check_freerouting',
  // Importers (2)
  'import_eagle_project',
  'import_pcb',
  // UI (3)
  'get_backend_state',
  'check_kicad_ui',
  'launch_kicad_ui',
  // Validation (2)
  'validate_schematic',
  'validate_symbol_library',
]);

export const KICAD_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'kicad-mcp',
  displayName: 'KiCad 自动化',
  version: '2.7.0',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/mixelpixx/KiCAD-MCP-Server',
    license: 'MIT',
    releaseUrl: 'https://github.com/mixelpixx/KiCAD-MCP-Server/archive/aa53d52c2e37a13cb3574a6e0acf2c728b4d6bfb.tar.gz',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    installStrategy: 'release-archive',
    archiveSha256: 'b4c1b390f2dba738c24ea8a5944b54f3698dbc300324c0357f528b76e9dd8fa8',
    downloadUrl:
      'https://github.com/mixelpixx/KiCAD-MCP-Server/archive/aa53d52c2e37a13cb3574a6e0acf2c728b4d6bfb.tar.gz',
    // Source-only TypeScript server: extract → npm ci --ignore-scripts from
    // the committed lockfile → npm run build (tsc) → dist/index.js.
    build: Object.freeze({ kind: 'npm-ci-build' }),
    // The Node server spawns KiCad's OWN bundled Python (pcbnew/kipy live
    // nowhere else); these pinned wheels land in that interpreter.
    pythonWheels: KICAD_MCP_WHEELS,
    pythonWheelsTarget: 'kicad-bundled',
    executableRelativePath: 'dist/index.js',
    sourceEntry: 'dist/index.js',
    runner: 'node',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-kicad',
    transport: 'stdio',
    args: Object.freeze([]),
    env: Object.freeze({}),
    // EXACT tool set of the pinned build, from a real stdio tools/list
    // smoke (2026-09-04) — initialize/tools-list need no KiCad; tool CALLS
    // need it. Drift is degraded, never silently accepted.
    expectedTools: KICAD_MCP_ALLOWED_TOOLS,
  }),

  installCondition: Object.freeze({
    kind: 'executable-glob',
    label: 'KiCad',
    roots: Object.freeze(['${ProgramFiles}', '${LOCALAPPDATA}\\Programs']),
    markers: Object.freeze(['KiCad/*/bin/python.exe', 'KiCad/*/bin/kicad-cli.exe']),
    remediation:
      '未检测到 KiCad 9 或更高版本：本包需要 KiCad 自带的 Python（pcbnew）与 kicad-cli。请安装 KiCad 9/10 后重试（https://www.kicad.org/download/）。',
  }),

  activation: 'explicit-computer',
  classifierId: 'kicad-mcp',
  healthCheck: 'source-entry',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default KICAD_MCP_MANIFEST;
