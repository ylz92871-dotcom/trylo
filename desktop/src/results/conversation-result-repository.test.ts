// Trylo Desktop — P2-1 ConversationResultRepository + normalizer tests
// (spec §12.1). Pins project / conversation / mode isolation, over-limit
// truncation that preserves real totals, subscription scoping, corrupt /
// legacy hydration, and that serialization never leaks diff/output or
// absolute local artifact paths.

import { describe, it, expect } from 'vitest';

import { ConversationResultRepository } from './conversation-result-repository';
import { BOUNDS, normalizeConversationResults } from './conversation-result-normalizer';
import type { StoredCodeRunResult, StoredWorkResult } from './conversation-result-types';

function codeResult(over: Partial<StoredCodeRunResult> = {}): StoredCodeRunResult {
  return {
    meta: {
      runId: 'r1', turnId: 'u1', startedAt: 1000,
      status: 'completed', finishedAt: 2000,
    },
    attribution: 'run_delta',
    changes: [],
    checks: [],
    changeCountTotal: 0,
    checkCountTotal: 0,
    truncated: false,
    ...over,
  };
}

function workResult(over: Partial<StoredWorkResult> = {}): StoredWorkResult {
  return {
    artifacts: [],
    artifactCountTotal: 0,
    truncated: false,
    ...over,
  };
}

function oneArtifact(): StoredWorkResult {
  return {
    artifacts: [{
      id: 'file:src/a.md',
      target: { kind: 'file', relativePath: 'src/a.md' },
      displayName: 'a.md',
      artifactKind: 'file',
      version: 1,
      firstSeenAt: 1,
      updatedAt: 1,
      firstRunId: 'r1',
      lastRunId: 'r1',
      lastTurnId: 'u1',
      lastChange: 'created',
      sources: ['event'],
    }],
    artifactCountTotal: 1,
    truncated: false,
  };
}

describe('ConversationResultRepository (P2-1)', () => {
  it('hydrates an empty / old / corrupt schema and returns undefined snapshot', () => {
    const repo = new ConversationResultRepository();
    repo.hydrate('pA', 'cA', undefined);
    repo.hydrate('pA', 'cA', null);
    repo.hydrate('pA', 'cA', { not: 'results' });
    expect(repo.snapshot('pA', 'cA')).toBe( undefined);
  });

  it('isolates project A from project B, and conversation A from B', () => {
    const repo = new ConversationResultRepository();
    repo.update('pA', 'cA', () => ({ schemaVersion: 1, code: { latestRun: codeResult() } }));
    repo.update('pA', 'cB', () => ({ schemaVersion: 1, work: workResult() }));
    repo.update('pB', 'cA', () => ({ schemaVersion: 1, code: { latestRun: codeResult({ meta: { runId: 'rX', turnId: 'u', startedAt: 0, status: 'completed' } }) } }));

    expect(repo.snapshot('pA', 'cA')?.code?.latestRun?.meta.runId).toBe( 'r1');
    expect(repo.snapshot('pA', 'cA')?.work).toBe( undefined);
    expect(repo.snapshot('pA', 'cB')?.work).toBe( undefined);
    expect(repo.snapshot('pB', 'cA')?.code?.latestRun?.meta.runId).toBe( 'rX');
  });

  it('code and work results coexist without overwriting each other', () => {
    const repo = new ConversationResultRepository();
    repo.update('pA', 'cA', () => ({ schemaVersion: 1, code: { latestRun: codeResult() } }));
    repo.update('pA', 'cA', (prev) => ({ ...prev, work: oneArtifact() }));
    const snap = repo.snapshot('pA', 'cA');
    expect(snap?.code?.latestRun).toBeTruthy();
    expect(snap?.work).toBeTruthy();
    expect(snap?.work?.artifactCountTotal).toBe(1);
  });

  it('clips over-limit changes/checks but preserves the real totals', () => {
    const changes = Array.from({ length: BOUNDS.codeChanges + 10 }, (_, i) => ({
      path: `src/a${i}.ts`, kind: 'modified' as const,
      staged: false, unstaged: true, untracked: false,
    }));
    const result = normalizeConversationResults({
      schemaVersion: 1,
      code: {
        latestRun: {
          ...codeResult(),
          changes,
          changeCountTotal: changes.length,
        },
      },
    });
    const latest = result?.code?.latestRun;
    expect(latest?.changes.length).toBe( BOUNDS.codeChanges);
    expect(latest?.changeCountTotal).toBe( changes.length);
    expect(latest?.truncated).toBe( true);
  });

  it('drops unknown fields and never leaks diff/output', () => {
    const raw = {
      schemaVersion: 1,
      code: {
        latestRun: {
          ...codeResult(),
          diff: 'THIS DIFF MUST NOT SURVIVE',
          output: 'SECRET OUTPUT',
        },
      },
      notAField: 'gone',
    };
    const normalized = normalizeConversationResults(raw);
    const json = JSON.stringify(normalized);
    expect(json).not.toContain('THIS DIFF MUST NOT SURVIVE');
    expect(json).not.toContain('SECRET OUTPUT');
    expect(json).not.toContain('notAField');
    // Whitelist keeps only the known shape.
    expect(json).toContain('latestRun');
  });

  it('round-trips WP-4 diff-stats optional fields and drops negatives', () => {
    const result = normalizeConversationResults({
      schemaVersion: 1,
      code: {
        latestRun: {
          ...codeResult(),
          additionsTotal: 128,
          deletionsTotal: 24,
          statsComplete: true,
          changes: [
            {
              path: 'src/a.ts', kind: 'modified' as const,
              staged: false, unstaged: true, untracked: false,
              additions: 100, deletions: -5, // negative deletions must be dropped
            },
            {
              path: 'img.bin', kind: 'added' as const,
              staged: false, unstaged: false, untracked: true,
              binary: true,
            },
          ],
          changeCountTotal: 2,
        },
      },
    });
    const latest = result?.code?.latestRun;
    expect(latest?.additionsTotal).toBe(128);
    expect(latest?.deletionsTotal).toBe(24);
    expect(latest?.statsComplete).toBe(true);
    const modified = latest?.changes.find((c) => c.path === 'src/a.ts');
    expect(modified?.additions).toBe(100);
    expect(modified?.deletions).toBeUndefined(); // negative dropped
    expect(latest?.changes.find((c) => c.path === 'img.bin')?.binary).toBe(true);
  });

  it('reads legacy records without the WP-4 stats fields', () => {
    const raw = {
      schemaVersion: 1,
      code: { latestRun: codeResult() },
    };
    const latest = normalizeConversationResults(raw)?.code?.latestRun;
    expect(latest?.additionsTotal).toBeUndefined();
    expect(latest?.statsComplete).toBeUndefined();
    expect(latest?.changes).toEqual([]);
  });

  it('notifies only the matching subscription on update', () => {
    const repo = new ConversationResultRepository();
    const hits: string[] = [];
    const unsubA = repo.subscribe((s) => hits.push(`${s.projectKey}/${s.conversationId}`));
    const unsubB = repo.subscribe((s) => hits.push(`B:${s.conversationId}`));
    repo.update('pA', 'cA', () => ({ schemaVersion: 1, code: { latestRun: codeResult() } }));
    repo.update('pB', 'cZ', () => ({ schemaVersion: 1, work: workResult() }));
    unsubA();
    repo.update('pA', 'cA', () => ({ schemaVersion: 1 }));
    unsubB();
    // Both listeners saw the first two updates; after unsubA only B remains.
    expect(hits.includes('pA/cA')).toBe(true);
    expect(hits.includes('B:cZ')).toBe(true);
  });
});

// ── PR-5 (spec §11): verification verdict whitelist ────────────────────
// The verdict is delivery metadata persisted NEXT TO the artifact. The
// whitelist keeps the closed vocabulary closed: unknown statuses, free-text
// reason codes and unbounded fields are dropped — never passed to disk.

describe('PR-5 verification normalizer (§11 / §4.6)', () => {
  function artifactWithVerification(verification: unknown) {
    return {
      schemaVersion: 1,
      work: {
        artifacts: [{
          id: '.trylo/out/report.docx',
          target: { kind: 'file', relativePath: '.trylo/out/report.docx' },
          displayName: 'report.docx',
          artifactKind: 'document',
          version: 1,
          firstSeenAt: 1,
          updatedAt: 1,
          firstRunId: 'r1',
          lastRunId: 'r1',
          lastTurnId: 't1',
          lastChange: 'created',
          sources: ['event'],
          ...(verification !== undefined ? { verification } : {}),
        }],
        artifactCountTotal: 1,
        truncated: false,
      },
    };
  }

  it('round-trips a valid verification verdict', () => {
    const verification = {
      status: 'partial',
      checkedAt: 5000,
      checks: [{ id: 'file-present', status: 'passed' }, { id: 'officecli-validate', status: 'skipped', reasonCode: 'not_installed' }],
      skippedCapabilities: ['officecli:not_installed'],
    };
    const normalized = normalizeConversationResults(artifactWithVerification(verification));
    expect(normalized?.work?.artifacts[0]?.verification).toEqual(verification);
  });

  it('keeps schemaVersion 1 (new optional field, no shape bump)', () => {
    const normalized = normalizeConversationResults(artifactWithVerification({
      status: 'failed',
      checkedAt: 1,
      checks: [{ id: 'container-match', status: 'failed', reasonCode: 'container_mismatch' }],
    }));
    expect(normalized?.schemaVersion).toBe(1);
    expect(normalized?.work?.artifacts[0]?.verification?.status).toBe('failed');
  });

  it('drops an unknown verification status and free-text reason codes', () => {
    const normalized = normalizeConversationResults(artifactWithVerification({
      status: 'maybe-pass',
      checkedAt: 1,
      checks: [{ id: 'structure', status: 'passed', reasonCode: 'looks fine to me!!!' }],
    }));
    expect(normalized?.work?.artifacts[0]?.verification).toBeUndefined();
  });

  it('drops unknown check ids and clips detail and capability lists', () => {
    const manyChecks = Array.from({ length: 20 }, () => ({ id: 'structure', status: 'passed' as const }));
    const normalized = normalizeConversationResults(artifactWithVerification({
      status: 'partial',
      checkedAt: 1,
      checks: [...manyChecks, { id: 'nonsense-check', status: 'passed' }],
      skippedCapabilities: ['officecli:not_installed', 'x'.repeat(300), 'libreoffice:missing'],
    }));
    const verification = normalized?.work?.artifacts[0]?.verification;
    expect(verification?.checks.length).toBeLessThanOrEqual(BOUNDS.verificationChecks);
    expect(verification?.checks.every((entry) => entry.id === 'structure')).toBe(true);
    expect(verification?.skippedCapabilities?.length).toBeLessThanOrEqual(BOUNDS.verificationCapabilities);
    expect(verification?.skippedCapabilities?.some((entry) => entry.length > 80)).toBe(false);
  });

  it('a legacy artifact without a verdict survives unchanged', () => {
    const normalized = normalizeConversationResults(artifactWithVerification(undefined));
    expect(normalized?.work?.artifacts[0]?.verification).toBeUndefined();
    expect(normalized?.work?.artifacts[0]?.displayName).toBe('report.docx');
  });
});