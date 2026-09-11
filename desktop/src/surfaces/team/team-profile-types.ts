// Surfaces-side mirror of the TeamProfile shapes (Foundation spec §7.7).
//
// `user-learning` must not import `surfaces`, and `surfaces` must not
// import user-learning — so the UI re-states the profile field names
// here and `team-profile-types.lock.test.ts` keeps the two copies
// field-identical (same pattern as seats / engineering-contract).

export type TeamProfileSurface = 'code' | 'work';
export type TeamProfileOrigin = 'builtin' | 'custom';

export type TeamRoleId =
  | 'person'
  | 'architect'
  | 'worker'
  | 'reviewer'
  | 'verifier'
  | 'cad-planner'
  | 'cad-verifier';

export type TeamMemberId = string;

export interface TeamMemberOverlay {
  readonly model: 'inherit' | string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly skills: readonly string[];
  readonly systemPromptOverlay: string;
}

export interface TeamMemberSpec {
  readonly memberId: TeamMemberId;
  readonly baseRole: TeamRoleId;
  readonly displayName: string;
  readonly overlay: TeamMemberOverlay;
}

export interface TeamProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly origin: TeamProfileOrigin;
  readonly surface: TeamProfileSurface;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly members: readonly TeamMemberSpec[];
}

export const DISPLAY_NAME_MAX_CHARS = 24;
export const OVERLAY_PROMPT_MAX_CHARS = 2000;
export const MAX_MEMBERS_PER_PROFILE = 6;
export const MAX_WORKERS_PER_PROFILE = 2;

export const TEAM_ROLE_DISPLAY_NAME: Record<TeamRoleId, string> = {
  person: '代表你',
  architect: '架构',
  worker: '动手',
  reviewer: '审查',
  verifier: '验收',
  'cad-planner': 'CAD 规划',
  'cad-verifier': 'CAD 验收',
};

export const TEAM_ROLE_DUTY: Record<TeamRoleId, string> = {
  person: '卡住时问你，不自己改代码',
  architect: '先定边界，自己不改代码',
  worker: '真正动手改',
  reviewer: '独立审，不能被叫过',
  verifier: '独立验，不能被叫过',
  'cad-planner': '冻结施工包，不建模',
  'cad-verifier': '按断言表独立验收，不能被叫过',
};

// ── Tool floors (Appendix A mirror; CLI is authoritative at spawn) ──

export const TEAM_READ_TOOLS = ['Read', 'Grep', 'Glob', 'LSP'] as const;
export const TEAM_SHELL_TOOLS = ['Bash', 'PowerShell'] as const;
export const TEAM_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;
export const TEAM_SPAWN_TOOLS = ['Agent', 'ExitPlanMode'] as const;
export const TEAM_RESEARCH_TOOLS = ['WebFetch', 'WebSearch'] as const;
export const TEAM_META_TOOLS = ['TodoWrite'] as const;
export const SKILL_TOOL_NAME = 'Skill';

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

export function roleWrites(baseRole: TeamRoleId): boolean {
  return baseRole === 'worker' || baseRole === 'cad-planner' || baseRole === 'cad-verifier';
}

export function roleIndependence(baseRole: TeamRoleId): 'none' | 'review' | 'verify' {
  if (baseRole === 'reviewer') return 'review';
  if (baseRole === 'verifier' || baseRole === 'cad-verifier') return 'verify';
  return 'none';
}

/** v0 allowlist extras (spec §7.4): worker may add research tools. */
export const ALLOWLIST_EXTRAS: Readonly<Record<TeamRoleId, readonly string[]>> = {
  person: [],
  architect: [],
  worker: [...TEAM_RESEARCH_TOOLS],
  reviewer: [],
  verifier: [],
  'cad-planner': [],
  'cad-verifier': [],
};
