// TeamProfile validation (Foundation spec §7.3).
//
// Pure function shared by the composer (live reasons under the disabled
// 开始) and by host-launch (freeze gate). No React, no fs, no clock.

import {
  DISPLAY_NAME_MAX_CHARS,
  MAX_MEMBERS_PER_PROFILE,
  MAX_WORKERS_PER_PROFILE,
  OVERLAY_PROMPT_MAX_CHARS,
  TEAM_ROLE_IDS,
  type TeamMemberOverlay,
  type TeamMemberSpec,
  type TeamProfile,
} from './profile-types';

export interface ProfileValidationOptions {
  /** `review-only` lineups have no worker; composer passes true when the
   *  draft came from that template (spec §7.5). Default false: a saveable
   *  profile needs at least one worker. */
  readonly allowNoWorker?: boolean;
}

export type ProfileValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRole(value: unknown): value is TeamMemberSpec['baseRole'] {
  return typeof value === 'string' && (TEAM_ROLE_IDS as readonly string[]).includes(value);
}

function countByRole(members: readonly TeamMemberSpec[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of members) counts[m.baseRole] = (counts[m.baseRole] ?? 0) + 1;
  return counts;
}

/** Structural + policy validation. `validateProfile` is the ONLY gate —
 *  composer and launch must not re-implement it. */
export function validateProfile(
  profile: Pick<TeamProfile, 'members' | 'title'>,
  options: ProfileValidationOptions = {},
): ProfileValidationResult {
  const errors: string[] = [];
  const members = profile.members;

  if (members.length === 0) {
    return { ok: false, errors: ['至少需要 Person 成员'] };
  }
  if (members.length > MAX_MEMBERS_PER_PROFILE) {
    errors.push(`成员最多 ${MAX_MEMBERS_PER_PROFILE} 个`);
  }
  if (profile.title.length === 0) {
    errors.push('团队名称不能为空');
  }
  if (profile.title.length > DISPLAY_NAME_MAX_CHARS) {
    errors.push(`团队名称最多 ${DISPLAY_NAME_MAX_CHARS} 个字符`);
  }

  const seenIds = new Set<string>();
  for (const m of members) {
    if (seenIds.has(m.memberId)) errors.push(`成员 id 重复：${m.memberId}`);
    seenIds.add(m.memberId);
  }

  const counts = countByRole(members);
  // Exactly one person, and it is first.
  if (counts['person'] !== 1) {
    errors.push('组队必须恰好有一个 Person');
  }
  if (members[0]?.baseRole !== 'person') {
    errors.push('Person 必须排在第一位');
  }
  for (const role of ['architect', 'reviewer', 'verifier'] as const) {
    const n = counts[role] ?? 0;
    if (n > 1) errors.push(`${role} 最多 1 个`);
  }
  const workers = counts['worker'] ?? 0;
  if (workers > MAX_WORKERS_PER_PROFILE) {
    errors.push(`Worker 最多 ${MAX_WORKERS_PER_PROFILE} 个`);
  }
  if (workers === 0 && options.allowNoWorker !== true) {
    errors.push('需要一个 Worker，或改用只审模板');
  }

  for (const m of members) {
    if (!isRole(m.baseRole)) {
      errors.push(`未知角色：${String(m.baseRole)}`);
      continue;
    }
    if (m.displayName.length > DISPLAY_NAME_MAX_CHARS) {
      errors.push(`显示名最多 ${DISPLAY_NAME_MAX_CHARS} 个字符：${m.displayName}`);
    }
    const overlay = m.overlay;
    if (overlay.systemPromptOverlay.length > OVERLAY_PROMPT_MAX_CHARS) {
      errors.push(`${m.displayName} 的提示 overlay 超过 ${OVERLAY_PROMPT_MAX_CHARS} 字`);
    }
    if ('independence' in overlay) {
      errors.push('overlay 不能包含 independence');
    }
    if ('writes' in overlay || 'canSpawn' in overlay || 'isolation' in overlay) {
      errors.push('overlay 不能包含 writes / canSpawn / isolation');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * The reason string the composer footer shows under a disabled 开始
 * (Foundation spec §10.4). Empty when valid.
 */
export function firstValidationError(
  result: ProfileValidationResult,
): string {
  return result.ok ? '' : result.errors[0] ?? '团队配置无效';
}

/**
 * Overlay JSON guard for profiles parsed from disk: unknown keys are
 * dropped (fail closed) rather than trusted (spec §14.2). Builds a clean
 * `TeamMemberOverlay` from arbitrary parsed input.
 */
export function sanitizeOverlay(value: unknown): TeamMemberOverlay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { model: 'inherit', skills: [], systemPromptOverlay: '' };
  }
  const raw = value as Record<string, unknown>;
  const overlay: {
    model: string;
    skills: string[];
    systemPromptOverlay: string;
    tools?: string[];
    disallowedTools?: string[];
  } = { model: 'inherit', skills: [], systemPromptOverlay: '' };
  if (typeof raw['model'] === 'string' && raw['model'].length > 0) {
    overlay.model = raw['model'];
  }
  if (Array.isArray(raw['tools'])) {
    const tools = raw['tools'].filter((t): t is string => typeof t === 'string');
    if (tools.length > 0) overlay.tools = tools;
  }
  if (Array.isArray(raw['disallowedTools'])) {
    const denied = raw['disallowedTools'].filter((t): t is string => typeof t === 'string');
    if (denied.length > 0) overlay.disallowedTools = denied;
  }
  if (Array.isArray(raw['skills'])) {
    overlay.skills = raw['skills'].filter((s): s is string => typeof s === 'string');
  }
  if (typeof raw['systemPromptOverlay'] === 'string') {
    overlay.systemPromptOverlay = raw['systemPromptOverlay'].slice(0, OVERLAY_PROMPT_MAX_CHARS);
  }
  return overlay;
}
