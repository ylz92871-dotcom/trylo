// Trylo Desktop Services — AutoCAD MCP tool package manifest (pinned).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §6.2 (pinned-pypi-env, wheels mode).
// Static data only — see manifests/officecli.mjs for the invariants.
//
// Explicit-computer activation ONLY: enters runs solely via work.cad.v1.
//
// PR pinned surface (verified 2026-09-04):
//   - upstream U-C4N/Autocad-MCP, PyPI `autocad-mcp-pro` 1.5.1 (2026-08-07,
//     MIT) — wheel sha256 below verified against the PyPI JSON API AND the
//     GitHub tag v1.5.1 (HEAD is one docs-only commit ahead of the tag);
//     the 80-wheel closure in ./wheels/autocad-mcp.wheels.mjs includes the
//     `com` extra (pywin32 for live COM) and the `pdf` extra (matplotlib
//     for drawing_export_pdf) resolved for CPython 3.12 win_amd64;
//   - a real stdio initialize + tools/list smoke with ENABLE_3D=true
//     returned EXACTLY the 154 tool names below (149 without the 3D group);
//   - no telemetry, no non-loopback network in the server.
//   - ARBITRARY EXECUTION, classified destructive (always prompts):
//     `system_run_command` (free-text AutoCAD command) and `system_run_lisp`
//     (AutoLISP eval). Upstream's denylist guard is explicitly "not a
//     security boundary"; DANGEROUS_COMMANDS_ENABLED stays false (default).
//
// Engine selection: AUTOCAD_MCP_BACKEND=auto attaches to a RUNNING AutoCAD
// (GetActiveObject) first and only falls back to launching one, then to the
// headless ezdxf engine when AutoCAD is absent — the package therefore
// works on every machine and carries NO installCondition; live COM needs a
// licensed AutoCAD (the headless engine reads/writes DXF without it).

import { AUTOCAD_MCP_WHEELS, AUTOCAD_MCP_STATE_DIGEST } from './wheels/autocad-mcp.wheels.mjs';

export const AUTOCAD_MCP_ALLOWED_TOOLS = Object.freeze([
  // Drawing lifecycle (14)
  'drawing_info',
  'drawing_new',
  'drawing_open',
  'drawing_save',
  'drawing_save_as',
  'drawing_export_dxf',
  'drawing_export_pdf',
  'drawing_purge',
  'drawing_audit',
  'drawing_close',
  'drawing_undo',
  'drawing_redo',
  'drawing_settings',
  'drawing_apply_iso_layers',
  // Quality loop / delivery (6)
  'drawing_preflight',
  'drawing_plan',
  'drawing_critique',
  'drawing_refine',
  'drawing_finalize',
  'drawing_deliver',
  // Entity creation (16)
  'entity_create_line',
  'entity_create_circle',
  'entity_create_arc',
  'entity_create_polyline',
  'entity_create_rectangle',
  'entity_create_text',
  'entity_create_mtext',
  'entity_create_table',
  'entity_create_hatch',
  'entity_create_spline',
  'entity_create_ellipse',
  'entity_create_point',
  'entity_create_block_ref',
  'entity_create_wipeout',
  'entity_create_revcloud',
  'leader_create_mleader',
  // Hatch editing (3)
  'hatch_set_gradient',
  'hatch_edit',
  'hatch_add_boundary',
  // Dimensions (6)
  'dimension_linear',
  'dimension_aligned',
  'dimension_angular',
  'dimension_radius',
  'dimension_diameter',
  'dimension_auto',
  // Entity modify (18)
  'entity_move',
  'entity_copy',
  'entity_rotate',
  'entity_scale',
  'entity_mirror',
  'entity_offset',
  'entity_trim',
  'entity_extend',
  'entity_fillet',
  'entity_chamfer',
  'entity_delete',
  'entity_array_rectangular',
  'entity_array_polar',
  'entity_set_properties',
  'entity_edit_text',
  'entity_edit_geometry',
  'entity_delete_many',
  'entity_change_space',
  // Text (2)
  'text_set_background',
  'text_find_replace',
  // Selection (5)
  'selection_window',
  'selection_polygon',
  'selection_filter',
  'selection_get',
  'entity_select_smart',
  // Query (2)
  'entity_get',
  'entity_list',
  // Layers (12)
  'layer_list',
  'layer_create',
  'layer_delete',
  'layer_set_current',
  'layer_modify',
  'layer_freeze',
  'layer_thaw',
  'layer_lock',
  'layer_unlock',
  'layer_hide',
  'layer_show',
  'layer_isolate',
  // Linetypes (2)
  'linetype_list',
  'linetype_load',
  // Blocks (7)
  'block_list',
  'block_insert',
  'block_explode',
  'block_get_attributes',
  'block_set_attributes',
  'block_create_from_entities',
  'block_find_references',
  // Boundaries (2)
  'boundary_trace',
  'boundary_from_entities',
  // Analysis / measurement (10)
  'analysis_list_properties',
  'analysis_entity_stats',
  'analysis_find_in_region',
  'analysis_measure_distance',
  'analysis_measure_area',
  'analysis_measure_entity',
  'analysis_bounding_box',
  'analysis_select_by_layer',
  'analysis_select_by_type',
  'analysis_layer_stats',
  // Batching (3)
  'cad_batch',
  'entity_batch_create',
  'entity_batch_modify',
  // Templates & validation (3)
  'template_apply_layers',
  'template_list',
  'validation_check',
  // Views (4)
  'view_zoom_extents',
  'view_zoom_window',
  'view_screenshot',
  'view_zoom_and_screenshot',
  // Transactions (3)
  'transaction_begin',
  'transaction_commit',
  'transaction_rollback',
  // System (7)
  'system_status',
  'system_capabilities',
  'system_get_variable',
  'system_set_variable',
  'system_run_command',
  'system_run_lisp',
  'system_about',
  // Engineering generators (6)
  'gear_draw_helical_front_view',
  'gear_draw_spur_front_view',
  'gear_draw_section_aa',
  'keyway_draw_keyed_bore',
  'keyway_draw_section',
  'titleblock_apply_iso_a3',
  // Points / construction (5)
  'point_from_snap',
  'point_intersection',
  'point_tangent',
  'construction_xline',
  'construction_clear',
  // GD&T (2)
  'gd_frame',
  'datum_feature',
  // Layouts (6)
  'layout_list',
  'layout_create',
  'layout_set_current',
  'layout_delete',
  'layout_rename',
  'layout_copy',
  // Viewports (5)
  'viewport_create',
  'viewport_list',
  'viewport_set_scale',
  'viewport_lock',
  'viewport_delete',
  // 3D solids (5, ENABLE_3D=true + COM only)
  'solid_box',
  'solid_cylinder',
  'solid_extrude',
  'solid_revolve',
  'solid_boolean',
]);

export const AUTOCAD_MCP_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: 'autocad-mcp',
  displayName: 'AutoCAD 自动化',
  version: '1.5.1',
  adoption: 'trial',

  source: Object.freeze({
    repository: 'https://github.com/U-C4N/Autocad-MCP',
    license: 'MIT',
    releaseUrl: 'https://pypi.org/project/autocad-mcp-pro/1.5.1/',
  }),

  artifact: Object.freeze({
    platform: 'win32-x64',
    installStrategy: 'pinned-pypi-env',
    archiveSha256: AUTOCAD_MCP_STATE_DIGEST,
    pythonVersion: '3.12',
    pythonPackage: 'autocad-mcp-pro',
    wheels: AUTOCAD_MCP_WHEELS,
    executableRelativePath: '.venv/Scripts/autocad-mcp.exe',
  }),

  mcp: Object.freeze({
    serverName: 'trylo-autocad',
    transport: 'stdio',
    args: Object.freeze(['--transport', 'stdio']),
    env: Object.freeze({
      // attach-first (GetActiveObject), launch only when closed, ezdxf when
      // AutoCAD is absent. See header — startup latency risk documented in
      // the spec.
      AUTOCAD_MCP_BACKEND: 'auto',
      // Advertise the 5 solid_* tools too (live COM only).
      ENABLE_3D: 'true',
      // Keep upstream's denylist bypass OFF (default; belt and braces).
      DANGEROUS_COMMANDS_ENABLED: 'false',
    }),
    // EXACT tool set of the pinned wheel under the env above, from a real
    // stdio tools/list smoke (2026-09-04). Drift is degraded, never accepted.
    expectedTools: AUTOCAD_MCP_ALLOWED_TOOLS,
  }),

  activation: 'explicit-computer',
  classifierId: 'autocad-mcp',
  healthCheck: 'python-metadata',
  telemetry: 'forced-off',
  uninstall: 'remove-version-directory',
});

export default AUTOCAD_MCP_MANIFEST;
