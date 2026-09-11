// Trylo Desktop — Office validation verdict folding (PR-5, spec §11).
//
// These are the pure mappings between the sidecar's protocol verdict and the
// persisted results-domain record. The invariants: a closed vocabulary
// survives the fold, nothing free-text sneaks through, and a result without
// a verdict is never implied to have passed (§4.4).

import { describe, expect, it } from 'vitest';
import {
  attachVerifications,
  hasFailedVerification,
  verificationFromProtocol,
  verificationSummary,
  type ToolingOfficeArtifactValidation,
} from './office-validation';
import type { ToolingOfficeCheckId, ToolingOfficeCheckStatus } from '../services-host/methods';
import type { StoredWorkArtifact } from '../results/conversation-result-types';

function artifact(partial: Partial<StoredWorkArtifact> = {}): StoredWorkArtifact {
  return {
    id: '.trylo/out/report.docx',
    target: { kind: 'file', relativePath: '.trylo/out/report.docx' },
    displayName: 'report.docx',
    artifactKind: 'document',
    version: 1,
    firstSeenAt: 1,
    updatedAt: 2,
    firstRunId: 'r1',
    lastRunId: 'r1',
    lastTurnId: 't1',
    lastChange: 'created',
    sources: ['event'],
    ...partial,
  };
}

function verdict(partial: Partial<ToolingOfficeArtifactValidation> = {}): ToolingOfficeArtifactValidation {
  return {
    id: '.trylo/out/report.docx',
    relativePath: '.trylo/out/report.docx',
    status: 'verified',
    checks: [
      { id: 'file-present', status: 'passed' },
      { id: 'container-match', status: 'passed' },
    ],
    skippedCapabilities: [],
    checkedAt: 1000,
    ...partial,
  };
}

describe('verificationFromProtocol (§11 protocol → persisted verdict)', () => {
  it('maps a valid protocol verdict into the persisted record', () => {
    const mapped = verificationFromProtocol(verdict());
    expect(mapped).toEqual({
      status: 'verified',
      checkedAt: 1000,
      checks: [
        { id: 'file-present', status: 'passed' },
        { id: 'container-match', status: 'passed' },
      ],
    });
  });

  it('drops an unknown status (a tampered protocol answer is not a verdict)', () => {
    expect(verificationFromProtocol(verdict({ status: 'hacked' as never }))).toBeUndefined();
    expect(verificationFromProtocol(undefined)).toBeUndefined();
  });

  it('keeps only the closed check vocabulary', () => {
    const mapped = verificationFromProtocol(verdict({
      checks: [
        { id: 'file-present', status: 'passed' },
        { id: 'mystery' as unknown as ToolingOfficeCheckId, status: 'passed' },
        { id: 'structure', status: 'weird' as unknown as ToolingOfficeCheckStatus },
      ],
    }));
    expect(mapped?.checks).toHaveLength(1);
    expect(mapped?.checks[0]?.id).toBe('file-present');
  });

  it('keeps the skipped-capability reasons and the skip reason code', () => {
    const mapped = verificationFromProtocol(verdict({
      status: 'partial',
      skippedCapabilities: ['officecli:not_installed'],
      reasonCode: 'budget_exhausted',
    }));
    expect(mapped?.skippedCapabilities).toEqual(['officecli:not_installed']);
    expect(mapped?.reasonCode).toBe('budget_exhausted');
  });
});

describe('attachVerifications (§11 verdict folding)', () => {
  it('attaches verdicts matched by artifact id', () => {
    const artifacts = [artifact(), artifact({ id: 'other', target: { kind: 'file', relativePath: 'other' }, displayName: 'other' })];
    const next = attachVerifications(artifacts, [verdict({ status: 'failed', checks: [{ id: 'structure', status: 'failed' }] })]);
    expect(next[0]?.verification?.status).toBe('failed');
    expect(next[1]?.verification).toBeUndefined();
    expect(artifacts[0]?.verification).toBeUndefined();
  });

  it('falls back to the relative path when ids differ', () => {
    const artifacts = [artifact({ id: 'stored-id-1' })];
    const next = attachVerifications(artifacts, [verdict({ id: 'sidecar-id-9', status: 'partial' })]);
    expect(next[0]?.verification?.status).toBe('partial');
  });

  it('returns the SAME array object when nothing matched (cheap no-change)', () => {
    const artifacts = [artifact()];
    const next = attachVerifications(artifacts, [verdict({ id: 'nope', relativePath: 'nope' })]);
    expect(next).toBe(artifacts);
  });

  it('a verdict is not a content change — timeline fields stay untouched', () => {
    const before = artifact({ updatedAt: 42, version: 3 });
    const next = attachVerifications([before], [verdict()])[0];
    expect(next?.updatedAt).toBe(42);
    expect(next?.version).toBe(3);
  });
});

describe('verificationSummary / hasFailedVerification (§11 dock states)', () => {
  it('aggregates the three honest states', () => {
    const artifacts = [
      artifact({ verification: { status: 'verified', checkedAt: 1, checks: [] } }),
      artifact({ id: 'p', target: { kind: 'file', relativePath: 'p' }, displayName: 'p', verification: { status: 'partial', checkedAt: 1, checks: [], skippedCapabilities: ['officecli:not_installed'] } }),
      artifact({ id: 'f', target: { kind: 'file', relativePath: 'f' }, displayName: 'f', verification: { status: 'failed', checkedAt: 1, checks: [{ id: 'structure', status: 'failed' }] } }),
      artifact({ id: 'unverified', target: { kind: 'file', relativePath: 'u' }, displayName: 'u' }),
    ];
    expect(verificationSummary(artifacts)).toEqual({ verified: 1, partial: 1, failed: 1 });
    expect(hasFailedVerification(artifacts)).toBe(true);
  });

  it('returns null when no artifact carries a verdict (nothing implied)', () => {
    const artifacts = [artifact(), artifact({ id: 'x', target: { kind: 'file', relativePath: 'x' }, displayName: 'x' })];
    expect(verificationSummary(artifacts)).toBeNull();
    expect(hasFailedVerification(artifacts)).toBe(false);
  });
});
