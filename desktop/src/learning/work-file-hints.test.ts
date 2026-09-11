// work-file-hints.ts：Work fileHints 采集（TRYLO-DUAL-SURFACE-SPEC §2.2 / §2.6）。

import { describe, it, expect } from 'vitest';
import {
  collectWorkFileHints,
  deliverableSlug,
  isAllowlistedDeliverableRel,
  isWorkDeliverablePath,
  MAX_FILE_HINTS,
} from './work-file-hints';
import type { StoredWorkArtifact } from '../results/conversation-result-types';

function fileArtifact(id: string, extra: Partial<StoredWorkArtifact> = {}): StoredWorkArtifact {
  return {
    id,
    target: { kind: 'file', relativePath: id },
    displayName: id.split('/').pop() ?? id,
    artifactKind: 'file',
    version: 1,
    firstSeenAt: 1,
    updatedAt: 1,
    firstRunId: 'r1',
    lastRunId: 'r1',
    lastTurnId: 'turn-1',
    lastChange: 'created',
    sources: ['event'],
    ...extra,
  } as StoredWorkArtifact;
}

describe('isWorkDeliverablePath', () => {
  it('allows .trylo/out deliverables', () => {
    expect(isWorkDeliverablePath('.trylo/out/周报.pptx')).toBe(true);
    expect(isWorkDeliverablePath('.trylo/out/sub/notes.md')).toBe(true);
    expect(isWorkDeliverablePath('.\\\\.trylo\\\\out\\\\a.pdf')).toBe(true); // Windows separators
  });

  it('denies runtime / cache / attachments and traversal', () => {
    expect(isWorkDeliverablePath('.trylo/out/runtime/x.bin')).toBe(false);
    expect(isWorkDeliverablePath('.trylo/out/cache/y')).toBe(false);
    expect(isWorkDeliverablePath('.trylo/out/attachments/z')).toBe(false);
    expect(isWorkDeliverablePath('.trylo/out/foo/../runtime/x')).toBe(false);
    expect(isWorkDeliverablePath('.trylo/out/../secret')).toBe(false);
  });

  it('denies non-.trylo/out roots', () => {
    expect(isWorkDeliverablePath('.trylo/outbox/foo.pptx')).toBe(false);
    expect(isWorkDeliverablePath('templates/foo.md')).toBe(false);
    expect(isWorkDeliverablePath('/abs/path')).toBe(false);
    expect(isWorkDeliverablePath('.trylo/out')).toBe(false);
  });

  it('denies NUL and a trailing empty segment', () => {
    expect(isWorkDeliverablePath('.trylo/out/a\u0000b')).toBe(false);
    expect(isWorkDeliverablePath('.trylo/out/a.pptx/')).toBe(false);
  });
});

describe('isAllowlistedDeliverableRel', () => {
  it('allows only whitelisted deliverable extensions', () => {
    expect(isAllowlistedDeliverableRel('.trylo/out/a.pptx')).toBe(true);
    expect(isAllowlistedDeliverableRel('.trylo/out/a.PDF')).toBe(true);
    expect(isAllowlistedDeliverableRel('.trylo/out/a.txt')).toBe(false);
    expect(isAllowlistedDeliverableRel('.trylo/out/a.exe')).toBe(false);
    expect(isAllowlistedDeliverableRel('.trylo/out/runtime/a.pptx')).toBe(false);
  });
});

describe('collectWorkFileHints', () => {
  it('captures a baseline-diff new file that belongs to the conversation', () => {
    const hints = collectWorkFileHints({
      snapshot: { artifacts: [fileArtifact('.trylo/out/周报.pptx')] },
      turnId: 'turn-2',
      baselineRelPaths: ['.trylo/out/old.pdf'],
      terminalRelPaths: ['.trylo/out/old.pdf', '.trylo/out/周报.pptx'],
    });
    expect(hints).toEqual(['.trylo/out/周报.pptx']);
  });

  it('captures a snapshot-delta file without relying on the listing', () => {
    const hints = collectWorkFileHints({
      snapshot: {
        latestRun: {
          turnId: 'turn-2',
          createdIds: ['.trylo/out/notes.pdf'],
          updatedIds: [],
          discoveredIds: [],
        },
        artifacts: [fileArtifact('.trylo/out/notes.pdf', { lastTurnId: 'turn-2' })],
      },
      turnId: 'turn-2',
      baselineRelPaths: [],
      terminalRelPaths: [],
    });
    expect(hints).toEqual(['.trylo/out/notes.pdf']);
  });

  it('drops un-owned baseline-diff files (H1 / R16 cross-conversation isolation)', () => {
    // A's store knows only A's deck; B.pptx appears in the shared listing but
    // is NOT owned by A → fail-closed.
    const hints = collectWorkFileHints({
      snapshot: { artifacts: [fileArtifact('.trylo/out/A.pptx')] },
      turnId: 'turn-1',
      baselineRelPaths: [],
      terminalRelPaths: ['.trylo/out/A.pptx', '.trylo/out/B.pptx'],
    });
    expect(hints).not.toContain('.trylo/out/B.pptx');
    expect(hints).toContain('.trylo/out/A.pptx');
  });

  it('recovery path: scan-only artifacts are NOT ownership — foreign files cannot leak (P0-1)', () => {
    // Crash-recovered conversation: known.size === 0 at scopeScan, so the
    // projector ingested the WHOLE shared .trylo/out with sources
    // ['recovery'] and stamped every file lastTurnId = this turn. None of it
    // is event evidence — the snapshot must not count as ownership.
    const foreign = fileArtifact('.trylo/out/B-conversation-deck.pptx', {
      lastTurnId: 'turn-2',
      sources: ['recovery'],
    });
    const mineRecovered = fileArtifact('.trylo/out/my-earlier-deck.pptx', {
      lastTurnId: 'turn-2',
      sources: ['recovery'],
    });
    const hints = collectWorkFileHints({
      snapshot: {
        latestRun: {
          turnId: 'turn-2',
          createdIds: [],
          updatedIds: [],
          discoveredIds: [foreign.id, mineRecovered.id],
        },
        artifacts: [foreign, mineRecovered],
      },
      turnId: 'turn-2',
      baselineRelPaths: [],
      terminalRelPaths: [foreign.id, mineRecovered.id],
    });
    // Fail closed: no event-sourced file ⇒ no hints at all, even for files
    // the recovery scan happened to sweep in that were once ours.
    expect(hints).toEqual([]);
  });

  it('recovery path: rule-1 delta cannot capture scan-only foreign files stamped with this turn', () => {
    // The harsher half of P0-1: rule 1 (delta) matched on lastTurnId and
    // never did the ownership check, so finishRun's recovery stamping leaked
    // conversation B's files into A's fileHints even without a baseline diff.
    const foreignDelta = fileArtifact('.trylo/out/B-other-file.pdf', {
      lastTurnId: 'turn-2',
      sources: ['recovery'],
      lastChange: 'discovered',
    });
    const hints = collectWorkFileHints({
      snapshot: {
        latestRun: {
          turnId: 'turn-2',
          createdIds: [],
          updatedIds: [],
          discoveredIds: [foreignDelta.id],
        },
        artifacts: [foreignDelta],
      },
      turnId: 'turn-2',
      baselineRelPaths: [],
      terminalRelPaths: [],
    });
    expect(hints).toEqual([]);
  });

  it('event-sourced ownership survives a scan corroboration (sources merge)', () => {
    // This conversation's own evented file, later re-seen by the terminal
    // scan: sources become ['event','scan'] and it stays capturable.
    const own = fileArtifact('.trylo/out/own-deck.pptx', {
      lastTurnId: 'turn-2',
      sources: ['event', 'scan'],
    });
    const hints = collectWorkFileHints({
      snapshot: {
        latestRun: {
          turnId: 'turn-2',
          createdIds: [],
          updatedIds: [],
          discoveredIds: [own.id],
        },
        artifacts: [own],
      },
      turnId: 'turn-2',
      baselineRelPaths: [],
      terminalRelPaths: [own.id],
    });
    expect(hints).toEqual(['.trylo/out/own-deck.pptx']);
  });

  it('event-sourced baseline-diff capture works even when the latestRun delta is recovery-only', () => {
    // Normal path regression guard: an evented file passes rule 2.
    const own = fileArtifact('.trylo/out/created-now.pptx', {
      lastTurnId: 'turn-2',
      sources: ['event'],
    });
    const hints = collectWorkFileHints({
      snapshot: {
        latestRun: {
          turnId: 'turn-2',
          createdIds: [own.id],
          updatedIds: [],
          discoveredIds: [],
        },
        artifacts: [own],
      },
      turnId: 'turn-2',
      baselineRelPaths: [],
      terminalRelPaths: [own.id],
    });
    expect(hints).toEqual(['.trylo/out/created-now.pptx']);
  });

  it('deduplicates: a path that is both delta and new keeps the new priority once', () => {
    const hints = collectWorkFileHints({
      snapshot: {
        latestRun: {
          turnId: 'turn-1',
          createdIds: [],
          updatedIds: ['.trylo/out/dual.pdf'],
          discoveredIds: [],
        },
        artifacts: [fileArtifact('.trylo/out/dual.pdf', { lastTurnId: 'turn-1' })],
      },
      turnId: 'turn-1',
      baselineRelPaths: [],
      terminalRelPaths: ['.trylo/out/dual.pdf', '.trylo/out/single.pdf'],
    });
    // single.pdf owned? no — it is not in snapshot artitfacts → dropped (H1).
    expect(hints.filter((h) => h === '.trylo/out/dual.pdf')).toHaveLength(1);
  });

  it('filters by deliverable extension', () => {
    const hints = collectWorkFileHints({
      snapshot: {
        artifacts: [
          fileArtifact('.trylo/out/ok.pptx'),
          fileArtifact('.trylo/out/note.txt'),
        ],
      },
      turnId: 'turn-1',
      baselineRelPaths: [],
      terminalRelPaths: ['.trylo/out/ok.pptx', '.trylo/out/note.txt'],
    });
    expect(hints).toEqual(['.trylo/out/ok.pptx']);
  });

  it('caps at MAX_FILE_HINTS', () => {
    const artifacts = Array.from({ length: 60 }, (_, i) => fileArtifact(`.trylo/out/f${i}.pdf`));
    const hints = collectWorkFileHints({
      snapshot: { artifacts },
      turnId: 'turn-1',
      baselineRelPaths: [],
      terminalRelPaths: artifacts.map((a) => (a.target as { relativePath: string }).relativePath),
    });
    expect(hints.length).toBeLessThanOrEqual(MAX_FILE_HINTS);
  });
});

describe('deliverableSlug', () => {
  it('produces an ASCII slug preserving the extension', () => {
    expect(deliverableSlug('weekly-report.pptx')).toBe('weekly-report.pptx');
    expect(deliverableSlug('Q3 Board Deck.PPTX')).toBe('q3-board-deck.pptx');
  });

  it('returns null when there is no usable ASCII base', () => {
    expect(deliverableSlug('周报.pptx')).toBeNull();
    expect(deliverableSlug('')).toBeNull();
  });
});