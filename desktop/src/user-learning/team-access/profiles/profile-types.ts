// Canonical TeamProfile types (Foundation spec §7.3 / §7.4 / §9.1).
//
// This file is the SOURCE OF TRUTH for profile shapes. Surfaces mirror
// the fields in `surfaces/team/team-profile-types.ts` (user-learning
// must not import surfaces, so the mirror is a copy locked by a test);
// the CLI copies the overlay fields into `team-roster/overlay.ts`.
// All three copies are field-locked by colocated tests (Pitfall 8).

export type TeamProfileOrigin = 'builtin' | 'custom';
export type TeamProfileSurface = 'code' | 'work';

/**
 * The canonical roles = the CLI `TryloTeamSeatId` union. Roles are
 * the safety floor; instances are uuids. `cad-planner` / `cad-verifier`
 * ride the Work-surface roster (SolidWorks MCP) and are inert on Code.
 */
export type TeamRoleId =
  | 'person'
  | 'architect'
  | 'worker'
  | 'reviewer'
  | 'verifier'
  | 'cad-planner'
  | 'cad-verifier';

export const TEAM_ROLE_IDS: readonly TeamRoleId[] = [
  'person',
  'architect',
  'worker',
  'reviewer',
  'verifier',
  'cad-planner',
  'cad-verifier',
];

/** Member instance id (uuid v4 on Desktop; builtin templates use stable ids). */
export type TeamMemberId = string;

/**
 * Per-instance attenuation + copy. Defaults: model 'inherit', tools
 * undefined (= full role floor), skills [] (= none), overlay ''.
 * `independence`, `writes`, `isolation`, `canSpawn` are NOT here and
 * can never be here (spec §7.4 rule 7).
 */
export interface TeamMemberOverlay {
  /** 'inherit' (default) = the Personal Agent's current effective model
   *  (`poolModel || apiModel`). Otherwise a host-known model id string. */
  readonly model: 'inherit' | string;
  /** Allowlist ∩ role floor; undefined = the floor unchanged. */
  readonly tools?: readonly string[];
  /** Extra denials; always unioned with the role floor's hard gates. */
  readonly disallowedTools?: readonly string[];
  /** Skill names to preload. Empty = no skills (Worker floor drops the
   *  Skill tool). Read-only roles always drop all skills. */
  readonly skills: readonly string[];
  /** Appended AFTER the role preamble. Cap 2000 chars. Grants nothing. */
  readonly systemPromptOverlay: string;
}

export function emptyMemberOverlay(): TeamMemberOverlay {
  return { model: 'inherit', skills: [], systemPromptOverlay: '' };
}

export interface TeamMemberSpec {
  readonly memberId: TeamMemberId;
  /** The role floor. The CLI `agentType` always equals this. */
  readonly baseRole: TeamRoleId;
  /** ≤ 24 chars. Second worker defaults to `Worker · 2`. */
  readonly displayName: string;
  readonly overlay: TeamMemberOverlay;
}

export interface TeamProfile {
  readonly schemaVersion: 1;
  /** builtin: 'small-change'…; custom: uuid. */
  readonly id: string;
  readonly origin: TeamProfileOrigin;
  readonly surface: TeamProfileSurface;
  /** ≤ 24 chars. */
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly members: readonly TeamMemberSpec[];
}

/** `.trylo/team-profiles.json` — custom profiles only; builtins live in
 *  code and a same-id disk entry never overrides them (spec §7.5). */
export interface TeamProfilesFile {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly profiles: readonly TeamProfile[];
}

// ── Quantified budgets (spec §7.4 / §9.5) ──────────────────────────

export const OVERLAY_PROMPT_MAX_CHARS = 2000;
/** Write-fail sibling tag only (spec §8.4). */
export const OVERLAY_FALLBACK_PROMPT_MAX_CHARS = 400;
export const MAX_MEMBERS_PER_PROFILE = 6;
export const MAX_CUSTOM_PROFILES = 16;
export const MAX_WORKERS_PER_PROFILE = 2;
export const DISPLAY_NAME_MAX_CHARS = 24;

/** Tool groups shared with the CLI roster (Appendix A). Plain strings —
 *  the CLI constants live behind the build boundary. */
export const TEAM_READ_TOOLS = ['Read', 'Grep', 'Glob', 'LSP'] as const;
export const TEAM_SHELL_TOOLS = ['Bash', 'PowerShell'] as const;
export const TEAM_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;
export const TEAM_SPAWN_TOOLS = ['Agent', 'ExitPlanMode'] as const;
export const TEAM_RESEARCH_TOOLS = ['WebFetch', 'WebSearch'] as const;
export const TEAM_META_TOOLS = ['TodoWrite'] as const;
export const SKILL_TOOL_NAME = 'Skill';
export const WORK_OFFICECLI_TOOL_NAME = 'OfficeCLI';

/**
 * Role tool floors, mirrored from the Code roster (Appendix A). The Work
 * surface differs by the CLI's own floor (`OfficeCLI` instead of file
 * writes + `Playwright` flavors); this mirror only powers the Desktop
 * inspector preview — the CLI floor is authoritative at spawn time.
 */
export const TEAM_ROLE_FLOOR_TOOLS: Readonly<Record<TeamRoleId, readonly string[]>> = {
  person: [...TEAM_READ_TOOLS],
  architect: [...TEAM_READ_TOOLS, ...TEAM_RESEARCH_TOOLS, ...TEAM_SHELL_TOOLS],
  worker: [
    ...TEAM_READ_TOOLS,
    ...TEAM_SHELL_TOOLS,
    ...TEAM_WRITE_TOOLS,
    ...TEAM_META_TOOLS,
    SKILL_TOOL_NAME,
  ],
  reviewer: [...TEAM_READ_TOOLS],
  verifier: [...TEAM_READ_TOOLS],
  'cad-planner': [...TEAM_READ_TOOLS, ...TEAM_WRITE_TOOLS, SKILL_TOOL_NAME],
  'cad-verifier': [...TEAM_READ_TOOLS, ...TEAM_WRITE_TOOLS],
};

/** Roles that may write project files (CAD seats write only their own
 *  plan/verdict documents; the CLI path guard constrains where). */
export function roleWrites(baseRole: TeamRoleId): boolean {
  return baseRole === 'worker' || baseRole === 'cad-planner' || baseRole === 'cad-verifier';
}

/** Independence of the role floor; never overridable by an overlay. */
export function roleIndependence(baseRole: TeamRoleId): 'none' | 'review' | 'verify' {
  if (baseRole === 'reviewer') return 'review';
  if (baseRole === 'verifier' || baseRole === 'cad-verifier') return 'verify';
  return 'none';
}

/** v0 allowlist extras (spec §7.4): worker may add research tools.
 *  Every other role gets nothing — write/spawn can never be re-added. */
export const ALLOWLIST_EXTRAS: Readonly<Record<TeamRoleId, readonly string[]>> = {
  person: [],
  architect: [],
  worker: [...TEAM_RESEARCH_TOOLS],
  reviewer: [],
  verifier: [],
  'cad-planner': [],
  'cad-verifier': [],
};

export const TEAM_ROLE_DISPLAY_NAME: Record<TeamRoleId, string> = {
  person: '代表你',
  architect: '架构',
  worker: '动手',
  reviewer: '审查',
  verifier: '验收',
  'cad-planner': 'CAD 规划',
  'cad-verifier': 'CAD 验收',
};
