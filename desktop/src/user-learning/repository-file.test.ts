import { describe, expect, it } from 'vitest';
import {
  atomicWrite,
  createFileUserLearningStore,
  createMemoryFileIO,
  readWithBackup,
} from './repository-file';
import { createUserLearningRuntime } from './runtime';
import { emptySnapshot } from './store';
import { createUserLearningStore } from './store';
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

  it('clear removes primary, tmp, backup, and legacy data', () => {
    const snapshot = JSON.stringify(emptySnapshot(1, 'local-user'));
    const io = createMemoryFileIO({
      '/data/snapshot.json': snapshot,
      '/data/snapshot.json.tmp': snapshot,
      '/data/snapshot.json.bak': snapshot,
      'trylo:user-learning:v1': snapshot,
    });
    const store = createFileUserLearningStore({ io, rootDir: '/data', now: () => 10 });

    store.clear();

    expect(io.read('/data/snapshot.json')).toBeNull();
    expect(io.read('/data/snapshot.json.tmp')).toBeNull();
    expect(io.read('/data/snapshot.json.bak')).toBeNull();
    expect(io.read('trylo:user-learning:v1')).toBeNull();
    expect(readWithBackup(io, '/data/snapshot.json')).toBeNull();
    expect(store.snapshot().evidence).toEqual([]);
    expect(store.snapshot().persisted).toBe(true);
  });

  it('keeps terminal learning exactly once after a repository reload', () => {
    const io = createMemoryFileIO();
    const firstStore = createFileUserLearningStore({ io, rootDir: '/data', now: () => 20 });
    const firstRuntime = createUserLearningRuntime({ store: firstStore, now: () => 20 });
    const trace = firstRuntime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: '/project',
      product: 'code',
      prompt: '以后报告先说结论，再给证据',
    });
    firstRuntime.closeTrace(trace.id, 'completed', 'ok');
    const learned = firstRuntime.snapshot();

    const reloadedStore = createFileUserLearningStore({ io, rootDir: '/data', now: () => 21 });
    const reloadedRuntime = createUserLearningRuntime({ store: reloadedStore, now: () => 21 });
    const second = reloadedRuntime.closeTrace(trace.id, 'completed', 'ok');

    expect(second).toEqual([expect.objectContaining({ status: 'skipped', reasonCode: 'idempotent' })]);
    expect(reloadedRuntime.snapshot().traceLearningCommits).toHaveLength(1);
    expect(reloadedRuntime.snapshot().evidence).toEqual(learned.evidence);
    expect(reloadedRuntime.snapshot().conclusions).toEqual(learned.conclusions);
  });

  it('recompiles retired v4 policy state before the first v5 injection', () => {
    const sourceRuntime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      now: () => 30,
    });
    const trace = sourceRuntime.openTrace({
      sessionId: 's',
      turnId: 't',
      workspaceRoot: '/project',
      product: 'code',
      prompt: '以后不要做重复审核，但核心路径保留最终验证',
    });
    sourceRuntime.closeTrace(trace.id, 'completed', 'ok');
    const v4 = { ...sourceRuntime.snapshot(), schemaVersion: 4 };
    const io = createMemoryFileIO({ '/data/snapshot.json': JSON.stringify(v4) });
    const migratedStore = createFileUserLearningStore({ io, rootDir: '/data', now: () => 31 });

    expect(migratedStore.snapshot().policyBundles.every((item) => item.status === 'retired')).toBe(true);
    expect(migratedStore.snapshot().currentProjectBundleIds).toBeUndefined();
    expect(migratedStore.snapshot().dirtyDimensions.length).toBeGreaterThan(0);

    const runtime = createUserLearningRuntime({
      store: migratedStore,
      now: () => 32,
    });
    const prepared = runtime.preparePrompt({
      workspaceRoot: '/project',
      product: 'code',
      prompt: '修改普通页面文案',
      baseSystemPrompt: '',
    });

    expect(runtime.snapshot().currentProjectBundleIds?.[trace.projectId]).toBeDefined();
    expect(runtime.snapshot().dirtyDimensions).toEqual([]);
    expect(prepared.decision.currentBundleId).toBeDefined();
  });
});
