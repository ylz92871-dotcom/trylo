import type { EvidenceScope, ProductSurface, ScopeLevel } from './types';

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

export function fingerprintScope(scope: Pick<EvidenceScope, 'product' | 'workspaceId' | 'projectId' | 'component' | 'taskCategory'>): string {
  return [
    scope.product ?? '',
    scope.workspaceId ?? '',
    scope.projectId ?? '',
    scope.component ?? '',
    scope.taskCategory ?? '',
  ].join('|');
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
  return !scope.projectId || scope.projectId === 'global' || scope.level === 'global';
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
  if (evidenceScope.product && targetScope.product && evidenceScope.product !== targetScope.product) {
    return false;
  }
  if (isGlobalScope(evidenceScope)) return true;
  if (evidenceScope.workspaceId && targetScope.workspaceId && evidenceScope.workspaceId !== targetScope.workspaceId) {
    if (evidenceScope.workspaceId !== 'global') return false;
  }
  if (evidenceScope.projectId && targetScope.projectId && evidenceScope.projectId !== targetScope.projectId) {
    return false;
  }
  if (evidenceScope.component && targetScope.component && evidenceScope.component !== targetScope.component) {
    return false;
  }
  return true;
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
