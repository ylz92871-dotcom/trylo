import { describe, expect, it } from 'vitest';
import { createUserLearningStore, emptySnapshot, migrateSnapshot } from './store';

describe('user-learning store', () => {
  it('migrates missing schema to v1 without dropping unknown-safe arrays', () => {
    const migrated = migrateSnapshot({ userId: 'u1', evidence: [{ id: 'ev_1' }] }, 10);
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.userId).toBe('u1');
    expect(migrated.evidence).toHaveLength(1);
    expect(migrated.userModels).toEqual([]);
    // §3.1: missing cognitionAskLog migrates fail-open to [].
    expect(migrated.cognitionAskLog).toEqual([]);
    expect(migrated.traceLearningCommits).toEqual([]);
    expect(migrated.deletionEpoch).toBe(0);
  });

  it('memory store survives replace and does not require window', () => {
    const store = createUserLearningStore({ memoryOnly: true, now: () => 5 });
    store.replace({ ...emptySnapshot(1, 'u'), evidence: [] });
    expect(store.snapshot().userId).toBe('u');
    expect(store.snapshot().schemaVersion).toBe(5);
  });

  it('marks legacy closed traces as already learned during v4 migration', () => {
    const migrated = migrateSnapshot({
      schemaVersion: 3,
      userId: 'u1',
      traces: [{
        id: 'tr_closed',
        userId: 'u1',
        sessionId: 's',
        taskId: 't',
        turnId: 't',
        workspaceId: 'w',
        projectId: 'p',
        product: 'code',
        initialRequest: 'x',
        agentDecisions: [],
        userEvents: [],
        outcome: 'completed',
        createdAt: 1,
        closedAt: 2,
      }],
    }, 10);
    expect(migrated.traceLearningCommits).toEqual([expect.objectContaining({
      terminalKey: 'legacy:tr_closed',
      traceId: 'tr_closed',
      outcome: 'completed',
      status: 'committed',
    })]);
  });

  it('migrates v4 stable scopes to v5 and retires stale policy bundles', () => {
    const migrated = migrateSnapshot({
      schemaVersion: 4,
      userId: 'u1',
      evidence: [{
        id: 'ev',
        context: {
          workspaceId: 'ws',
          projectId: 'p',
          product: 'code',
          scopeTags: ['tag'],
          taskStage: 'post_execution',
          corePath: false,
          reversible: false,
        },
      }],
      conclusions: [
        { id: 'c1', userId: 'u1', dimension: 'reporting_information_density', scope: { workspaceId: 'ws', projectId: 'p', product: 'code', scopeTags: [] }, status: 'active', version: 1, updatedAt: 1 },
        { id: 'c2', userId: 'u1', dimension: 'reporting_information_density', scope: { workspaceId: 'ws', projectId: 'p', product: 'code', scopeTags: [] }, status: 'active', version: 2, updatedAt: 2 },
      ],
      userModels: [
        { id: 'm1', userId: 'u1', dimension: 'reporting_information_density', scope: { workspaceId: 'ws', projectId: 'p', product: 'code', scopeTags: [] }, status: 'active', version: 1, updatedAt: 1 },
        { id: 'm2', userId: 'u1', dimension: 'reporting_information_density', scope: { workspaceId: 'ws', projectId: 'p', product: 'code', scopeTags: [] }, status: 'active', version: 2, updatedAt: 2 },
      ],
      policyRules: [{ id: 'rule', status: 'active' }],
      policyBundles: [{ id: 'bundle', status: 'active' }],
      currentBaseBundleId: 'bundle',
      currentProjectBundleIds: { p: 'bundle' },
    }, 10);

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.evidence[0]?.context.fingerprint).toMatch(/^v2:fnv1a:/);
    expect(migrated.evidence[0]?.context.taskStage).toBe('unknown');
    expect(migrated.evidence[0]?.context.reversible).toBe(false);
    expect(migrated.conclusions.find((item) => item.id === 'c1')?.status).toBe('superseded');
    expect(migrated.conclusions.find((item) => item.id === 'c2')?.status).toBe('active');
    expect(migrated.userModels.find((item) => item.id === 'm1')?.status).toBe('superseded');
    expect(migrated.userModels.find((item) => item.id === 'm2')?.stableKey).toContain('v2:fnv1a:');
    expect(migrated.policyRules[0]?.status).toBe('superseded');
    expect(migrated.policyBundles[0]?.status).toBe('retired');
    expect(migrated.currentBaseBundleId).toBeUndefined();
    expect(migrated.currentProjectBundleIds).toBeUndefined();
    expect(migrated.dirtyDimensions).toContain('reporting_information_density');
    expect(migrated.behaviorCommitments).toEqual([]);
    expect(migrated.learningCallLedger).toEqual([]);
  });
});
