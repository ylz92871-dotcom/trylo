import { describe, expect, it } from 'vitest';
import { createUserLearningStore, emptySnapshot, migrateSnapshot } from './store';

describe('user-learning store', () => {
  it('migrates missing schema to v1 without dropping unknown-safe arrays', () => {
    const migrated = migrateSnapshot({ userId: 'u1', evidence: [{ id: 'ev_1' }] }, 10);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.userId).toBe('u1');
    expect(migrated.evidence).toHaveLength(1);
    expect(migrated.userModels).toEqual([]);
    // §3.1: missing cognitionAskLog migrates fail-open to [].
    expect(migrated.cognitionAskLog).toEqual([]);
  });

  it('memory store survives replace and does not require window', () => {
    const store = createUserLearningStore({ memoryOnly: true, now: () => 5 });
    store.replace({ ...emptySnapshot(1, 'u'), evidence: [] });
    expect(store.snapshot().userId).toBe('u');
    expect(store.snapshot().schemaVersion).toBe(3);
  });
});
