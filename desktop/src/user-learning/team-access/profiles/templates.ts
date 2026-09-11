// Built-in team templates (Foundation spec §7.5).
//
// Builtins live in CODE — a same-id disk entry never overrides them
// (profile-io enforces that). Auto-assemble (「让 Person 建议一组」) maps
// its signal to ONE of these templateIds; inventing an ad-hoc roster is
// forbidden (spec rule 5 / Key Decision 15).

import { emptyMemberOverlay, type TeamMemberSpec, type TeamProfile, type TeamProfileSurface, type TeamRoleId } from './profile-types';

export type BuiltinTemplateId =
  | 'small-change'
  | 'architecture'
  | 'verify-only'
  | 'deliverable'
  | 'review-only';

export const BUILTIN_TEMPLATE_IDS: readonly BuiltinTemplateId[] = [
  'small-change',
  'architecture',
  'verify-only',
  'deliverable',
  'review-only',
];

const TITLES: Record<BuiltinTemplateId, string> = {
  'small-change': '实现小改动',
  architecture: '架构改动',
  'verify-only': '交付验收',
  deliverable: '交付验收',
  'review-only': '只审不写',
};

const ROSTERS: Record<BuiltinTemplateId, readonly TeamRoleId[]> = {
  'small-change': ['person', 'worker', 'reviewer'],
  architecture: ['person', 'architect', 'worker', 'reviewer', 'verifier'],
  // Same lineup, different surface label (Code vs Work).
  'verify-only': ['person', 'worker', 'verifier'],
  deliverable: ['person', 'worker', 'verifier'],
  'review-only': ['person', 'reviewer'],
};

function membersFor(templateId: BuiltinTemplateId): TeamMemberSpec[] {
  return ROSTERS[templateId].map((baseRole) => ({
    memberId: `${templateId}-${baseRole}`,
    baseRole,
    displayName: roleTitle(baseRole),
    overlay: emptyMemberOverlay(),
  }));
}

function roleTitle(role: TeamRoleId): string {
  switch (role) {
    case 'person': return '代表你';
    case 'architect': return '架构';
    case 'worker': return '动手';
    case 'reviewer': return '审查';
    case 'verifier': return '验收';
    default: return role;
  }
}

/** Builtin template ids listed for a given surface (review-only is shared). */
export function builtinTemplateIdsForSurface(surface: TeamProfileSurface): readonly BuiltinTemplateId[] {
  return surface === 'work'
    ? ['small-change', 'architecture', 'deliverable', 'review-only']
    : ['small-change', 'architecture', 'verify-only', 'review-only'];
}

export function builtinTemplate(
  templateId: BuiltinTemplateId,
  surface: TeamProfileSurface,
  now = 0,
): TeamProfile {
  return {
    schemaVersion: 1,
    id: templateId,
    origin: 'builtin',
    surface,
    title: TITLES[templateId],
    createdAt: now,
    updatedAt: now,
    members: membersFor(templateId),
  };
}

/** The four builtin templates for the surface, in idle-row order. */
export function builtinTemplatesForSurface(
  surface: TeamProfileSurface,
  now = 0,
): readonly TeamProfile[] {
  return builtinTemplateIdsForSurface(surface).map((id) => builtinTemplate(id, surface, now));
}

/** `review-only` is the only builtin allowed to have zero workers. */
export function isReviewOnlyTemplate(templateId: string): boolean {
  return templateId === 'review-only';
}

// ── Signal → templateId mapping (spec §7.5 auto-assemble table) ────
// Pure; used by the PR-8 opt-in button. Never spawns by itself.

const REVIEW_ONLY_RE = /^(只审|只要审|review (this|only|it)|看看 ?diff|帮我看看(改动|代码)|不要改(代码|文件))/i;
const IMPLEMENT_RE = /实现|修复|重构|迁移|implement|fix|refactor|migrate/i;
const DELIVERABLE_RE = /测试|验证|验收|pptx|docx|xlsx|报告|幻灯|test|verify|validate/i;

/**
 * Map the same deterministic signals the scorer reads to a builtin
 * templateId (spec §7.5 table). `isWorkProduct` covers Work tasks whose
 * product is a deliverable.
 */
export function mapSignalsToTemplate(input: {
  readonly prompt: string;
  readonly product: 'code' | 'work';
  readonly corePath?: boolean;
  readonly risk?: 'low' | 'medium' | 'high';
}): BuiltinTemplateId {
  const prompt = input.prompt;
  const reviewIntent = REVIEW_ONLY_RE.test(prompt) && !IMPLEMENT_RE.test(prompt);
  if (reviewIntent) return 'review-only';

  const architectureHeavy =
    input.corePath === true ||
    input.risk === 'high' ||
    /跨模块|整体重构|架构|迁移|拆分|multi-?file|across modules|refactor|architecture/i.test(prompt);
  if (architectureHeavy) return 'architecture';

  if (input.product === 'work' || DELIVERABLE_RE.test(prompt)) {
    return input.product === 'work' ? 'deliverable' : 'verify-only';
  }
  return 'small-change';
}
