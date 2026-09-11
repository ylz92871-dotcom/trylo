// Pure composer draft functions (Foundation spec §10.4).
//
// No React, no fs. The draft's module-singleton home is
// `composer-draft.ts` so a CollaborationSwitch flip mid-edit keeps the
// work (Pitfall 18). `App.tsx` never holds composer state.
//
// surfaces must not import user-learning (spec §7.6.2): types come from
// the locked mirror `../team-profile-types`, and the structural checks
// here only POWER THE DISABLED REASON. The authoritative validation
// before freeze is user-learning's `validateProfile` in host-launch —
// a smuggled invalid profile still fails the launch (`invalid_profile`).

import {
  ALLOWLIST_EXTRAS,
  MAX_MEMBERS_PER_PROFILE,
  MAX_WORKERS_PER_PROFILE,
  SKILL_TOOL_NAME,
  TEAM_ROLE_DISPLAY_NAME,
  TEAM_ROLE_FLOOR_TOOLS,
  TEAM_SPAWN_TOOLS,
  TEAM_WRITE_TOOLS,
  roleWrites,
  type TeamMemberOverlay,
  type TeamMemberSpec,
  type TeamProfile,
  type TeamProfileSurface,
  type TeamRoleId,
} from '../team-profile-types';

/**
 * The inspector's attenuation PREVIEW. Mirrors the CLI merge order
 * (Foundation spec §7.4) on the mirror floors; `composer-store.test.ts`
 * cross-checks it against user-learning's authoritative
 * `applyMemberOverlayPreview` so the two can never drift (Pitfall 8).
 */
export interface MemberOverlayPreview {
  readonly resolvedModel: string;
  readonly toolsApplied: readonly string[];
  readonly skillsDropped: readonly string[];
  readonly writes: boolean;
  readonly independence: 'none' | 'review' | 'verify';
  readonly canSpawn: false;
}

export function previewMemberOverlay(member: TeamMemberSpec): MemberOverlayPreview {
  const floorTools = TEAM_ROLE_FLOOR_TOOLS[member.baseRole];
  const writes = roleWrites(member.baseRole);
  const allowedUniverse = new Set<string>([...floorTools, ...ALLOWLIST_EXTRAS[member.baseRole]]);
  let tools = (member.overlay.tools ?? floorTools).filter((t) => allowedUniverse.has(t));
  const denied = new Set<string>([
    ...TEAM_SPAWN_TOOLS,
    ...(writes ? [] : TEAM_WRITE_TOOLS),
    ...(member.overlay.disallowedTools ?? []),
  ]);
  tools = tools.filter((t) => !denied.has(t));
  let skillsDropped: string[] = [];
  if (!writes) skillsDropped = [...member.overlay.skills];
  if (member.overlay.skills.length === 0 || !writes) {
    tools = tools.filter((t) => t !== SKILL_TOOL_NAME);
  }
  return {
    resolvedModel: member.overlay.model || 'inherit',
    toolsApplied: [...tools],
    skillsDropped,
    writes,
    independence: member.baseRole === 'reviewer' ? 'review' : member.baseRole === 'verifier' ? 'verify' : 'none',
    canSpawn: false,
  };
}

export interface ComposerDraft {
  /** Builtin template the draft came from, 'custom' for a blank sheet. */
  readonly templateId: string;
  readonly origin: 'builtin' | 'custom';
  /** Set when editing an existing saved custom profile. */
  readonly profileId: string | null;
  readonly surface: TeamProfileSurface;
  /** Editable team title (≤ 24 chars, §7.3). */
  readonly title: string;
  /** The run goal — the only free text the launch sends. */
  readonly goal: string;
  readonly members: readonly TeamMemberSpec[];
  readonly selectedMemberId: string | null;
}

export interface ModelChoice {
  readonly value: string;
  readonly label: string;
}

export const INHERIT_MODEL_CHOICE: ModelChoice = { value: 'inherit', label: 'Inherit' };

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function draftFromProfile(
  profile: TeamProfile,
  overrides: Partial<ComposerDraft> = {},
): ComposerDraft {
  return {
    templateId: profile.id,
    origin: profile.origin,
    profileId: profile.origin === 'custom' ? profile.id : null,
    surface: profile.surface,
    title: profile.title,
    goal: '',
    members: profile.members.map((m) => ({ ...m, overlay: { ...m.overlay } })),
    selectedMemberId: null,
    ...overrides,
  };
}

/** 「自定义」 opens a blank composer preset with Person + Worker (§7.5). */
export function blankCustomDraft(surface: TeamProfileSurface): ComposerDraft {
  return {
    templateId: 'custom',
    origin: 'custom',
    profileId: null,
    surface,
    title: '自定义团队',
    goal: '',
    members: [
      { memberId: uuid(), baseRole: 'person', displayName: TEAM_ROLE_DISPLAY_NAME.person, overlay: emptyMemberOverlay() },
      { memberId: uuid(), baseRole: 'worker', displayName: TEAM_ROLE_DISPLAY_NAME.worker, overlay: emptyMemberOverlay() },
    ],
    selectedMemberId: null,
  };
}

export function setGoal(draft: ComposerDraft, goal: string): ComposerDraft {
  return { ...draft, goal };
}

export function setTitle(draft: ComposerDraft, title: string): ComposerDraft {
  return { ...draft, title };
}

export function setSelectedMember(draft: ComposerDraft, memberId: string | null): ComposerDraft {
  if (draft.selectedMemberId === memberId) return draft;
  return { ...draft, selectedMemberId: memberId };
}

/** Roles the add-menu may still offer (§10.4: Person fixed, A/R/V ≤ 1, W ≤ 2). */
export function addableRoles(draft: ComposerDraft): readonly TeamRoleId[] {
  const counts = new Map<TeamRoleId, number>();
  for (const m of draft.members) counts.set(m.baseRole, (counts.get(m.baseRole) ?? 0) + 1);
  const addable: TeamRoleId[] = [];
  for (const role of ['architect', 'worker', 'reviewer', 'verifier'] as const) {
    const cap = role === 'worker' ? MAX_WORKERS_PER_PROFILE : 1;
    if ((counts.get(role) ?? 0) < cap) addable.push(role);
  }
  return addable;
}

export function addMember(draft: ComposerDraft, baseRole: TeamRoleId): ComposerDraft {
  if (!addableRoles(draft).includes(baseRole)) return draft;
  if (draft.members.length >= MAX_MEMBERS_PER_PROFILE) return draft;
  const workerCount = draft.members.filter((m) => m.baseRole === 'worker').length;
  const next: TeamMemberSpec = {
    memberId: uuid(),
    baseRole,
    displayName:
      baseRole === 'worker' && workerCount === 1
        ? `${TEAM_ROLE_DISPLAY_NAME.worker} · 2`
        : TEAM_ROLE_DISPLAY_NAME[baseRole],
    overlay: extraWriterOverlay(baseRole, workerCount),
  };
  return { ...draft, members: [...draft.members, next], selectedMemberId: next.memberId };
}

/** Person is not removable (§10.4); every other member is. */
export function removeMember(draft: ComposerDraft, memberId: string): ComposerDraft {
  const target = draft.members.find((m) => m.memberId === memberId);
  if (!target || target.baseRole === 'person') return draft;
  const members = draft.members.filter((m) => m.memberId !== memberId);
  return {
    ...draft,
    members,
    selectedMemberId: draft.selectedMemberId === memberId ? null : draft.selectedMemberId,
  };
}

export function renameMember(draft: ComposerDraft, memberId: string, displayName: string): ComposerDraft {
  return {
    ...draft,
    members: draft.members.map((m) => (m.memberId === memberId ? { ...m, displayName } : m)),
  };
}

export function patchOverlay(
  draft: ComposerDraft,
  memberId: string,
  patch: Partial<TeamMemberOverlay>,
): ComposerDraft {
  return {
    ...draft,
    members: draft.members.map((m) =>
      m.memberId === memberId ? { ...m, overlay: { ...m.overlay, ...patch } } : m),
  };
}

function emptyMemberOverlay(): TeamMemberOverlay {
  return { model: 'inherit', skills: [], systemPromptOverlay: '' };
}

/** Extra workers default to read-only so two people don't write the same tree. */
function extraWriterOverlay(baseRole: TeamRoleId, existingWorkers: number): TeamMemberOverlay {
  if (baseRole === 'worker' && existingWorkers >= 1) {
    return { ...emptyMemberOverlay(), disallowedTools: [...TEAM_WRITE_TOOLS] };
  }
  return emptyMemberOverlay();
}

export function attenuateExtraWriters(members: readonly TeamMemberSpec[]): readonly TeamMemberSpec[] {
  let workerIndex = 0;
  return members.map((member) => {
    if (member.baseRole !== 'worker') return member;
    const index = workerIndex;
    workerIndex += 1;
    if (index === 0) return member;
    const denied = new Set([...(member.overlay.disallowedTools ?? []), ...TEAM_WRITE_TOOLS]);
    return { ...member, overlay: { ...member.overlay, disallowedTools: [...denied] } };
  });
}

/**
 * Idle rows derived from full profiles (§10.3): one row per profile,
 * roster shown as role display names. App passes builtin + custom
 * profiles; surfaces never import user-learning to get them.
 */
export function idleRowsFromProfiles(
  profiles: readonly TeamProfile[],
): readonly { readonly id: string; readonly title: string; readonly roster: string }[] {
  return profiles.map((p) => ({
    id: p.id,
    title: p.title,
    roster: p.members
      .map((m) => TEAM_ROLE_DISPLAY_NAME[m.baseRole] ?? m.baseRole)
      .join(' · '),
  }));
}

/** Review-only shape: a reviewer, no worker. Launch and the composer
 *  footer both treat this as `allowNoWorker` — including a saved custom
 *  copy of the builtin 只审 template, whose `templateId` is no longer
 *  `review-only`. */
export function rosterAllowsNoWorker(
  members: readonly { readonly baseRole: string }[],
): boolean {
  return members.some((m) => m.baseRole === 'reviewer')
    && !members.some((m) => m.baseRole === 'worker');
}

/**
 * UI-side structural check (§7.3). Mirrors the canonical rules for the
 * footer reason only — the freeze gate re-validates canonically.
 */
export function draftStructuralError(
  draft: ComposerDraft,
  options: { readonly allowNoWorker: boolean },
): string {
  const members = draft.members;
  if (members.length === 0) return '至少需要 Person 成员';
  if (members.length > MAX_MEMBERS_PER_PROFILE) return `成员最多 ${MAX_MEMBERS_PER_PROFILE} 个`;
  if (draft.title.trim().length === 0) return '团队名称不能为空';
  if (draft.title.length > 24) return '团队名称最多 24 个字符';
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.memberId)) return '成员 id 重复';
    seen.add(m.memberId);
  }
  if (members.filter((m) => m.baseRole === 'person').length !== 1) return '组队必须恰好有一个 Person';
  if (members[0]?.baseRole !== 'person') return 'Person 必须排在第一位';
  for (const role of ['architect', 'reviewer', 'verifier'] as const) {
    if (members.filter((m) => m.baseRole === role).length > 1) return `${role} 最多 1 个`;
  }
  const workers = members.filter((m) => m.baseRole === 'worker').length;
  if (workers > MAX_WORKERS_PER_PROFILE) return `Worker 最多 ${MAX_WORKERS_PER_PROFILE} 个`;
  if (workers === 0 && !options.allowNoWorker) return '需要一个 Worker，或改用只审模板';
  for (const m of members) {
    if (m.displayName.length > 24) return `显示名最多 24 个字符：${m.displayName}`;
    if (m.overlay.systemPromptOverlay.length > 2000) return `${m.displayName} 的提示 overlay 超过 2000 字`;
  }
  return '';
}

/**
 * The footer gate (§10.4): 开始 always renders; enabled only when the
 * flags are live, the goal is non-empty, the draft validates and there
 * is no in-flight launch. Otherwise disabled WITH its reason string.
 */
export function startGate(
  draft: ComposerDraft,
  ctx: {
    readonly composerLive: boolean;
    readonly allowNoWorker: boolean;
    readonly inFlight?: boolean;
  },
): { readonly enabled: boolean; readonly reason: string } {
  if (ctx.inFlight) return { enabled: false, reason: '正在开始这场团队…' };
  if (!ctx.composerLive) {
    return { enabled: false, reason: '在设置里打开 Team 后才能开始' };
  }
  if (draft.goal.trim().length === 0) return { enabled: false, reason: '缺少目标' };
  const structural = draftStructuralError(draft, ctx);
  if (structural) return { enabled: false, reason: structural };
  return { enabled: true, reason: '' };
}

/** Build a storable/launchable profile snapshot from the draft. */
export function buildProfileFromDraft(draft: ComposerDraft, now: number): TeamProfile {
  return {
    schemaVersion: 1,
    id: draft.profileId ?? uuid(),
    origin: 'custom',
    surface: draft.surface,
    title: draft.title,
    createdAt: now,
    updatedAt: now,
    members: attenuateExtraWriters(draft.members).map((m) => ({ ...m, overlay: { ...m.overlay } })),
  };
}

/**
 * The model picker is NOT a marketing grid (spec §4.4): Inherit, the
 * current main model, and only non-primary vision/summary sub-models.
 * `usePrimaryConnection === true` sub-connections are NOT listed.
 */
export function teamModelChoices(settings: {
  readonly apiModel: string;
  readonly poolModel?: string;
  readonly vision?: { readonly usePrimaryConnection: boolean; readonly model?: string };
  readonly summary?: { readonly usePrimaryConnection: boolean; readonly model?: string };
}): readonly ModelChoice[] {
  const main = settings.poolModel || settings.apiModel;
  const choices: ModelChoice[] = [{ value: 'inherit', label: 'Inherit（跟随 Person 当前模型）' }];
  if (main) choices.push({ value: main, label: `当前主模型 · ${main}` });
  const extra = (
    conn: { readonly usePrimaryConnection: boolean; readonly model?: string } | undefined,
    label: string,
  ): void => {
    if (!conn || conn.usePrimaryConnection || !conn.model) return;
    if (conn.model === main) return;
    choices.push({ value: conn.model, label: `${label} · ${conn.model}` });
  };
  extra(settings.vision, 'Vision');
  extra(settings.summary, 'Summary');
  return choices;
}

