import { describe, expect, it } from 'vitest';
import { emptySnapshot, migrateSnapshot } from './store';

const v1 = {
  schemaVersion: 1,
  userId: 'local-user',
  traces: [{ id: 'tr_1', projectId: 'proj-a', userId: 'local-user' }],
  evidence: [{
    id: 'ev_1',
    userId: 'local-user',
    inference: { claim: '用户倾向减少重复审核', semanticConfidence: 0.9, engineeringRelevance: 0.9 },
    context: { workspaceId: 'ws', projectId: 'proj-a', scopeTags: ['ui'] },
    origin: { channel: 'interaction', eventType: 'explicit_statement', stage: 'task_context' },
    rawObservation: { text: '普通 UI 不要反复审核' },
    source: { sessionId: 's', taskId: 't', turnIds: [], actionIds: [], sourceHash: 'h', traceId: 'tr_1' },
    strength: { contextInformedness: 'task_context', band: 'medium' },
    governance: { level: 2, userLocked: false },
    createdAt: 1,
  }],
  evidenceRelations: [],
  conclusions: [],
  conclusionRelations: [],
  profileFacts: [],
  userModels: [],
  userModelDerivations: [],
  projectContexts: [],
  policyRules: [],
  policyBundles: [],
  policyDecisions: [],
  cognitionSessions: [],
  cognitionCooldowns: [],
  learningRuns: [],
  dirtyDimensions: [],
  createdAt: 1,
  updatedAt: 2,
};

describe('v1 → v2 migration', () => {
  it('converts v1 snapshots to v2 and is idempotent', () => {
    const once = migrateSnapshot(v1, 10);
    const twice = migrateSnapshot(once, 11);
    expect(once.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(twice.schemaVersion).toBe(once.schemaVersion);
    expect(twice.userId).toBe('local-user');
    expect(twice.evidence).toHaveLength(1);
    expect(twice.traces).toHaveLength(1);
  });

  it('empty / missing schema still yields a usable empty v2 snapshot', () => {
    const migrated = migrateSnapshot({}, 3);
    expect(migrated.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(migrated.evidence).toEqual([]);
    expect(migrated.userId).toBe(emptySnapshot().userId);
  });
});
