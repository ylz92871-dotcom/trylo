// Trylo Desktop — CodeResultProjector tests (P2-1, spec §12.1).

import { describe, expect, it, vi } from 'vitest';
import type { GitSnapshotEntry, GitWorkspaceSnapshot, GitService } from '../host-adapter';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { RuntimeResultScope } from './result-scope';
import { computeRunDelta, CodeResultProjector, type CodeResultStore } from './code-result-projector';
import type { StoredCodeRunResult } from './conversation-result-types';

function entry(partial: Partial<GitSnapshotEntry> & { path: string }): GitSnapshotEntry {
  return {
    path: partial.path,
    oldPath: partial.oldPath,
    indexStatus: partial.indexStatus ?? 'M',
    worktreeStatus: partial.worktreeStatus ?? 'M',
    worktreeOid: partial.worktreeOid,
    indexOid: partial.indexOid,
    missing: partial.missing ?? false,
  };
}

function snapshot(entries: readonly GitSnapshotEntry[], head = 'abc', repository = true): GitWorkspaceSnapshot {
  return { repository, head, entries, capturedAt: 0, truncated: false };
}

const scope: RuntimeResultScope = {
  projectKey: 'proj',
  projectRoot: 'D:/repo',
  conversationId: 'conv',
  mode: 'code',
  runId: 'run-1',
  turnId: 'turn-1',
  startedAt: 100,
};

describe('computeRunDelta', () => {
  it('pre-dirty unchanged file does NOT enter the run delta', () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: 'oid-a' })], 'abc');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: 'oid-a' })], 'abc');
    expect(computeRunDelta(base, final).changes).toHaveLength(0);
  });

  it('pre-dirty file modified again DOES enter the run delta', () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: 'oid-1' })], 'abc');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: 'oid-2' })], 'abc');
    expect(computeRunDelta(base, final).changes.map((c) => c.kind)).toEqual(['modified']);
  });

  it('added and deleted and rename are detected', () => {
    const base = snapshot([entry({ path: 'old.ts', indexStatus: 'D', worktreeStatus: ' ' })], 'abc');
    const final = snapshot([
      entry({ path: 'new.ts', indexStatus: 'A', worktreeStatus: ' ' }),
      entry({ path: 'gone.ts', indexStatus: 'D', worktreeStatus: ' ' }),
      entry({ path: 'renamed.ts', indexStatus: 'R', worktreeStatus: ' ', oldPath: 'old.ts' }),
    ], 'abc');
    const kinds = computeRunDelta(base, final).changes.map((c) => c.kind);
    expect(kinds).toContain('added');
    expect(kinds).toContain('deleted');
    expect(kinds).toContain('renamed');
  });

  it('missing baseline yields workspace_only attribution', () => {
    const final = snapshot([entry({ path: 'a.ts' })], 'abc');
    const delta = computeRunDelta(null, final);
    expect(delta.attribution).toBe('workspace_only');
  });

  it('repo false yields unavailable attribution', () => {
    const final = snapshot([], 'abc', false);
    expect(computeRunDelta(null, final).attribution).toBe('unavailable');
  });

  it('HEAD change is flagged', () => {
    const base = snapshot([], 'aaa');
    const final = snapshot([], 'bbb');
    expect(computeRunDelta(base, final).headChanged).toBe(true);
  });

  it('moved HEAD degrades attribution to workspace_only (never a fake run diff)', () => {
    const base = snapshot([], 'aaa');
    const final = snapshot([], 'bbb');
    expect(computeRunDelta(base, final).attribution).toBe('workspace_only');
  });
});

function makeProjector(opts: {
  baseline?: GitWorkspaceSnapshot | null;
  final?: GitWorkspaceSnapshot | null;
  failBaseline?: boolean;
  failFinal?: boolean;
}) {
  const calls: string[] = [];
  const results: StoredCodeRunResult[] = [];
  const store: CodeResultStore = {
    update(_projectKey, _projectRoot, _conversationId, code) {
      calls.push('update');
      if (code) results.push(code);
    },
  };
  // Attempt 1 = baseline, attempt 2 = final. A failed attempt throws so the
  // projector's bounded snapshot degrades the projection (never the run).
  let attempt = 0;
  const git: GitService = {
    snapshot: vi.fn(async (): Promise<GitWorkspaceSnapshot> => {
      attempt += 1;
      if (attempt === 1 && opts.failBaseline) throw new Error('baseline failed');
      if (attempt === 2 && opts.failFinal) throw new Error('final failed');
      const value = attempt === 1 ? opts.baseline : opts.final;
      if (!value) throw new Error('missing snapshot');
      return value;
    }),
    fileDiff: vi.fn(),
    diffStats: vi.fn(async () => []),
  };
  return { projector: new CodeResultProjector({ git, store }), store, results, calls };
}

describe('CodeResultProjector lifecycle', () => {
  it('finalizes exactly once with a run delta', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc');
    const { projector, results, calls } = makeProjector({ baseline: base, final });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    await projector.onRunTerminal(scope, 'completed'); // duplicate — guarded
    expect(calls).toEqual(['update']);
    expect(results).toHaveLength(1);
    expect(results[0]!.attribution).toBe('run_delta');
    expect(results[0]!.changes).toHaveLength(1);
    expect(results[0]!.meta.status).toBe('completed');
  });

  it('baseline missing => workspace_only + degraded on completed', async () => {
    const final = snapshot([entry({ path: 'a.ts' })], 'abc');
    const { projector, results } = makeProjector({ final, failBaseline: true });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    expect(results[0]!.attribution).toBe('workspace_only');
    expect(results[0]!.meta.status).toBe('degraded');
  });

  it('failed runtime outcome stays failed (projection not the run status)', async () => {
    const base = snapshot([], 'abc');
    const final = snapshot([], 'abc');
    const { projector, results } = makeProjector({ baseline: base, final });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'failed');
    expect(results[0]!.meta.status).toBe('failed');
  });

  it('head changed during run => degraded projection with warning', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'aaa');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'bbb');
    const { projector, results } = makeProjector({ baseline: base, final });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    expect(results[0]!.meta.status).toBe('degraded');
    expect(results[0]!.meta.warning).toBeTruthy();
  });

  it('terminal snapshot failure keeps baseline degradation', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const { projector, results } = makeProjector({ baseline: base, failFinal: true });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    expect(results[0]!.attribution).toBe('workspace_only');
    expect(results[0]!.meta.status).toBe('degraded');
  });

  it('keeps changed-file review for a non-Git folder using Edit observations', async () => {
    const nonRepo = snapshot([], undefined, false);
    const { projector, results } = makeProjector({ baseline: nonRepo, final: nonRepo });
    projector.onRunStarted(scope);
    projector.onEvents(scope, [{
      type: 'tool_use', seq: 1, ts: 110, turn: 1, id: 'edit-1', tool: 'Edit',
      input: {
        file_path: 'D:/repo/src/app.ts',
        old_string: 'const oldValue = 1;\n',
        new_string: 'const newValue = 2;\nconst ready = true;\n',
      },
    }]);
    await projector.onRunTerminal(scope, 'completed');
    expect(results[0]!.attribution).toBe('workspace_only');
    expect(results[0]!.changes).toEqual([expect.objectContaining({
      path: 'src/app.ts', kind: 'modified', additions: 2, deletions: 1,
    })]);
    expect(results[0]!.changeCountTotal).toBe(1);
  });

  it('truncated final => workspace_only attribution + degraded (M1)', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const { projector, results } = makeProjector({ baseline: base, final: {
      ...snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc'),
      truncated: true,
    } });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    expect(results[0]!.attribution).toBe('workspace_only');
    expect(results[0]!.truncated).toBe(true);
    expect(results[0]!.meta.status).toBe('degraded');
  });
});

// ── baseline / terminal race (audit P1-1) ──────────────────────────────────
//
// The projector owns an explicit per-run lifecycle state: onRunStarted
// creates it SYNCHRONOUSLY (buffer ready before the first event), the Git
// baseline runs asynchronously behind a bounded promise SHARED with the
// terminal, and finalize is exactly-once with full cleanup — a late baseline
// resolve or a duplicate/late frame can never resurrect state.

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A tool_use/tool_result pair the check classifier recognises. */
const CHECK_EVENTS: readonly LoopEvent[] = [
  { type: 'tool_use', seq: 1, ts: 0, turn: 1, id: 'call-1', tool: 'bash', input: { command: 'pnpm test' } },
  { type: 'tool_result', seq: 2, ts: 0, turn: 1, id: 'call-1', tool: 'bash', ok: true, output: '', durationMs: 0 },
];

type SnapshotScriptStep =
  | { readonly kind: 'value'; readonly value: GitWorkspaceSnapshot }
  | { readonly kind: 'reject' }
  | { readonly kind: 'pending' };

/** Scripted git + projector with a tiny budget so races play out
 *  deterministically without waiting out the real multi-second budgets. */
function raceHarness(script: readonly SnapshotScriptStep[], budgetMs = 25) {
  const results: StoredCodeRunResult[] = [];
  const store: CodeResultStore = {
    update(_projectKey, _projectRoot, _conversationId, code) {
      if (code) results.push(code);
    },
  };
  const pending: Array<Deferred<GitWorkspaceSnapshot>> = [];
  let attempt = 0;
  const git: GitService = {
    snapshot: vi.fn((): Promise<GitWorkspaceSnapshot> => {
      const step = script[attempt++];
      if (!step || step.kind === 'reject') return Promise.reject(new Error('snapshot failed'));
      if (step.kind === 'value') return Promise.resolve(step.value);
      const d = deferred<GitWorkspaceSnapshot>();
      pending.push(d);
      return d.promise;
    }),
    fileDiff: vi.fn(),
    diffStats: vi.fn(async () => []),
  };
  const projector = new CodeResultProjector({ git, store, baselineBudgetMs: budgetMs, finalBudgetMs: budgetMs });
  return { projector, results, pending };
}

/** Sleep helper so a real (tiny) budget can elapse. */
function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('CodeResultProjector baseline/terminal race (audit P1-1)', () => {
  it('event before baseline: events buffer from the first moment, nothing drops', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc');
    const { projector, results, pending } = raceHarness([
      { kind: 'pending' },
      { kind: 'value', value: final },
    ]);
    projector.onRunStarted(scope);
    projector.onEvents(scope, CHECK_EVENTS); // baseline still in flight
    pending[0]!.resolve(base);
    await projector.onRunTerminal(scope, 'completed');
    expect(results).toHaveLength(1);
    expect(results[0]!.checks.map((c) => c.kind)).toEqual(['test']);
    expect(results[0]!.attribution).toBe('run_delta');
  });

  it('terminal before baseline: waits on the shared baselinePromise instead of finalizing empty', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc');
    const { projector, results, pending } = raceHarness([
      { kind: 'pending' },
      { kind: 'value', value: final },
    ]);
    projector.onRunStarted(scope);
    const terminal = projector.onRunTerminal(scope, 'completed');
    expect(results).toHaveLength(0); // bounded wait on the SAME baseline promise
    pending[0]!.resolve(base);
    await terminal;
    expect(results).toHaveLength(1);
    expect(results[0]!.attribution).toBe('run_delta'); // real baseline, not null
    expect(results[0]!.changes).toHaveLength(1);
  });

  it('baseline timeout: bounded wait degrades the projection, never blocks terminal', async () => {
    const final = snapshot([entry({ path: 'a.ts' })], 'abc');
    const { projector, results, pending } = raceHarness([
      { kind: 'pending' }, // baseline never completes inside the budget
      { kind: 'value', value: final },
    ], 20);
    projector.onRunStarted(scope);
    const terminal = projector.onRunTerminal(scope, 'completed');
    await settle(60); // let the baseline budget elapse
    await terminal;
    expect(results).toHaveLength(1);
    expect(results[0]!.attribution).toBe('workspace_only');
    expect(results[0]!.meta.status).toBe('degraded');
    pending[0]!.resolve(snapshot([], 'abc')); // keep the harness promise settled
  });

  it('baseline reject: degrades instead of throwing or blocking', async () => {
    const final = snapshot([entry({ path: 'a.ts' })], 'abc');
    const { projector, results } = raceHarness([
      { kind: 'reject' },
      { kind: 'value', value: final },
    ]);
    projector.onRunStarted(scope);
    projector.onEvents(scope, CHECK_EVENTS);
    await projector.onRunTerminal(scope, 'completed');
    expect(results[0]!.attribution).toBe('workspace_only');
    expect(results[0]!.meta.status).toBe('degraded');
    expect(results[0]!.checks).toHaveLength(1); // events survive a failed baseline
  });

  it('late baseline resolve after terminal resurrects nothing', async () => {
    const base = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const final = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc');
    const { projector, results, pending } = raceHarness([
      { kind: 'pending' },
      { kind: 'value', value: final },
    ], 20);
    projector.onRunStarted(scope);
    const terminal = projector.onRunTerminal(scope, 'completed');
    await settle(60);
    await terminal;
    expect(results).toHaveLength(1);

    // The run is finalized + cleaned up; the late resolve must be inert.
    pending[0]!.resolve(base);
    await settle(0);
    projector.onRunStarted(scope); // late start — no-op (already finalized)
    projector.onEvents(scope, CHECK_EVENTS); // no buffer — dropped
    await projector.onRunTerminal(scope, 'completed'); // duplicate — no-op
    expect(results).toHaveLength(1);
  });

  it('duplicate terminals finalize exactly once', async () => {
    const { projector, results } = raceHarness([
      { kind: 'value', value: snapshot([], 'abc') },
      { kind: 'value', value: snapshot([], 'abc') },
    ]);
    projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    await projector.onRunTerminal(scope, 'failed');
    await projector.onRunTerminal(scope, 'completed');
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.status).toBe('completed');
  });

  it('cleanup after finalize: a successive run gets its own lifecycle, never stale state', async () => {
    const base1 = snapshot([entry({ path: 'a.ts', worktreeOid: '1' })], 'abc');
    const final1 = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc');
    const base2 = snapshot([entry({ path: 'a.ts', worktreeOid: '2' })], 'abc');
    const final2 = snapshot([entry({ path: 'a.ts', worktreeOid: '3' })], 'abc');
    const { projector, results } = raceHarness([
      { kind: 'value', value: base1 },
      { kind: 'value', value: final1 },
      { kind: 'value', value: base2 },
      { kind: 'value', value: final2 },
    ]);
    projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');

    // A late event for the finalized run is dropped, never resurrecting it.
    projector.onEvents(scope, CHECK_EVENTS);

    const next: RuntimeResultScope = { ...scope, runId: 'run-2', turnId: 'turn-2', startedAt: 200 };
    projector.onRunStarted(next);
    projector.onEvents(next, CHECK_EVENTS);
    await projector.onRunTerminal(next, 'completed');

    expect(results).toHaveLength(2);
    expect(results[1]!.meta.runId).toBe('run-2');
    expect(results[1]!.attribution).toBe('run_delta');
    expect(results[1]!.changes).toHaveLength(1); // run-2 baseline only (2 -> 3)
    expect(results[1]!.checks).toHaveLength(1);
  });

  it('a terminal with no recorded start still finalizes exactly once', async () => {
    const { projector, results } = raceHarness([
      { kind: 'value', value: snapshot([], 'abc') },
    ]);
    await projector.onRunTerminal(scope, 'failed');
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.status).toBe('failed');
    await projector.onRunTerminal(scope, 'completed'); // duplicate stays dropped
    expect(results).toHaveLength(1);
  });

  it('disposeConversation neutralizes in-flight state; a late baseline resolve is inert', async () => {
    const { projector, results, pending } = raceHarness([
      { kind: 'pending' },
      { kind: 'reject' },
    ], 20);
    projector.onRunStarted(scope);
    projector.disposeConversation(scope.projectKey, scope.conversationId);
    pending[0]!.resolve(snapshot([], 'abc'));
    await settle(0);
    projector.onEvents(scope, CHECK_EVENTS); // no buffer left — dropped
    await projector.onRunTerminal(scope, 'completed'); // terminal w/o start
    expect(results).toHaveLength(1);
    expect(results[0]!.checks).toHaveLength(0); // the dropped events prove cleanup
  });
});

// ── WP-4 diff stats ──────────────────────────────────────────────────────

function statsProjector(
  diffStatsImpl: GitService['diffStats'],
  changed: readonly string[] = ['a.ts'],
) {
  const results: StoredCodeRunResult[] = [];
  const store: CodeResultStore = {
    update(_p, _r, _c, code) {
      if (code) results.push(code);
    },
  };
  let snapshots = 0;
  const git: GitService = {
    snapshot: vi.fn(async (): Promise<GitWorkspaceSnapshot> => {
      snapshots += 1;
      // baseline = empty; final = every requested path appears as untracked
      // so ALL of them enter the run delta as `added`.
      return snapshots === 1
        ? snapshot([], 'abc')
        : snapshot(
            changed.map((p) => entry({ path: p, indexStatus: '?', worktreeStatus: '?', worktreeOid: 'x' })),
            'abc',
          );
    }),
    fileDiff: vi.fn(),
    diffStats: diffStatsImpl,
  };
  return { projector: new CodeResultProjector({ git, store, finalBudgetMs: 50 }), results };
}

describe('CodeResultProjector WP-4 diff stats', () => {
  it('merges per-file +N/−N and totals when stats are complete', async () => {
    const { projector, results } = statsProjector(async () => [
      { path: 'a.ts', additions: 12, deletions: 3, binary: false },
    ]);
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    const r = results[0]!;
    expect(r.changes[0]).toMatchObject({ path: 'a.ts', additions: 12, deletions: 3 });
    expect(r.statsComplete).toBe(true);
    expect(r.additionsTotal).toBe(12);
    expect(r.deletionsTotal).toBe(3);
  });

  it('marks a binary change as binary and excludes it from totals', async () => {
    const { projector, results } = statsProjector(async () => [
      { path: 'a.ts', additions: 12, deletions: 3, binary: false },
      { path: 'img.bin', additions: undefined, deletions: undefined, binary: true },
    ], ['a.ts', 'img.bin']);
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    const r = results[0]!;
    expect(r.changes.find((c) => c.path === 'img.bin')?.binary).toBe(true);
    expect(r.additionsTotal).toBe(12);
    expect(r.deletionsTotal).toBe(3);
  });

  it('missing stat => statsComplete false and no totals (UI shows —)', async () => {
    const { projector, results } = statsProjector(async () => [
      // a.ts has no stat entry at all
    ]);
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    const r = results[0]!;
    expect(r.changes[0]!.additions).toBeUndefined();
    expect(r.statsComplete).toBe(false);
    expect(r.additionsTotal).toBeUndefined();
    expect(r.deletionsTotal).toBeUndefined();
  });

  it('diffStats failure degrades totals but not the run or finalization', async () => {
    const { projector, results } = statsProjector(async () => {
      throw new Error('git diff stats failed');
    });
    await projector.onRunStarted(scope);
    await projector.onRunTerminal(scope, 'completed');
    const r = results[0]!;
    expect(r.statsComplete).toBe(false);
    expect(r.meta.status).toBe('completed'); // projection not degraded by stats
    expect(r.changes).toHaveLength(1); // change list is intact
  });
});
