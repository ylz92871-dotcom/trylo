// Trylo Desktop — WorkResultContent tests (P2-1, spec §12.2 / §8.6).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkResultContent, latestRunArtifactCount } from './WorkResultContent';
import type { StoredWorkArtifact, StoredWorkResult } from '../../results/conversation-result-types';

afterEach(() => cleanup());

const host = {
  openFile: async () => undefined,
  openFileWithApp: async () => undefined,
  showInFolder: async () => undefined,
  copyToClipboard: async () => undefined,
};

function artifact(partial: Partial<StoredWorkArtifact> = {}): StoredWorkArtifact {
  return {
    id: 'a.md',
    target: { kind: 'file', relativePath: '.trylo/out/a.md' },
    displayName: 'a.md',
    artifactKind: 'document',
    version: 1,
    firstSeenAt: 1,
    updatedAt: 2,
    firstRunId: 'r1',
    lastRunId: 'r1',
    lastTurnId: 't1',
    lastChange: 'created',
    sources: ['event', 'scan'],
    ...partial,
  } as StoredWorkArtifact;
}

function workResult(partial: Partial<StoredWorkResult> = {}): StoredWorkResult {
  return {
    artifacts: [],
    artifactCountTotal: 0,
    truncated: false,
    ...partial,
  };
}

function renderArtifacts(result: StoredWorkResult) {
  return render(
    <WorkResultContent
      result={result}
      workspaceRoot="D:/repo"
      host={host}
    />,
  );
}

describe('WorkResultContent (P2-1 §8.6)', () => {
  it('reports zero current-run artifacts when only historical files exist', () => {
    const result = workResult({
      artifacts: [artifact()],
      artifactCountTotal: 1,
      latestRun: {
        runId: 'chat-run', turnId: 'chat-turn', startedAt: 3,
        status: 'completed', createdIds: [], updatedIds: [], discoveredIds: [],
      },
    });
    expect(latestRunArtifactCount(result)).toBe(0);
  });

  it('hides the previous run delta as soon as a newer user turn is current', () => {
    const result = workResult({
      artifacts: [artifact()],
      artifactCountTotal: 1,
      latestRun: {
        runId: 'r-old', turnId: 'turn-old', startedAt: 1,
        status: 'completed', createdIds: ['a.md'], updatedIds: [], discoveredIds: [],
      },
    });
    expect(latestRunArtifactCount(result, { turnId: 'turn-new' })).toBe(0);
    expect(latestRunArtifactCount(result, { turnId: 'turn-old' })).toBe(1);
  });

  it('attributes a reused-runtime result by run id when its turn id is missing', () => {
    const result = workResult({
      artifacts: [artifact()],
      artifactCountTotal: 1,
      latestRun: {
        runId: 'r-current', turnId: '', startedAt: 1,
        status: 'completed', createdIds: ['a.md'], updatedIds: [], discoveredIds: [],
      },
    });
    expect(latestRunArtifactCount(result, { turnId: 'turn-current' })).toBe(0);
    expect(latestRunArtifactCount(result, { turnId: 'turn-current', runId: 'r-current' })).toBe(1);
    expect(latestRunArtifactCount(result, { runId: 'r-other' })).toBe(0);
  });

  it('deduplicates latest-run artifact ids for the dock count', () => {
    const result = workResult({
      artifacts: [artifact()],
      artifactCountTotal: 1,
      latestRun: {
        runId: 'r1', turnId: 't1', startedAt: 1,
        status: 'completed', createdIds: ['a.md'], updatedIds: ['a.md'], discoveredIds: [],
      },
    });
    expect(latestRunArtifactCount(result)).toBe(1);
  });

  it('shows nothing recorded when the conversation has no artifacts', () => {
    renderArtifacts(workResult());
    expect(screen.getByText('本轮还没有可交付的产物。')).toBeTruthy();
  });

  it('renders an artifact card and marks a latest-run created item as new', () => {
    renderArtifacts(workResult({
      artifacts: [artifact()],
      artifactCountTotal: 1,
      latestRun: { runId: 'r1', turnId: 't1', startedAt: 1, status: 'completed', createdIds: ['a.md'], updatedIds: [], discoveredIds: [] },
    }));
    expect(screen.getByText('a.md')).toBeTruthy();
    expect(screen.getByText('新建')).toBeTruthy();
  });

  it('renders updated · vN for a latest-run updated item', () => {
    renderArtifacts(workResult({
      artifacts: [artifact({ lastChange: 'updated', version: 2 })],
      artifactCountTotal: 1,
      latestRun: { runId: 'r2', turnId: 't2', startedAt: 2, status: 'completed', createdIds: [], updatedIds: ['a.md'], discoveredIds: [] },
    }));
    expect(screen.getByText('已更新 · v2')).toBeTruthy();
  });

  it('renders a discovered badge from the latest-run list', () => {
    renderArtifacts(workResult({
      artifacts: [artifact({ lastChange: 'discovered' })],
      artifactCountTotal: 1,
      latestRun: { runId: 'r9', turnId: 't9', startedAt: 9, status: 'completed', createdIds: [], updatedIds: [], discoveredIds: ['a.md'] },
    }));
    expect(screen.getByText('已发现')).toBeTruthy();
  });

  it('does not badge an unchanged artifact (version not implied by sources)', () => {
    renderArtifacts(workResult({
      artifacts: [artifact({ lastChange: 'unchanged' })],
      artifactCountTotal: 1,
      // It has TWO sources yet no run delta — §8.6: sources length is NOT the
      // updated signal.
      latestRun: { runId: 'r3', turnId: 't3', startedAt: 3, status: 'completed', createdIds: [], updatedIds: [], discoveredIds: [] },
    }));
    expect(screen.queryByText('已更新 · v1')).toBeNull();
    expect(screen.queryByText('新建')).toBeNull();
    expect(screen.getByText('a.md')).toBeTruthy();
  });

  it('renders a generic File card for an unknown-extension artifact (not a pretend document)', () => {
    const { container } = renderArtifacts(workResult({
      artifacts: [artifact({ id: 'out.log', target: { kind: 'file', relativePath: '.trylo/out/out.log' }, displayName: 'out.log', artifactKind: 'file' })],
      artifactCountTotal: 1,
    }));
    // The card renders as a generic "File" (artifact-card--file) — not a
    // pretend document with a fabricated Office "Open with" submenu (§8.6).
    expect(container.querySelector('.artifact-card--file')).not.toBeNull();
    expect(container.querySelector('.artifact-card--document')).toBeNull();
    expect(screen.getByText('out.log')).toBeTruthy();
  });

  it('never hands an unsafe persisted path to a live card', () => {
    renderArtifacts(workResult({
      artifacts: [artifact({ id: 'evil', target: { kind: 'file', relativePath: '../secret' }, displayName: 'evil' })],
      artifactCountTotal: 1,
    }));
    expect(screen.getByText('路径不可用')).toBeTruthy();
    expect(screen.queryByText('evil')?.tagName).toBe('SPAN');
  });
});

// ── PR-5 (spec §11): delivery-verification badges ──────────────────────
// The ResultDock shows the three honest states (已验证 / 部分验证 / 验证失败)
// plus a muted 未验证 for skipped files. A verdict never rewrites the agent's
// answer; an artifact without a verdict simply has no badge.

describe('WorkResultContent — PR-5 verification badges (§11)', () => {
  function verifiedArtifact(): StoredWorkArtifact {
    return artifact({
      id: '.trylo/out/report.docx',
      target: { kind: 'file', relativePath: '.trylo/out/report.docx' },
      displayName: 'report.docx',
      artifactKind: 'document',
      verification: {
        status: 'verified',
        checkedAt: 1,
        checks: [
          { id: 'file-present', status: 'passed' },
          { id: 'container-match', status: 'passed' },
          { id: 'structure', status: 'passed' },
          { id: 'officecli-validate', status: 'passed' },
          { id: 'libreoffice-roundtrip', status: 'passed' },
        ],
      },
    });
  }

  function resultWith(...artifactsList: StoredWorkArtifact[]): StoredWorkResult {
    return workResult({
      artifacts: artifactsList,
      artifactCountTotal: artifactsList.length,
      latestRun: {
        runId: 'r-verify', turnId: 't-verify', startedAt: 1, status: 'completed',
        createdIds: artifactsList.map((entry) => entry.id), updatedIds: [], discoveredIds: [],
      },
    });
  }

  it('renders the verified badge and the aggregate line', () => {
    const { container } = renderArtifacts(resultWith(verifiedArtifact()));
    expect(screen.getByText('已验证')).toBeTruthy();
    expect(screen.getByText('交付验证：已验证 1')).toBeTruthy();
    expect(container.querySelector('.work-result__verify--verified')).not.toBeNull();
  });

  it('renders partial and failed badges next to their artifacts', () => {
    renderArtifacts(resultWith(
      verifiedArtifact(),
      artifact({
        id: '.trylo/out/failed.docx',
        target: { kind: 'file', relativePath: '.trylo/out/failed.docx' },
        displayName: 'failed.docx',
        artifactKind: 'document',
        verification: {
          status: 'failed',
          checkedAt: 1,
          checks: [{ id: 'container-match', status: 'failed', reasonCode: 'container_mismatch', detail: '不是 ZIP 容器' }],
        },
      }),
      artifact({
        id: '.trylo/out/partial.docx',
        target: { kind: 'file', relativePath: '.trylo/out/partial.docx' },
        displayName: 'partial.docx',
        artifactKind: 'document',
        verification: {
          status: 'partial',
          checkedAt: 1,
          checks: [{ id: 'structure', status: 'passed' }],
          skippedCapabilities: ['officecli:not_installed'],
        },
      }),
    ));
    expect(screen.getByText('验证失败')).toBeTruthy();
    expect(screen.getByText('部分验证')).toBeTruthy();
    expect(screen.getByText('交付验证：已验证 1 · 部分验证 1 · 验证失败 1')).toBeTruthy();
  });

  it('an artifact without a verdict has no badge (never an implied pass)', () => {
    const { container } = renderArtifacts(resultWith(artifact()));
    expect(container.querySelector('.work-result__verify')).toBeNull();
    expect(screen.queryByText(/^交付验证/)).toBeNull();
  });

  it('a skipped file shows the muted 未验证 state', () => {
    const { container } = renderArtifacts(resultWith(artifact({
      id: '.trylo/out/shot.png',
      target: { kind: 'file', relativePath: '.trylo/out/shot.png' },
      displayName: 'shot.png',
      verification: { status: 'skipped', checkedAt: 1, checks: [], reasonCode: 'not_office_file' },
    })));
    expect(screen.getByText('未验证')).toBeTruthy();
    expect(container.querySelector('.work-result__verify--skipped')).not.toBeNull();
  });
});
