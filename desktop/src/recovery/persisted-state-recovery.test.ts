// Trylo Desktop — defensive recovery tests (C-Edge P2-4 / audit L2).
//
// The recovery module is pure; tests inject verifiers. Every test
// pins a contract the audit calls out: a stale state must never be
// silently promoted to a success, but it also must never disappear.

import { describe, it, expect } from 'vitest';
import {
  applyRecovery,
  type RecoveryInput,
  type RecoveryVerifiers,
} from './persisted-state-recovery';
import type { StoredConversationResults } from '../results/conversation-result-types';

const NOW = 1_700_000_000_000;

const baseVerifiers = (overrides: Partial<RecoveryVerifiers> = {}): RecoveryVerifiers => ({
  isWorkTaskActive: () => false,
  isCodeRunActive: () => false,
  ...overrides,
});

const collectedWorkResult = (): NonNullable<StoredConversationResults['work']> => ({
  artifacts: [
    {
      id: 'a1',
      target: { kind: 'file', relativePath: 'reports/q1.md' },
      displayName: 'q1.md',
      artifactKind: 'document',
      version: 1,
      firstSeenAt: NOW - 1000,
      updatedAt: NOW - 500,
      firstRunId: 'r-1',
      lastRunId: 'r-1',
      lastTurnId: '',
      lastChange: 'created',
      sources: ['event'],
    },
  ],
  artifactCountTotal: 1,
  truncated: false,
  latestRun: {
    runId: 'r-1',
    turnId: '',
    startedAt: NOW - 1000,
    finishedAt: NOW - 500,
    status: 'collecting',
    createdIds: ['a1'],
    updatedIds: [],
    discoveredIds: [],
  },
});

const baseInput = (overrides: Partial<RecoveryInput> = {}): RecoveryInput => ({
  projectKey: 'P',
  conversationId: 'C1',
  workTaskId: 'task-1',
  workTurnId: 'turn-1',
  verifiers: baseVerifiers(),
  now: () => NOW,
  ...overrides,
});

describe('recoverConversation — verdicts', () => {
  it('returns missing-binding when no work taskId is set', () => {
    const out = applyRecovery(
      { schemaVersion: 1, work: collectedWorkResult() },
      baseInput({ workTaskId: null }),
    );
    expect(out.report.work).toBe('missing-binding');
    expect(out.report.changed).toBe(false);
  });

  it('returns active when work verifier returns true', () => {
    const out = applyRecovery(
      { schemaVersion: 1, work: collectedWorkResult() },
      baseInput({ verifiers: baseVerifiers({ isWorkTaskActive: () => true }) }),
    );
    expect(out.report.work).toBe('active');
    expect(out.report.changed).toBe(false);
  });

  it('flags stale when work verifier returns false', () => {
    const out = applyRecovery(
      { schemaVersion: 1, work: collectedWorkResult() },
      baseInput(),
    );
    expect(out.report.work).toBe('stale');
    expect(out.report.changed).toBe(true);
  });

  it('flags code stale when no active Code controller exists', () => {
    const out = applyRecovery(
      {
        schemaVersion: 1,
        code: {
          latestRun: {
            meta: {
              runId: 'r-1',
              turnId: '',
              startedAt: NOW - 1000,
              finishedAt: NOW - 500,
              status: 'collecting',
            },
            attribution: 'run_delta',
            changes: [],
            checks: [],
            changeCountTotal: 0,
            checkCountTotal: 0,
            truncated: false,
          },
        },
      },
      baseInput({ workTaskId: null }),
    );
    expect(out.report.code).toBe('stale');
  });

  it('code active when supervisor says so', () => {
    const out = applyRecovery(
      { schemaVersion: 1 },
      baseInput({
        workTaskId: null,
        verifiers: baseVerifiers({ isCodeRunActive: () => true }),
      }),
    );
    expect(out.report.code).toBe('active');
  });
});

describe('applyRecovery — work correction', () => {
  it('demotes a collecting run to degraded with a warning', () => {
    const before = { schemaVersion: 1, work: collectedWorkResult() } as const;
    const out = applyRecovery(before, baseInput());
    expect(out.report.work).toBe('stale');
    expect(out.results?.work?.latestRun?.status).toBe('degraded');
    expect(out.results?.work?.latestRun?.warning).toContain('no longer running');
  });

  it('preserves createdIds and artifacts on stale', () => {
    const before = { schemaVersion: 1, work: collectedWorkResult() } as const;
    const out = applyRecovery(before, baseInput());
    expect(out.results?.work?.artifacts.length).toBe(1);
    expect(out.results?.work?.latestRun?.createdIds).toEqual(['a1']);
  });

  it('does not rewrite a failed run (no demotion needed)', () => {
    const base = collectedWorkResult();
    const work = base.latestRun
      ? { ...base, latestRun: { ...base.latestRun, status: 'failed' as const } }
      : base;
    const out = applyRecovery({ schemaVersion: 1, work }, baseInput());
    expect(out.report.changed).toBe(false);
    expect(out.results?.work?.latestRun?.status).toBe('failed');
  });

  it('does not rewrite an already-degraded run', () => {
    const base = collectedWorkResult();
    const work = base.latestRun
      ? { ...base, latestRun: { ...base.latestRun, status: 'degraded' as const } }
      : base;
    const out = applyRecovery({ schemaVersion: 1, work }, baseInput());
    expect(out.report.changed).toBe(false);
  });

  it('does not rewrite a cancelled run', () => {
    const base = collectedWorkResult();
    const work = base.latestRun
      ? { ...base, latestRun: { ...base.latestRun, status: 'cancelled' as const } }
      : base;
    const out = applyRecovery({ schemaVersion: 1, work }, baseInput());
    expect(out.report.changed).toBe(false);
  });

  it('appends the recovery warning to an existing warning', () => {
    const base = collectedWorkResult();
    const work = base.latestRun
      ? { ...base, latestRun: { ...base.latestRun, warning: 'old note' } }
      : base;
    const out = applyRecovery({ schemaVersion: 1, work }, baseInput());
    const w = out.results?.work?.latestRun?.warning ?? '';
    expect(w).toContain('old note');
    expect(w).toContain('no longer running');
  });

  it('a missing-binding call is idempotent', () => {
    const before = { schemaVersion: 1, work: collectedWorkResult() } as const;
    const once = applyRecovery(before, baseInput({ workTaskId: null }));
    const twice = applyRecovery(once.results, baseInput({ workTaskId: null }));
    expect(once.results).toEqual(twice.results);
  });
});

describe('applyRecovery — code correction', () => {
  it('demotes a collecting code run to degraded with a warning', () => {
    const before: StoredConversationResults = {
      schemaVersion: 1,
      code: {
        latestRun: {
          meta: {
            runId: 'r-1',
            turnId: '',
            startedAt: NOW - 1000,
            finishedAt: NOW - 500,
            status: 'collecting',
          },
          attribution: 'run_delta',
          changes: [],
          checks: [],
          changeCountTotal: 0,
          checkCountTotal: 0,
          truncated: false,
        },
      },
    };
    const out = applyRecovery(before, baseInput({ workTaskId: null }));
    expect(out.report.code).toBe('stale');
    expect(out.results?.code?.latestRun?.meta.status).toBe('degraded');
    expect(out.results?.code?.latestRun?.meta.warning).toBeTruthy();
  });

  it('does not rewrite a failed code run', () => {
    const before: StoredConversationResults = {
      schemaVersion: 1,
      code: {
        latestRun: {
          meta: {
            runId: 'r-1',
            turnId: '',
            startedAt: NOW - 1000,
            status: 'failed',
          },
          attribution: 'run_delta',
          changes: [],
          checks: [],
          changeCountTotal: 0,
          checkCountTotal: 0,
          truncated: false,
        },
      },
    };
    const out = applyRecovery(before, baseInput({ workTaskId: null }));
    expect(out.report.changed).toBe(false);
    expect(out.results?.code?.latestRun?.meta.status).toBe('failed');
  });
});

describe('applyRecovery — schema + undefined inputs', () => {
  it('skips recovery for an undefined prior', () => {
    const out = applyRecovery(undefined, baseInput());
    expect(out.results).toBeUndefined();
    expect(out.report.changed).toBe(false);
  });

  it('skips recovery for an old schema', () => {
    const out = applyRecovery(
      { schemaVersion: 0, work: collectedWorkResult() } as unknown as StoredConversationResults,
      baseInput(),
    );
    expect(out.report.changed).toBe(false);
  });
});

describe('applyRecovery — independence', () => {
  it('Work verifier false + Code verifier true → only Work is rewritten', () => {
    const before: StoredConversationResults = {
      schemaVersion: 1,
      work: collectedWorkResult(),
      code: {
        latestRun: {
          meta: {
            runId: 'r-c',
            turnId: '',
            startedAt: NOW,
            status: 'collecting',
          },
          attribution: 'run_delta',
          changes: [],
          checks: [],
          changeCountTotal: 0,
          checkCountTotal: 0,
          truncated: false,
        },
      },
    };
    const out = applyRecovery(
      before,
      baseInput({ verifiers: baseVerifiers({ isCodeRunActive: () => true }) }),
    );
    expect(out.report.work).toBe('stale');
    expect(out.report.code).toBe('active');
    expect(out.results?.work?.latestRun?.status).toBe('degraded');
    expect(out.results?.code?.latestRun?.meta.status).toBe('collecting');
  });

  it('Code verifier false + Work verifier true → only Code is rewritten', () => {
    const before: StoredConversationResults = {
      schemaVersion: 1,
      work: collectedWorkResult(),
      code: {
        latestRun: {
          meta: {
            runId: 'r-c',
            turnId: '',
            startedAt: NOW,
            status: 'collecting',
          },
          attribution: 'run_delta',
          changes: [],
          checks: [],
          changeCountTotal: 0,
          checkCountTotal: 0,
          truncated: false,
        },
      },
    };
    const out = applyRecovery(
      before,
      baseInput({ verifiers: baseVerifiers({ isWorkTaskActive: () => true }) }),
    );
    expect(out.report.work).toBe('active');
    expect(out.report.code).toBe('stale');
    expect(out.results?.work?.latestRun?.status).toBe('collecting');
    expect(out.results?.code?.latestRun?.meta.status).toBe('degraded');
  });

  it('repeated recovery is idempotent (no further changes on the second pass)', () => {
    const before: StoredConversationResults = {
      schemaVersion: 1,
      work: collectedWorkResult(),
    };
    const once = applyRecovery(before, baseInput());
    const twice = applyRecovery(once.results, baseInput());
    expect(once.results).toEqual(twice.results);
  });
});
