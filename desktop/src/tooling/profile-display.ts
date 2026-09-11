// Trylo Desktop — human-readable Tool Profile display for the Work composer.
//
// WHY this file exists: the active Tool Profile (which MCP servers a run
// can see) is chosen by settings toggles and is otherwise invisible —
// users cannot tell which tool set the current conversation runs with.
// The composer chip reads from here.
//
// Source of truth for the composition itself is
// `desktop-services/src/tooling/tool-profile-service.mjs` (TOOL_PROFILES).
// This module is a DISPLAY mirror: profile id → short label + expected
// server list. If the composition changes there, update the table below
// (the test pins every profile id so drift fails loudly).
//
// NOTE: the list is EXPECTED servers. A missing host application degrades
// to an unavailable capability at resolve time (§4.4), so the live set can
// be smaller — the chip says "expected", never "live".

export interface ToolProfileDisplay {
  /** Short chip label, e.g. "CAD". */
  readonly label: string
  /** Full profile id, e.g. "work.cad.v1". Shown in the popover + tooltip. */
  readonly profileId: string
  /** Expected MCP server names for this profile. */
  readonly servers: readonly string[]
}

const TABLE: Readonly<Record<string, ToolProfileDisplay>> = {
  'work.core.v1': {
    label: '办公',
    profileId: 'work.core.v1',
    servers: ['trylo-office', 'trylo-browser', 'trylo-windows'],
  },
  'work.browser-debug.v1': {
    label: '浏览器调试',
    profileId: 'work.browser-debug.v1',
    servers: ['trylo-office', 'trylo-chrome'],
  },
  'work.cad.v1': {
    label: 'CAD',
    profileId: 'work.cad.v1',
    servers: [
      'trylo-solidworks',
      'trylo-autocad',
      'trylo-kicad',
      'trylo-jlceda',
      'trylo-freecad',
      'trylo-blender',
      'trylo-windows',
      'trylo-office',
    ],
  },
}

/** Hermes adapter: composed alongside every profile, not part of any
 *  profile's package list. Stated once in the popover footer. */
export const ALWAYS_MOUNTED_SERVER = 'trylo-hermes-capabilities'

/** Resolve display info for a profile id. Unknown/empty ids fall back to
 *  the surface default (work.core.v1) so the chip never renders blank. */
export function describeToolProfile(profileId: string | null | undefined): ToolProfileDisplay {
  if (profileId) {
    const known = TABLE[profileId]
    if (known) return known
  }
  return TABLE['work.core.v1']!
}
