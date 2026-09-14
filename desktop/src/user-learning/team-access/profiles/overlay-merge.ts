// Desktop-side member overlay merge (Foundation spec §7.4).
//
// This is the PREVIEW twin of the CLI attenuator
// (`trylo cli/src/tools/AgentTool/team-roster/overlay.ts`). The CLI is
// authoritative at spawn time; this module powers the composer
// inspector (toolsApplied / skillsDropped / resolvedModel) so the UI
// never guesses what the floor will do. The attenuation ORDER must
// stay byte-compatible with the CLI implementation — both are locked
// by tests (Pitfall 8 / §6.3).
import { sourceHash } from '../../ids';
import {
  ALLOWLIST_EXTRAS,
  OVERLAY_PROMPT_MAX_CHARS,
  SKILL_TOOL_NAME,
  TEAM_ROLE_FLOOR_TOOLS,
  TEAM_SPAWN_TOOLS,
  TEAM_WRITE_TOOLS,
  WORK_OFFICECLI_TOOL_NAME,
  roleIndependence,
  roleWrites,
  type TeamMemberOverlay,
  type TeamMemberSpec,
  type TeamRoleId,
} from './profile-types';

export interface OverlayMergePreview {
  readonly memberId: string;
  readonly baseRole: TeamRoleId;
  /** Model the CLI will run: 'inherit' or the overlay model id. */
  readonly resolvedModel: 'inherit' | string;
  readonly toolsApplied: readonly string[];
  readonly disallowed: readonly string[];
  readonly skills: readonly string[];
  readonly skillsDropped: readonly string[];
  /** Overlay text after the 2000-char cap (what the CLI appends). */
  readonly systemPromptOverlay: string;
  readonly overlayHash: string;
  // Floor facts an overlay can never change (spec §7.4 rule 7).
  readonly writes: boolean;
  readonly independence: 'none' | 'review' | 'verify';
  readonly canSpawn: false;
}

function intersect(a: readonly string[], b: ReadonlySet<string>): string[] {
  return a.filter((t) => b.has(t));
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Attenuate a role floor by one member overlay. Only-attenuate: the
 * result can remove tools/skills, never add beyond the tiny per-role
 * allowlist, and spawn/write floors are re-denied unconditionally.
 */
export function applyMemberOverlayPreview(
  member: Pick<TeamMemberSpec, 'memberId' | 'baseRole' | 'overlay'>,
): OverlayMergePreview {
  const { memberId, baseRole } = member;
  const overlay: TeamMemberOverlay = member.overlay;
  const floorTools = TEAM_ROLE_FLOOR_TOOLS[baseRole];
  const writes = roleWrites(baseRole);

  // 1. agentType stays baseRole; 2. model.
  const resolvedModel = overlay.model || 'inherit';

  // 3. tools: overlay allowlist ∩ (floor ∪ allowlist extras).
  const allowedUniverse = new Set<string>([
    ...floorTools,
    ...ALLOWLIST_EXTRAS[baseRole],
  ]);
  const selected = overlay.tools ?? floorTools;
  let tools = intersect(selected, allowedUniverse);

  // 4. disallowed = floor hard gates ∪ overlay denials ∪ spawn deny.
  const disallowed = uniq([
    ...TEAM_SPAWN_TOOLS,
    ...(writes ? [] : TEAM_WRITE_TOOLS),
    ...(writes ? [] : [WORK_OFFICECLI_TOOL_NAME]),
    ...(overlay.disallowedTools ?? []),
  ]);
  tools = tools.filter((t) => !disallowed.includes(t));

  // 5. skills — fail closed (spec §11.3): read-only roles drop ALL
  //    skills and the Skill tool; an empty worker list drops the tool.
  let skillsDropped: string[] = [];
  let skills: readonly string[] = [];
  if (writes) {
    skills = overlay.skills ?? [];
    if (skills.length === 0) tools = tools.filter((t) => t !== SKILL_TOOL_NAME);
  } else {
    skillsDropped = [...(overlay.skills ?? [])];
    tools = tools.filter((t) => t !== SKILL_TOOL_NAME);
  }

  // 6. overlay prompt capped at 2000 chars; text grants nothing.
  const systemPromptOverlay = overlay.systemPromptOverlay.slice(0, OVERLAY_PROMPT_MAX_CHARS);

  return {
    memberId,
    baseRole,
    resolvedModel,
    toolsApplied: [...tools],
    disallowed,
    skills: [...skills],
    skillsDropped,
    systemPromptOverlay,
    overlayHash: sourceHash([memberId, baseRole, JSON.stringify(overlay)]),
    writes,
    independence: roleIndependence(baseRole),
    canSpawn: false,
  };
}
