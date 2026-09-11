import { describe, expect, it, vi } from 'vitest';
import { createUserLearningStore, emptySnapshot, migrateSnapshot } from './store';

describe('UL-P1-07 repository failure visibility', () => {
  it('write failure is visible and does not pretend the snapshot persisted', () => {
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem,
        removeItem: () => undefined,
      },
    });
    const store = createUserLearningStore({ memoryOnly: false, now: () => 9 });
    store.replace({ ...emptySnapshot(1, 'u'), traces: [] });
    const snap = store.snapshot() as ReturnType<typeof store.snapshot> & {
      persistError?: string;
      persisted?: boolean;
      diagnostics?: { persistFailed?: boolean };
    };
    expect(
      snap.persistError
      || snap.persisted === false
      || snap.diagnostics?.persistFailed === true,
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('future schema does not reset to an empty snapshot', () => {
    const migrated = migrateSnapshot({
      schemaVersion: 99,
      userId: 'keep-me',
      evidence: [{ id: 'ev_keep', inference: { claim: 'keep' } }],
      traces: [{ id: 'tr_keep' }],
    }, 10) as ReturnType<typeof migrateSnapshot> & {
      diagnostics?: { incompatible?: boolean; readOnly?: boolean };
      readOnly?: boolean;
    };
    expect(migrated.userId).toBe('keep-me');
    expect(migrated.evidence).toHaveLength(1);
    expect(migrated.traces).toHaveLength(1);
    expect(migrated.schemaVersion).toBe(99);
    expect(migrated.diagnostics?.incompatible === true || migrated.readOnly === true).toBe(true);
  });
});
