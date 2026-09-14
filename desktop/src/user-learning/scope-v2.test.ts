import { describe, expect, it } from 'vitest';
import {
  canonicalScope,
  fingerprintScopeV2,
  sameStableScope,
  scopeCompatible,
  serializeScopeKey,
} from './scope';
import type { EvidenceScope } from './types';

const scope = (overrides: Partial<EvidenceScope> = {}): EvidenceScope => ({
  workspaceId: 'ws-a',
  projectId: 'project-a',
  product: 'code',
  scopeTags: ['ignored-for-identity'],
  ...overrides,
});

describe('ScopeKey v2', () => {
  it('serializes every identity field in a deterministic order and preserves false', () => {
    const value = scope({
      component: 'editor',
      taskCategory: 'report',
      artifactAudience: 'external',
      taskStage: 'deliver',
      corePath: false,
      riskLevel: 'high',
      reversible: false,
    });
    expect(canonicalScope(value)).toEqual({
      product: 'code',
      workspaceId: 'ws-a',
      projectId: 'project-a',
      component: 'editor',
      taskCategory: 'report',
      artifactAudience: 'external',
      taskStage: 'deliver',
      corePath: false,
      riskLevel: 'high',
      reversible: false,
    });
    expect(serializeScopeKey(value)).toContain('"corePath":false');
    expect(fingerprintScopeV2(value)).toMatch(/^v2:fnv1a:/);
  });

  it('does not include scopeTags in stable identity', () => {
    expect(sameStableScope(scope({ scopeTags: ['one'] }), scope({ scopeTags: ['two'] }))).toBe(true);
  });

  it.each([
    ['product', scope(), scope({ product: 'work' })],
    ['workspace', scope(), scope({ workspaceId: 'ws-b' })],
    ['project', scope(), scope({ projectId: 'project-b' })],
    ['core path', scope({ corePath: true }), scope({ corePath: false })],
    ['risk', scope({ riskLevel: 'low' }), scope({ riskLevel: 'high' })],
    ['audience', scope({ artifactAudience: 'internal' }), scope({ artifactAudience: 'external' })],
    ['stage', scope({ taskStage: 'explore' }), scope({ taskStage: 'deliver' })],
    ['reversibility', scope({ reversible: true }), scope({ reversible: false })],
  ])('rejects incompatible %s scopes', (_name, a, b) => {
    expect(scopeCompatible(a, b)).toBe(false);
  });

  it('allows a missing broader field to match a narrower field without crossing product', () => {
    const broader = scope({ projectId: 'global', component: undefined, taskStage: undefined });
    const narrower = scope({ component: 'editor', taskStage: 'review' });
    expect(scopeCompatible(broader, narrower)).toBe(true);
    expect(scopeCompatible({ ...broader, product: 'work' }, narrower)).toBe(false);
  });
});
