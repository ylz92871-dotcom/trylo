import { sourceHash } from './ids';
import type { EvidenceScope, ProductSurface, ScopeKeyV2, ScopeLevel } from './types';

export interface LearningScope {
  readonly userId: string;
  readonly level: ScopeLevel;
  readonly product?: ProductSurface;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly component?: string;
  readonly taskCategory?: string;
  readonly taskId?: string;
  readonly corePath?: boolean;
  readonly riskBand?: 'low' | 'medium' | 'high';
  readonly positiveTags: readonly string[];
  readonly negativeTags: readonly string[];
  readonly fingerprint: string;
}

const LEVEL_RANK: Record<ScopeLevel, number> = {
  global: 0,
  product: 1,
  workspace: 2,
  project: 3,
  component: 4,
  task_category: 5,
  task: 6,
};

function nullableString(value: string | undefined): string | null {
  return value && value !== 'global' ? value : null;
}

export function canonicalScope(scope: EvidenceScope): ScopeKeyV2 {
  return {
    product: scope.product ?? null,
    workspaceId: nullableString(scope.workspaceId),
    projectId: nullableString(scope.projectId),
    component: nullableString(scope.component),
    taskCategory: nullableString(scope.taskCategory),
    artifactAudience: scope.artifactAudience ?? null,
    taskStage: scope.taskStage ?? null,
    corePath: scope.corePath ?? null,
    riskLevel: scope.riskLevel ?? null,
    reversible: scope.reversible ?? null,
  };
}

/** JSON property order is intentionally frozen as part of ScopeKey v2. */
export function serializeScopeKey(scope: EvidenceScope): string {
  return JSON.stringify(canonicalScope(scope));
}

export function fingerprintScopeV2(scope: EvidenceScope): string {
  return `v2:${sourceHash([serializeScopeKey(scope)])}`;
}

/** Compatibility alias. All callers now receive the versioned fingerprint. */
export function fingerprintScope(scope: EvidenceScope): string {
  return fingerprintScopeV2(scope);
}

export function withFingerprint<T extends EvidenceScope>(scope: T): T {
  return { ...scope, fingerprint: fingerprintScope(scope), level: scope.level ?? inferLevel(scope) };
}

export function inferLevel(scope: EvidenceScope): ScopeLevel {
  if (scope.projectId && scope.projectId !== 'global' && scope.component) return 'component';
  if (scope.projectId && scope.projectId !== 'global') return 'project';
  if (scope.workspaceId && scope.workspaceId !== 'global') return 'workspace';
  if (scope.product) return 'product';
  return 'global';
}

export function isGlobalScope(scope: EvidenceScope): boolean {
  return (scope.level ?? inferLevel(scope)) === 'global';
}

export function sameStableScope(a: EvidenceScope, b: EvidenceScope): boolean {
  return fingerprintScope(a) === fingerprintScope(b);
}

export function scopeSpecificity(scope: EvidenceScope): number {
  return LEVEL_RANK[scope.level ?? inferLevel(scope)]
    + (scope.corePath ? 2 : 0)
    + (scope.component ? 1 : 0);
}

export function scopeCompatible(evidenceScope: EvidenceScope, targetScope: EvidenceScope): boolean {
  const a = canonicalScope(evidenceScope);
  const b = canonicalScope(targetScope);
  const compatible = <T>(left: T | null, right: T | null): boolean => (
    left === null || right === null || left === right
  );
  return compatible(a.product, b.product)
    && compatible(a.workspaceId, b.workspaceId)
    && compatible(a.projectId, b.projectId)
    && compatible(a.component, b.component)
    && compatible(a.taskCategory, b.taskCategory)
    && compatible(a.artifactAudience, b.artifactAudience)
    && compatible(a.taskStage, b.taskStage)
    && compatible(a.corePath, b.corePath)
    && compatible(a.riskLevel, b.riskLevel)
    && compatible(a.reversible, b.reversible);
}

export function scopeSubsumes(broader: EvidenceScope, narrower: EvidenceScope): boolean {
  if (!scopeCompatible(broader, narrower)) return false;
  return scopeSpecificity(broader) <= scopeSpecificity(narrower);
}

export function conclusionStableKey(userId: string, dimension: string, scope: EvidenceScope, claimFamily = ''): string {
  return [userId, dimension, fingerprintScope(scope), claimFamily].join('::');
}

export function userModelStableKey(userId: string, dimension: string, scope: EvidenceScope, decisionTarget = dimension): string {
  return [userId, dimension, fingerprintScope(scope), decisionTarget].join('::');
}
