// Trylo Desktop — CAD/EDA adapter risk classifiers (shared engine).
//
// TRYLO-CAD-EDA-TOOL-ADAPTER spec §7. The renderer-side twin of the six CAD
// manifests' `classifierId` / `mcp.serverName` / `mcp.expectedTools` triple.
//
// Five packages, one deterministic engine, six EXPLICIT policy tables. The
// policy tables are hand-audited dispositions of every pinned tool name
// (audit 2026-09-04: source AST + live stdio tools/list, see the spec's
// audit tables) — NOT inferred from MCP annotations, which are hints only
// (§6.2). Each table partitions its package's tool surface into:
//
//   read          — query/list/inspect; auto-allowed at every level ≥ read_only
//   workspace-write — document/project edits and file exports; auto-allowed
//                   at ≥ ask (§6.3 matrix), denied at read_only
//   external      — non-loopback network (asset catalogs, paid 3D services,
//                   JLCPCB open platform); always a prompt
//   sensitive     — launching the host application's GUI; always a prompt
//   destructive   — data loss beyond the current edit session (delete/clear/
//                   overwrite/close-without-save) or ARBITRARY CODE EXECUTION
//                   (execute_blender_code / execute_code[_async] /
//                   pcb_execute_code / system_run_command / system_run_lisp —
//                   upstream self-documents its denylist as "not a security
//                   boundary"); always a prompt, never auto, never leased
//
// Everything a table does not name falls to workspace-write ONLY because the
// partition validator below PROVES the four explicit lists + the remainder
// cover the pinned tool set exactly — an unknown tool (drift) is denied by
// the router before this engine runs (§6.2 exact-name rule).
//
// SolidWorks / AutoCAD carry NO install condition, so their headless halves
// stay usable without the host app; their COM tools fail with honest per-call
// errors. See the spec for the read_only / unrestricted matrix and the
// deliberate decision NOT to auto-allow any prompt-class tool.

import type { ApprovalPreview } from '../../approval/approval-preview';
import type {
  PackageRiskClassifier,
  SafeAudit,
  ToolRiskClass,
  ToolRiskContext,
  ToolRiskDecision,
} from '../tool-risk-classifier';
import { inputDigestOf } from '../input-digest';

/** Inputs above this canonical-JSON size are never auto-allowed (§14.2). */
const MAX_INPUT_JSON_LENGTH = 256 * 1024;

/** One package's audited disposition. `read`/`external`/`sensitive`/
 *  `destructive` are explicit; every remaining pinned tool is
 *  workspace-write. The partition validator enforces exact coverage. */
interface CadEdaPolicy {
  readonly id: string;
  readonly serverName: string;
  readonly appLabel: string;
  readonly tools: readonly string[];
  readonly read: readonly string[];
  readonly external?: readonly string[];
  readonly sensitive?: readonly string[];
  readonly destructive?: readonly string[];
}

function riskLabel(risk: ToolRiskClass): string {
  switch (risk) {
    case 'read': return '读取';
    case 'workspace-write': return '写入';
    case 'external': return '外部网络访问';
    case 'sensitive': return '敏感操作';
    case 'destructive': return '破坏性操作';
  }
}

// ── the six audited policy tables (audit 2026-09-04) ─────────────────

const SOLIDWORKS_POLICY: CadEdaPolicy = {
  id: 'solidworks-mcp',
  serverName: 'trylo-solidworks',
  appLabel: 'SolidWorks',
  tools: [
    'cadstudio_resolve_backend', 'cadstudio_write_open_format', 'cadstudio_build_dxf_preview_scene',
    'cadstudio_check_dfm', 'cadstudio_check_routing', 'cadstudio_routing_preflight',
    'solidworks_addin_host_status', 'cadstudio_fea_preflight', 'cadstudio_prepare_fea',
    'cadstudio_run_fea', 'cadstudio_run_fea_convergence', 'cadstudio_review_advanced_geometry',
    'cadstudio_create_ocp_loft', 'cadstudio_create_ocp_surface',
    'solidworks_connect', 'solidworks_health_check', 'solidworks_new_document',
    'solidworks_create_basic_part', 'solidworks_open_document', 'solidworks_add_component',
    'solidworks_set_component_fixed', 'solidworks_save_document', 'solidworks_close_documents',
    'solidworks_add_coincident_mate', 'solidworks_add_distance_mate', 'solidworks_add_concentric_mate',
    'solidworks_set_appearance', 'solidworks_export_active', 'solidworks_inspect_configurations',
    'solidworks_create_configuration', 'solidworks_activate_configuration', 'solidworks_update_dimension',
    'solidworks_set_custom_properties', 'solidworks_batch_export_files', 'solidworks_export_assembly_bom',
    'solidworks_pack_and_go', 'solidworks_review_active', 'solidworks_generate_drawing',
    'solidworks_review_drawing', 'solidworks_inspect_drawing', 'solidworks_create_hole_feature',
    'solidworks_inspect_hole_features', 'solidworks_add_rotary_motor', 'solidworks_inspect_motion_studies',
    'solidworks_validate_motion_study',
    // Controlled modeling channel (2026-09-06): stateful mm-world modeling
    // primitives pinned by the manifest. measure/probe are read-class; the
    // begin/sketch/feature/commit writers ride the workspace-write baseline.
    'solidworks_modeling_begin', 'solidworks_modeling_sketch', 'solidworks_modeling_feature',
    'solidworks_modeling_measure', 'solidworks_modeling_commit', 'solidworks_probe_direction_semantics',
  ],
  read: [
    'solidworks_health_check', 'solidworks_inspect_configurations', 'solidworks_inspect_drawing',
    'solidworks_inspect_hole_features', 'solidworks_inspect_motion_studies', 'cadstudio_resolve_backend',
    'cadstudio_build_dxf_preview_scene', 'cadstudio_check_dfm', 'cadstudio_check_routing',
    'cadstudio_routing_preflight', 'solidworks_addin_host_status', 'cadstudio_fea_preflight',
    'cadstudio_review_advanced_geometry', 'solidworks_modeling_measure', 'solidworks_probe_direction_semantics',
  ],
  sensitive: ['solidworks_connect'],
  destructive: ['solidworks_close_documents'],
};

const AUTOCAD_POLICY: CadEdaPolicy = {
  id: 'autocad-mcp',
  serverName: 'trylo-autocad',
  appLabel: 'AutoCAD',
  tools: [
    'drawing_info', 'drawing_new', 'drawing_open', 'drawing_save', 'drawing_save_as',
    'drawing_export_dxf', 'drawing_export_pdf', 'drawing_purge', 'drawing_audit', 'drawing_close',
    'drawing_undo', 'drawing_redo', 'drawing_settings', 'drawing_apply_iso_layers',
    'drawing_preflight', 'drawing_plan', 'drawing_critique', 'drawing_refine', 'drawing_finalize',
    'drawing_deliver',
    'entity_create_line', 'entity_create_circle', 'entity_create_arc', 'entity_create_polyline',
    'entity_create_rectangle', 'entity_create_text', 'entity_create_mtext', 'entity_create_table',
    'entity_create_hatch', 'entity_create_spline', 'entity_create_ellipse', 'entity_create_point',
    'entity_create_block_ref', 'entity_create_wipeout', 'entity_create_revcloud', 'leader_create_mleader',
    'hatch_set_gradient', 'hatch_edit', 'hatch_add_boundary',
    'dimension_linear', 'dimension_aligned', 'dimension_angular', 'dimension_radius',
    'dimension_diameter', 'dimension_auto',
    'entity_move', 'entity_copy', 'entity_rotate', 'entity_scale', 'entity_mirror', 'entity_offset',
    'entity_trim', 'entity_extend', 'entity_fillet', 'entity_chamfer', 'entity_delete',
    'entity_array_rectangular', 'entity_array_polar', 'entity_set_properties', 'entity_edit_text',
    'entity_edit_geometry', 'entity_delete_many', 'entity_change_space',
    'text_set_background', 'text_find_replace',
    'selection_window', 'selection_polygon', 'selection_filter', 'selection_get', 'entity_select_smart',
    'entity_get', 'entity_list',
    'layer_list', 'layer_create', 'layer_delete', 'layer_set_current', 'layer_modify', 'layer_freeze',
    'layer_thaw', 'layer_lock', 'layer_unlock', 'layer_hide', 'layer_show', 'layer_isolate',
    'linetype_list', 'linetype_load',
    'block_list', 'block_insert', 'block_explode', 'block_get_attributes', 'block_set_attributes',
    'block_create_from_entities', 'block_find_references',
    'boundary_trace', 'boundary_from_entities',
    'analysis_list_properties', 'analysis_entity_stats', 'analysis_find_in_region',
    'analysis_measure_distance', 'analysis_measure_area', 'analysis_measure_entity',
    'analysis_bounding_box', 'analysis_select_by_layer', 'analysis_select_by_type', 'analysis_layer_stats',
    'cad_batch', 'entity_batch_create', 'entity_batch_modify',
    'template_apply_layers', 'template_list', 'validation_check',
    'view_zoom_extents', 'view_zoom_window', 'view_screenshot', 'view_zoom_and_screenshot',
    'transaction_begin', 'transaction_commit', 'transaction_rollback',
    'system_status', 'system_capabilities', 'system_get_variable', 'system_set_variable',
    'system_run_command', 'system_run_lisp', 'system_about',
    'gear_draw_helical_front_view', 'gear_draw_spur_front_view', 'gear_draw_section_aa',
    'keyway_draw_keyed_bore', 'keyway_draw_section', 'titleblock_apply_iso_a3',
    'point_from_snap', 'point_intersection', 'point_tangent', 'construction_xline', 'construction_clear',
    'gd_frame', 'datum_feature',
    'layout_list', 'layout_create', 'layout_set_current', 'layout_delete', 'layout_rename', 'layout_copy',
    'viewport_create', 'viewport_list', 'viewport_set_scale', 'viewport_lock', 'viewport_delete',
    'solid_box', 'solid_cylinder', 'solid_extrude', 'solid_revolve', 'solid_boolean',
  ],
  read: [
    'drawing_info', 'drawing_preflight', 'drawing_critique', 'entity_get', 'entity_list',
    'entity_select_smart', 'selection_window', 'selection_polygon', 'selection_filter', 'selection_get',
    'layer_list', 'linetype_list', 'block_list', 'block_get_attributes', 'block_find_references',
    'analysis_list_properties', 'analysis_entity_stats', 'analysis_find_in_region',
    'analysis_measure_distance', 'analysis_measure_area', 'analysis_measure_entity',
    'analysis_bounding_box', 'analysis_select_by_layer', 'analysis_select_by_type', 'analysis_layer_stats',
    'template_list', 'view_zoom_extents', 'view_zoom_window', 'view_screenshot', 'view_zoom_and_screenshot',
    'system_status', 'system_capabilities', 'system_about', 'system_get_variable', 'validation_check',
    'point_from_snap', 'point_intersection', 'point_tangent',
  ],
  destructive: [
    // drawing_purge removes unused objects; construction_clear erases every
    // entity on the CONSTRUCTION layer; the two system_run_* tools are
    // arbitrary command / AutoLISP execution (upstream: "not a security
    // boundary" — always a prompt).
    'drawing_purge', 'entity_delete', 'entity_delete_many', 'layer_delete', 'layout_delete',
    'viewport_delete', 'construction_clear', 'system_run_command', 'system_run_lisp',
  ],
};

const KICAD_POLICY: CadEdaPolicy = {
  id: 'kicad-mcp',
  serverName: 'trylo-kicad',
  appLabel: 'KiCad',
  tools: [
    'list_tool_categories', 'get_category_tools', 'search_tools',
    'create_project', 'open_project', 'open_board', 'reload_board', 'close_project', 'save_project',
    'save_board', 'save_as', 'is_dirty', 'discard_or_reload', 'get_project_info', 'snapshot_project',
    'set_board_size', 'set_board_origin', 'get_board_origin', 'add_layer', 'set_active_layer',
    'get_board_info', 'get_layer_list', 'add_board_outline', 'clear_board_outline',
    'replace_board_outline', 'list_graphics', 'delete_graphic', 'update_graphic', 'add_mounting_hole',
    'add_board_text', 'add_zone', 'get_board_extents', 'get_board_2d_view', 'import_svg_logo',
    'place_component', 'move_component', 'batch_move_components', 'rotate_component', 'delete_component',
    'edit_component', 'set_footprint_type', 'find_component', 'get_component_properties',
    'add_component_annotation', 'group_components', 'replace_component', 'get_component_pads',
    'get_pads', 'get_net_pads', 'get_component_geometry', 'get_component_list', 'get_pad_position',
    'get_ratsnest', 'estimate_airwire_lengths', 'check_placement_clearance', 'move_footprint_text',
    'place_component_array', 'align_components', 'check_courtyard_overlaps', 'suggest_placement',
    'duplicate_component', 'hierarchical_place',
    'create_schematic', 'add_schematic_component', 'delete_schematic_component',
    'edit_schematic_component', 'set_schematic_component_property', 'remove_schematic_component_property',
    'get_schematic_component', 'add_schematic_wire', 'add_schematic_net_label', 'add_no_connect',
    'connect_to_net', 'get_net_connections', 'get_wire_connections', 'get_schematic_pin_locations',
    'connect_passthrough', 'list_schematic_components', 'list_schematic_nets', 'list_schematic_wires',
    'list_schematic_labels', 'move_schematic_component', 'rotate_schematic_component',
    'annotate_schematic', 'delete_schematic_wire', 'delete_schematic_net_label',
    'move_schematic_net_label', 'export_schematic_svg', 'export_schematic_pdf', 'get_schematic_view',
    'run_erc', 'generate_netlist', 'sync_schematic_to_board', 'backannotate_footprints',
    'create_board_from_schematic', 'get_schematic_view_region', 'find_overlapping_elements',
    'get_elements_in_region', 'find_wires_crossing_symbols', 'list_floating_labels',
    'find_orphaned_wires', 'snap_to_grid', 'lint_offgrid', 'get_net_at_point',
    'add_schematic_hierarchical_label', 'list_schematic_texts', 'add_schematic_text', 'add_sheet_pin',
    'add_hierarchical_sheet', 'remove_hierarchical_sheet', 'set_sheet_property', 'get_sheet_properties',
    'create_hierarchical_subsheet',
    'set_schematic_property_position', 'batch_set_schematic_property_positions',
    'autoplace_schematic_fields', 'lint_schematic_cosmetic', 'suggest_schematic_declutter',
    'batch_add_components', 'batch_edit_schematic_components', 'update_symbol_from_library',
    'add_library_symbol_property', 'replace_instance_lib_ids', 'replace_schematic_component',
    'batch_add_no_connects', 'batch_connect', 'batch_add_and_connect',
    'add_net', 'route_trace', 'route_arc_trace', 'add_via', 'add_copper_pour', 'delete_trace',
    'query_traces', 'query_zones', 'add_gnd_stitching_vias', 'get_nets_list', 'modify_trace',
    'create_netclass', 'route_differential_pair', 'refill_zones', 'route_pad_to_pad',
    'copy_routing_pattern',
    'set_design_rules', 'get_design_rules', 'run_drc', 'assign_net_to_class', 'set_layer_constraints',
    'check_clearance', 'get_drc_violations',
    'list_libraries', 'search_footprints', 'list_library_footprints', 'get_footprint_info',
    'list_library_table', 'remove_library_table_entry', 'set_library_table_uri',
    'list_symbol_libraries', 'repair_flat_symbols', 'search_symbols', 'list_library_symbols',
    'get_symbol_info', 'list_symbol_pins', 'batch_list_symbol_pins', 'set_symbol_pin_type',
    'find_duplicate_symbols',
    'create_symbol', 'delete_symbol', 'list_symbols_in_library', 'register_symbol_library',
    'add_symbol_property', 'import_symbol', 'export_symbol', 'rename_symbol',
    'create_footprint', 'add_footprint_3d_model', 'import_3d_model', 'add_component_3d_model',
    'edit_footprint_pad', 'register_footprint_library', 'list_footprint_libraries',
    'export_gerber', 'export_pdf', 'export_svg', 'export_3d', 'export_bom', 'export_netlist',
    'export_position_file', 'export_vrml', 'export_gerbers', 'export_drill', 'export_ipc2581',
    'export_odb', 'export_ipcd356', 'export_gencad', 'export_pos', 'export_pcb_pdf',
    'export_pcb_svg', 'export_pcb_dxf', 'export_gerber_single', 'export_3d_cli', 'export_sch_bom',
    'export_sch_pdf', 'export_sch_svg', 'export_sch_dxf', 'export_sch_hpgl', 'export_sch_ps',
    'export_sch_python_bom',
    'enrich_datasheets', 'get_datasheet_url',
    'search_parts_registry', 'get_registry_part', 'download_registry_part',
    'download_jlcpcb_database', 'search_jlcpcb_parts', 'get_jlcpcb_part', 'get_jlcpcb_database_stats',
    'suggest_jlcpcb_alternatives',
    'autoroute', 'export_dsn', 'import_ses', 'check_freerouting',
    'import_eagle_project', 'import_pcb',
    'get_backend_state', 'check_kicad_ui', 'launch_kicad_ui',
    'validate_schematic', 'validate_symbol_library',
  ],
  read: [
    'list_tool_categories', 'get_category_tools', 'search_tools', 'get_project_info', 'is_dirty',
    'get_board_origin', 'get_board_info', 'get_layer_list', 'list_graphics', 'get_board_extents',
    'get_board_2d_view', 'find_component', 'get_component_properties', 'get_component_pads',
    'get_pads', 'get_net_pads', 'get_component_geometry', 'get_component_list', 'get_pad_position',
    'get_ratsnest', 'estimate_airwire_lengths', 'check_placement_clearance', 'check_courtyard_overlaps',
    'suggest_placement', 'get_schematic_component', 'get_net_connections', 'get_wire_connections',
    'get_schematic_pin_locations', 'list_schematic_components', 'list_schematic_nets',
    'list_schematic_wires', 'list_schematic_labels', 'get_schematic_view', 'get_schematic_view_region',
    'find_overlapping_elements', 'get_elements_in_region', 'find_wires_crossing_symbols',
    'list_floating_labels', 'find_orphaned_wires', 'get_net_at_point', 'lint_offgrid', 'run_erc',
    'list_schematic_texts', 'get_sheet_properties', 'lint_schematic_cosmetic',
    'suggest_schematic_declutter', 'query_traces', 'query_zones', 'get_nets_list', 'get_design_rules',
    'run_drc', 'get_drc_violations', 'check_clearance', 'list_libraries', 'search_footprints',
    'list_library_footprints', 'get_footprint_info', 'list_library_table', 'list_symbol_libraries',
    'search_symbols', 'list_library_symbols', 'get_symbol_info', 'list_symbol_pins',
    'batch_list_symbol_pins', 'list_symbols_in_library', 'find_duplicate_symbols',
    'list_footprint_libraries', 'get_datasheet_url', 'search_parts_registry', 'get_registry_part',
    'search_jlcpcb_parts', 'get_jlcpcb_database_stats', 'suggest_jlcpcb_alternatives',
    'check_freerouting', 'get_backend_state', 'check_kicad_ui', 'validate_schematic',
    'validate_symbol_library',
  ],
  external: [
    // JLCPCB Open Platform call (carries user credentials when configured).
    'get_jlcpcb_part',
  ],
  sensitive: [
    // Launches the KiCad GUI on the user's desktop.
    'launch_kicad_ui',
  ],
  destructive: [
    // refill_zones carries an upstream-documented SWIG segfault risk;
    // download_jlcpcb_database writes ~1.5 GB from the network; autoroute
    // re-routes the whole board unattended; the delete/clear/replace/discard
    // family destroys design data beyond the current edit.
    'delete_component', 'clear_board_outline', 'replace_board_outline', 'delete_graphic',
    'delete_schematic_component', 'delete_schematic_wire', 'delete_schematic_net_label',
    'delete_symbol', 'delete_trace', 'remove_hierarchical_sheet', 'remove_library_table_entry',
    'remove_schematic_component_property', 'discard_or_reload', 'refill_zones', 'autoroute',
    'download_jlcpcb_database',
  ],
};

const JLCEDA_POLICY: CadEdaPolicy = {
  id: 'jlceda-mcp',
  serverName: 'trylo-jlceda',
  appLabel: '嘉立创EDA专业版',
  tools: [
    'pcb_get_state', 'pcb_screenshot', 'pcb_run_drc', 'pcb_get_tracks', 'pcb_get_pads',
    'pcb_get_net_primitives', 'pcb_get_board_info', 'pcb_get_feature_support', 'pcb_ping',
    'pcb_move_component', 'pcb_relocate_component', 'pcb_batch_move', 'pcb_select_component',
    'pcb_delete_selected', 'pcb_create_component',
    'pcb_route_track', 'pcb_create_via', 'pcb_delete_tracks', 'pcb_delete_via',
    'pcb_create_copper_pour', 'pcb_delete_pour', 'pcb_create_keepout', 'pcb_delete_keepout',
    'pcb_get_silkscreens', 'pcb_move_silkscreen', 'pcb_auto_silkscreen',
    'pcb_create_diff_pair', 'pcb_list_diff_pairs', 'pcb_delete_diff_pair', 'pcb_create_equal_length',
    'pcb_list_equal_lengths', 'pcb_delete_equal_length',
    'sch_get_state', 'sch_get_netlist', 'sch_run_drc', 'pcb_open_document',
    'pcb_bridge_status', 'pcb_list_eda_windows', 'pcb_select_eda_window', 'pcb_execute_code',
    'calc_impedance', 'calc_trace_width',
    'pcb_bom_export', 'pcb_net_connectivity_check', 'pcb_current_density_report', 'pcb_fanout_component',
    'pcb_auto_route_nets', 'pcb_drc_autofix', 'pcb_component_clearance_check',
    'pcb_route_differential_pairs', 'pcb_design_health_report', 'pcb_auto_fanout_and_route',
    'pcb_auto_place_components', 'pcb_netlist_report', 'pcb_design_snapshot', 'pcb_design_diff',
    'sch_generate_from_netlist', 'sch_generate_from_pcb', 'pcb_eprj3_project_info',
  ],
  read: [
    'pcb_get_state', 'pcb_screenshot', 'pcb_get_tracks', 'pcb_get_pads', 'pcb_get_net_primitives',
    'pcb_get_board_info', 'pcb_get_feature_support', 'pcb_ping', 'pcb_get_silkscreens',
    'pcb_list_diff_pairs', 'pcb_list_equal_lengths', 'sch_get_state', 'sch_get_netlist', 'sch_run_drc',
    'pcb_run_drc', 'pcb_bridge_status', 'pcb_list_eda_windows', 'pcb_eprj3_project_info',
    'calc_impedance', 'calc_trace_width', 'pcb_net_connectivity_check', 'pcb_current_density_report',
    'pcb_component_clearance_check', 'pcb_design_health_report', 'pcb_netlist_report',
    'pcb_design_snapshot', 'pcb_design_diff',
  ],
  destructive: [
    // pcb_execute_code runs arbitrary JS inside the EDA extension sandbox;
    // the sch_generate_* pair OVERWRITES the schematic netlist; the deletes
    // and the board-wide auto tools destroy or rework design data unattended.
    'pcb_delete_selected', 'pcb_delete_tracks', 'pcb_delete_via', 'pcb_delete_pour',
    'pcb_delete_keepout', 'pcb_delete_diff_pair', 'pcb_delete_equal_length', 'pcb_execute_code',
    'sch_generate_from_netlist', 'sch_generate_from_pcb', 'pcb_auto_route_nets', 'pcb_drc_autofix',
    'pcb_auto_fanout_and_route', 'pcb_auto_place_components',
  ],
};

const FREECAD_POLICY: CadEdaPolicy = {
  id: 'freecad-mcp',
  serverName: 'trylo-freecad',
  appLabel: 'FreeCAD',
  tools: [
    'create_document', 'create_object', 'edit_object', 'delete_object', 'execute_code_async',
    'execute_code', 'get_view', 'insert_part_from_library', 'get_objects', 'get_object',
    'get_parts_list', 'reload_document', 'list_documents', 'get_rpc_status', 'run_fem_analysis',
  ],
  read: ['get_view', 'get_objects', 'get_object', 'get_parts_list', 'list_documents', 'get_rpc_status'],
  destructive: [
    // Raw exec() inside the FreeCAD host process, on the GUI thread or a
    // background thread — arbitrary code execution by design.
    'delete_object', 'execute_code', 'execute_code_async',
  ],
};

const BLENDER_POLICY: CadEdaPolicy = {
  id: 'blender-mcp',
  serverName: 'trylo-blender',
  appLabel: 'Blender',
  tools: [
    'get_addon_status', 'disable_telemetry', 'get_scene_info', 'get_object_info',
    'get_viewport_screenshot', 'execute_blender_code', 'get_polyhaven_categories',
    'search_polyhaven_assets', 'download_polyhaven_asset', 'set_texture', 'get_polyhaven_status',
    'get_hyper3d_status', 'get_sketchfab_status', 'search_sketchfab_models', 'get_sketchfab_model_preview',
    'download_sketchfab_model', 'get_polypizza_status', 'search_polypizza_models',
    'download_polypizza_model', 'generate_hyper3d_model_via_text', 'generate_hyper3d_model_via_images',
    'poll_rodin_job_status', 'import_generated_asset', 'get_hunyuan3d_status', 'generate_hunyuan3d_model',
    'poll_hunyuan_job_status', 'import_generated_asset_hunyuan', 'record_trajectory_feedback',
  ],
  read: [
    'get_addon_status', 'get_scene_info', 'get_object_info', 'get_viewport_screenshot',
    'get_polyhaven_categories', 'get_polyhaven_status', 'get_hyper3d_status', 'get_sketchfab_status',
    'get_polypizza_status', 'get_hunyuan3d_status',
  ],
  external: [
    // Asset catalogs, paid text/image-to-3D services and the telemetry
    // feedback recorder all leave loopback (record_trajectory_feedback posts
    // upstream; the pinned env keeps telemetry off, but the surface stays
    // classified by what it CAN do).
    'search_polyhaven_assets', 'download_polyhaven_asset', 'search_sketchfab_models',
    'get_sketchfab_model_preview', 'download_sketchfab_model', 'search_polypizza_models',
    'download_polypizza_model', 'generate_hyper3d_model_via_text', 'generate_hyper3d_model_via_images',
    'poll_rodin_job_status', 'generate_hunyuan3d_model', 'poll_hunyuan_job_status',
    'record_trajectory_feedback',
  ],
  destructive: [
    // Arbitrary Python execution inside Blender (opt-in upstream AST
    // allowlist exists but is not a security boundary).
    'execute_blender_code',
  ],
};

// ── partition validator (module-load invariant, registry style) ──────

interface CompiledPolicy extends CadEdaPolicy {
  readonly riskByTool: ReadonlyMap<string, ToolRiskClass>;
}

function compilePolicy(policy: CadEdaPolicy): CompiledPolicy {
  const riskByTool = new Map<string, ToolRiskClass>();
  const errors: string[] = [];
  const put = (tool: string, risk: ToolRiskClass) => {
    if (riskByTool.has(tool)) errors.push(`duplicate disposition for ${tool}`);
    riskByTool.set(tool, risk);
  };
  for (const tool of policy.read) put(tool, 'read');
  for (const tool of policy.external ?? []) put(tool, 'external');
  for (const tool of policy.sensitive ?? []) put(tool, 'sensitive');
  for (const tool of policy.destructive ?? []) put(tool, 'destructive');
  const pinned = new Set(policy.tools);
  // A disposition naming a tool the manifest does NOT pin is the dangerous
  // direction (a typo'd destructive list would be dead letter); a pinned
  // tool without an explicit disposition is the DOCUMENTED workspace-write
  // baseline, so it is reported but not fatal.
  for (const tool of riskByTool.keys()) {
    if (!pinned.has(tool)) errors.push(`disposition for unknown tool ${tool}`);
  }
  if (errors.length > 0) {
    throw new Error(
      `[CadEdaClassifier] policy partition violated for ${policy.id}:\n${errors.join('\n')}`,
    );
  }
  return { ...policy, riskByTool };
}

const COMPILED: readonly CompiledPolicy[] = [
  SOLIDWORKS_POLICY,
  AUTOCAD_POLICY,
  KICAD_POLICY,
  JLCEDA_POLICY,
  FREECAD_POLICY,
  BLENDER_POLICY,
].map(compilePolicy);

// ── decision engine (pure, synchronous — §6.2) ───────────────────────

function inputJsonLength(input: Readonly<Record<string, unknown>>): number {
  try {
    return JSON.stringify(input).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function buildAudit(
  context: ToolRiskContext,
  behavior: SafeAudit['behavior'],
  risk: SafeAudit['risk'],
  reasonCode: string,
): SafeAudit {
  return {
    at: context.at,
    profileId: context.profileId,
    packageId: context.packageId,
    toolName: context.toolName,
    behavior,
    risk,
    reasonCode,
    inputDigest: inputDigestOf(context.input),
    // CAD inputs carry document paths/coordinates, not project files; path
    // zoning arrives with the deliverable-validation pipeline (spec 后续项).
    pathZones: [],
  };
}

/** Redacted preview: app + tool + risk class. CAD payloads (coordinates,
 *  geometry parameters, embedded scripts) are NEVER echoed. */
export function buildCadEdaApprovalPreview(
  policy: { readonly appLabel: string },
  context: Pick<ToolRiskContext, 'toolName'>,
  risk: ToolRiskClass,
  reasonText?: string,
): ApprovalPreview {
  const shortName = context.toolName.split('__').pop() ?? context.toolName;
  return {
    kind: 'summary',
    title: `${policy.appLabel} 自动化`,
    target: shortName,
    reason: reasonText ?? riskLabel(risk),
  };
}

export function classifyCadEdaTool(policy: CompiledPolicy, context: ToolRiskContext): ToolRiskDecision {
  const shortName = context.toolName.split('__').pop() ?? context.toolName;
  // The router's exact-name gate has already admitted this tool against the
  // pinned surface, so a name the policy tables do not explicitly disposition
  // IS the documented workspace-write baseline (the tables only enumerate
  // read / external / sensitive / destructive).
  const risk: ToolRiskClass = policy.riskByTool.get(shortName) ?? 'workspace-write';

  const deny = (reasonCode: string, userMessage: string): ToolRiskDecision => ({
    behavior: 'deny',
    reasonCode,
    userMessage,
    audit: buildAudit(context, 'deny', null, reasonCode),
  });
  const autoAllow = (reasonCode: string, decidedRisk: 'read' | 'workspace-write'): ToolRiskDecision => ({
    behavior: 'auto_allow',
    risk: decidedRisk,
    reasonCode,
    audit: buildAudit(context, 'auto_allow', decidedRisk, reasonCode),
  });
  const prompt = (decidedRisk: 'external' | 'sensitive' | 'destructive', reasonCode: string, reasonText: string): ToolRiskDecision => ({
    behavior: 'prompt',
    risk: decidedRisk,
    reasonCode,
    preview: buildCadEdaApprovalPreview(policy, context, decidedRisk, reasonText),
    audit: buildAudit(context, 'prompt', decidedRisk, reasonCode),
  });

  // A tool the manifest pins but this policy does not name cannot happen —
  // the router's exact-name gate runs first and the fallback above is the
  // documented baseline. Nothing to fail closed on here.
  if (context.permissionLevel === 'unrestricted') {
    return autoAllow('unrestricted', risk === 'read' ? 'read' : 'workspace-write');
  }
  if (inputJsonLength(context.input) > MAX_INPUT_JSON_LENGTH) {
    return prompt('sensitive', 'input_too_large', '输入超过自动分类上限，需人工确认');
  }

  if (context.permissionLevel === 'read_only') {
    if (risk === 'read') return autoAllow('cad_read', 'read');
    return deny(
      'cad_denied_read_only',
      `Denied: this conversation is read-only. ${policy.appLabel} ${riskLabel(risk)}操作不可用.`,
    );
  }

  switch (risk) {
    case 'read':
      return autoAllow('cad_read', 'read');
    case 'workspace-write':
      // Document edits and deliverable exports (§6.3 matrix: auto at ≥ ask).
      return autoAllow('cad_write', 'workspace-write');
    case 'external':
      return prompt('external', 'cad_external_access', '该操作会访问外部网络服务，需要审批');
    case 'sensitive':
      return prompt('sensitive', 'cad_sensitive_operation', '该操作会启动/驱动宿主应用界面，需要审批');
    case 'destructive':
      return prompt('destructive', 'cad_destructive_operation', '破坏性操作（删除/覆盖/任意代码执行），需要审批');
  }
}

// ── the six registered classifiers ───────────────────────────────────

function classifierOf(policy: CompiledPolicy): PackageRiskClassifier {
  return {
    id: policy.id,
    serverName: policy.serverName,
    expectedTools: policy.tools.map((tool) => `mcp__${policy.serverName}__${tool}`),
    classify: (context) => classifyCadEdaTool(policy, context),
  };
}

const POLICY_BY_ID: ReadonlyMap<string, CompiledPolicy> = new Map(COMPILED.map((entry) => [entry.id, entry]));

function policyById(id: string): CompiledPolicy {
  const policy = POLICY_BY_ID.get(id);
  if (!policy) throw new Error(`[CadEdaClassifier] missing compiled policy for ${id}`);
  return policy;
}

export const solidworksClassifier: PackageRiskClassifier = classifierOf(policyById('solidworks-mcp'));
export const autocadClassifier: PackageRiskClassifier = classifierOf(policyById('autocad-mcp'));
export const kicadClassifier: PackageRiskClassifier = classifierOf(policyById('kicad-mcp'));
export const jlcedaClassifier: PackageRiskClassifier = classifierOf(policyById('jlceda-mcp'));
export const freecadClassifier: PackageRiskClassifier = classifierOf(policyById('freecad-mcp'));
export const blenderClassifier: PackageRiskClassifier = classifierOf(policyById('blender-mcp'));

/** The CAD/EDA classifiers, in profile order (App registration). */
export const CAD_EDA_CLASSIFIERS: readonly PackageRiskClassifier[] = [
  solidworksClassifier,
  autocadClassifier,
  kicadClassifier,
  jlcedaClassifier,
  freecadClassifier,
  blenderClassifier,
];

/** Test/inspection entry: classify through a REGISTERED classifier (the
 *  same object the router holds) by resolving its compiled policy. */
export function classifyWithClassifier(
  classifier: Pick<PackageRiskClassifier, 'id'>,
  context: ToolRiskContext,
): ToolRiskDecision {
  const compiled = POLICY_BY_ID.get(classifier.id);
  if (!compiled) {
    return {
      behavior: 'deny',
      reasonCode: 'unknown_package',
      userMessage: `Denied: no CAD/EDA policy for package '${classifier.id}'.`,
      audit: buildAudit(context, 'deny', null, 'unknown_package'),
    };
  }
  return classifyCadEdaTool(compiled, context);
}

/** Safe preview for any CAD/EDA tool from its FULL `mcp__<server>__<tool>`
 *  name (approval-preview PARSERS registration). Redaction-first: geometry
 *  parameters, coordinates and embedded scripts are NEVER echoed. */
export function buildCadEdaApprovalPreviewForTool(toolName: string): ApprovalPreview {
  const shortName = toolName.split('__').pop() ?? toolName;
  const policy = COMPILED.find((entry) => toolName.startsWith(`mcp__${entry.serverName}__`));
  return {
    kind: 'summary',
    title: `${policy?.appLabel ?? 'CAD/EDA'} 自动化`,
    target: shortName,
    reason: 'CAD/EDA 自动化操作（参数不回显）',
  };
}

export default CAD_EDA_CLASSIFIERS;
