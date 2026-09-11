import { describe, expect, it } from 'vitest';
import {
  atomicWrite,
  createFileUserLearningStore,
  createMemoryFileIO,
  readWithBackup,
} from './repository-file';
import { emptySnapshot } from './store';
import { USER_LEARNING_SCHEMA_VERSION } from './types';

describe('file repository atomic commit', () => {
  it('write-then-rename leaves a backup of the previous snapshot', () => {
    const io = createMemoryFileIO({ '/data/snapshot.json': '{"ok":1}' });
    atomicWrite(io, '/data/snapshot.json', '{"ok":2}');
    expect(io.read('/data/snapshot.json')).toBe('{"ok":2}');
    expect(io.read('/data/snapshot.json.bak')).toBe('{"ok":1}');
    expect(io.read('/data/snapshot.json.tmp')).toBeNull();
  });

  it('loads the backup when the primary snapshot is missing after a crash', () => {
    const io = createMemoryFileIO();
    io.write('/data/snapshot.json.bak', JSON.stringify({
      schemaVersion: 1,
      userId: 'keep-me',
      evidence: [{ id: 'ev_keep' }],
    }));
    expect(JSON.parse(readWithBackup(io, '/data/snapshot.json') ?? '{}').userId).toBe('keep-me');
    const store = createFileUserLearningStore({ io, rootDir: '/data', now: () => 9 });
    expect(store.snapshot().userId).toBe('keep-me');
    expect(store.snapshot().evidence).toHaveLength(1);
  });

  it('surfaces a write failure instead of pretending it persisted', () => {
    const inner = createMemoryFileIO();
    const io = {
      ...inner,
      rename(from: string, to: string) {
        if (to.endsWith('snapshot.json')) throw new Error('disk full');
        inner.rename(from, to);
      },
    };
    const store = createFileUserLearningStore({ io, rootDir: '/data', now: () => 3 });
    store.replace({ ...emptySnapshot(1, 'u'), traces: [] });
    expect(store.snapshot().persisted).toBe(false);
    expect(store.snapshot().diagnostics?.persistFailed).toBe(true);
  });

  it('compacts unbounded traces on persist', () => {
    const io = createMemoryFileIO();
    const store = createFileUserLearningStore({ io, rootDir: '/data', now: () => 4 });
    store.update((snap) => ({
      ...snap,
      traces: Array.from({ length: 120 }, (_, i) => ({
        id: `tr_${i}`,
        userId: 'local-user',
        sessionId: 's',
        taskId: 't',
        turnId: 'u',
        workspaceId: 'w',
        projectId: 'p',
        product: 'code' as const,
        initialRequest: 'x',
        agentDecisions: [],
        userEvents: [],
        executionResult: 'y'.repeat(800),
        createdAt: i,
      })),
    }));
    expect(store.snapshot().traces.length).toBeLessThanOrEqual(80);
    expect(store.snapshot().traces.at(-1)?.executionResult?.length).toBeLessThanOrEqual(401);
  });

  it('imports a legacy v1 localStorage snapshot once', () => {
    const io = createMemoryFileIO();
    const store = createFileUserLearningStore({
      io,
      rootDir: '/data',
      now: () => 5,
      importLegacy: () => JSON.stringify({
        schemaVersion: 1,
        userId: 'legacy',
        evidence: [{ id: 'ev_legacy' }],
      }),
    });
    expect(store.snapshot().userId).toBe('legacy');
    expect(store.snapshot().schemaVersion).toBe(USER_LEARNING_SCHEMA_VERSION);
  });
});
