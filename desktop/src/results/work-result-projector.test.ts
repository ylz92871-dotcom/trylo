// Trylo Desktop — WorkResultProjector tests (P2-1, spec §8.2 / §12.1).
//
// The projector is a thin orchestration over the scoped Work store: it
// captures the baseline at run start (injected scan), routes events, finalises
// exactly once on terminal, and pushes a mapped StoredWorkResult through the
// port. Merge/version semantics live in the Work store (covered by the Work
// suite); here we pin the orchestration, the mapping, exactly-once and the
// degraded / recovery paths.

import { describe, it, expect } from 'vitest';
import { WorkResultProjector, type WorkResultStorePort } from './work-result-projector';
import type { StoredWorkResult } from './conversation-result-types';
import type { WorkArtifactScope, ScannedArtifact } from '@trylo/work';
import type { WorkScanOutcome } from './work-artifact-scanner';

const PROJECT = 'ws-P';
const ROOT = 'D:/repo';

function scope(runId: string, conversationId = 'c1', turnId = 't1', startedAt = 1000): WorkArtifactScope {
  return {
    projectKey: PROJECT,
    projectRoot: ROOT,
    conversationId,
    taskId: 'task-x',
    runId,
    turnId,
    startedAt,
  };
}

function scanned(rel: string, size = 10, modifiedMs = 1): ScannedArtifact {
  return {
    target: { kind: 'file', relativePath: rel },
    id: rel,
    displayName: rel.split('/').pop() ?? rel,
    artifactKind: 'file',
    absolutePath: `${ROOT}/${rel}`,
    signature: { size, modifiedMs },
  };
}

function makeGuest() {
  const writes: Array<{ projectKey: string; projectRoot: string; conversationId: string; work: StoredWorkResult | undefined }> = [];
  const port: WorkResultStorePort = {
    update: (projectKey, projectRoot, conversationId, work) => {
      writes.push({ projectKey, projectRoot, conversationId, work });
    },
  };
  return { writes, port };
}

function scanOf(artifacts: readonly ScannedArtifact[] | null, truncated = false): () => Promise<WorkScanOutcome | null> {
  return async () =>
    artifacts === null
      ? null
      : { artifacts, truncated };
}

/** A stateful scanner that returns scripted results across calls, so a test
 *  can distinguish the run-start baseline from the terminal final scan. */
function scriptedScan(script: Array<readonly ScannedArtifact[] | null>): () => Promise<{ artifacts: readonly ScannedArtifact[]; truncated: boolean; warning?: string } | null> {
  let i = 0;
  return () => {
    const step = script[Math.min(i, script.length - 1)] ?? null;
    i += 1;
    return Promise.resolve(step ? { artifacts: step, truncated: false } : null);
  };
}

describe('WorkResultProjector (P2-1 §8.2)', () => {
  it('captures baseline at run start and finalises a created artifact with the real outcome', async () => {
    const { writes, port } = makeGuest();
    // Baseline is empty; terminal scan reveals a.md → created this run.
    const projector = new WorkResultProjector({
      port,
      scan: scanOf([]),
    });
    await projector.onRunStarted(scope('r1'));
    projector.onArtifact(scope('r1'), `${ROOT}/a.md`, 'document');
    await projector.onRunTerminal(scope('r1'), 'completed');

    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write.projectKey).toBe(PROJECT);
    expect(write.work?.artifactCountTotal).toBe(1);
    const artifact = write.work?.artifacts[0];
    expect(artifact?.id).toBe('a.md');
    expect(artifact?.lastChange).toBe('created');
    expect(write.work?.latestRun?.status).toBe('completed');
  });

  it('terminal is exactly-once per runId (late duplicates never re-finalise)', async () => {
    const { writes, port } = makeGuest();
    let finalScans = 0;
    const projector = new WorkResultProjector({
      port,
      scan: () => {
        finalScans += 1;
        return Promise.resolve({ artifacts: [scanned('a.md')], truncated: false });
      },
    });
    await projector.onRunStarted(scope('r1')); // baseline scan (not counted)
    const before = finalScans;
    await projector.onRunTerminal(scope('r1'), 'completed');
    const afterFirst = finalScans;
    await projector.onRunTerminal(scope('r1'), 'completed'); // deduped, no new scan
    expect(finalScans - before).toBe(1); // exactly one terminal scan
    expect(afterFirst).toBe(before + 1);
    expect(writes).toHaveLength(1);
  });

  it('final scan supplies the change signature so a follow-up bumps v1 → v2', async () => {
    const { writes, port } = makeGuest();
    // One store across both runs. Script: r1 baseline [], r1 final a.md@10;
    // r2 baseline a.md@10, r2 final a.md@20 (content changed → updated v2).
    const projector = new WorkResultProjector({
      port,
      scan: scriptedScan([[], [scanned('a.md', 10, 1)], [scanned('a.md', 10, 1)], [scanned('a.md', 20, 2)]]),
    });
    await projector.onRunStarted(scope('r1'));
    await projector.onRunTerminal(scope('r1'), 'completed');
    expect(writes[0]?.work?.artifacts[0]?.version).toBe(1);

    await projector.onRunStarted(scope('r2', 'c1', 't2', 2000));
    await projector.onRunTerminal(scope('r2', 'c1', 't2', 2000), 'completed');
    const last = writes[writes.length - 1]!;
    expect(last.work?.artifacts[0]?.version).toBe(2);
    expect(last.work?.latestRun?.updatedIds).toEqual(['a.md']);
  });

  it('recovery (no baseline, terminal direct) maps first-seen files to discovered', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: () => Promise.resolve({ artifacts: [scanned('a.md', 10, 1)], truncated: false }),
    });
    // No onRunStarted — mimics a reconcile-recovered terminal run.
    await projector.onRunTerminal(scope('r9'), 'completed');
    const artifact = writes[0]?.work?.artifacts[0];
    expect(artifact?.lastChange).toBe('discovered');
    expect(artifact?.version).toBe(1);
    expect(writes[0]?.work?.latestRun?.discoveredIds).toEqual(['a.md']);
  });

  it('a failed terminal scan keeps event records and marks the run degraded', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: () => Promise.resolve(null),
    });
    await projector.onRunStarted(scope('r1'));
    projector.onArtifact(scope('r1'), `${ROOT}/a.md`);
    await projector.onRunTerminal(scope('r1'), 'failed');
    const write = writes[0]!;
    expect(write.work?.latestRun?.status).toBe('degraded');
    expect(write.work?.latestRun?.warning).toBe('Artifact scan was incomplete.');
    // Event record still shown.
    expect(write.work?.artifacts[0]?.id).toBe('a.md');
  });

  it('maps a cancelled run outcome through to the stored latestRun', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: () => Promise.resolve({ artifacts: [], truncated: false }),
    });
    await projector.onRunStarted(scope('r1'));
    await projector.onRunTerminal(scope('r1'), 'cancelled');
    expect(writes[0]?.work?.latestRun?.status).toBe('cancelled');
  });

  // ── C-Core lifecycle (audit P2-2) ───────────────────────────────────────

  it('failed → finished: a retried terminal corrects the degraded run', async () => {
    const { writes, port } = makeGuest();
    // Baseline pins a.md@10; the FIRST terminal scan fails, the retry works.
    const projector = new WorkResultProjector({
      port,
      scan: scriptedScan([[scanned('a.md', 10, 1)], null, [scanned('a.md', 20, 2)]]),
    });
    await projector.onRunStarted(scope('r1'));
    await projector.onRunTerminal(scope('r1'), 'failed');
    expect(writes[0]?.work?.latestRun?.status).toBe('degraded');

    // The authoritative correction: re-scan succeeds → real delta, persisted.
    await projector.onRunTerminal(scope('r1'), 'completed');
    expect(writes).toHaveLength(2);
    const corrected = writes[1]!;
    expect(corrected.work?.latestRun?.status).toBe('completed');
    expect(corrected.work?.latestRun?.warning).toBeUndefined();
    expect(corrected.work?.latestRun?.updatedIds).toEqual(['a.md']);
    expect(corrected.work?.artifacts[0]?.version).toBe(2);

    // And the corrected run is now immutable: no third scan / write.
    await projector.onRunTerminal(scope('r1'), 'completed');
    expect(writes).toHaveLength(2);
  });

  it('clearConversation drops the projection; siblings survive', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: scanOf([scanned('a.md')]),
    });
    await projector.onRunStarted(scope('r1', 'c1'));
    await projector.onRunTerminal(scope('r1', 'c1'), 'completed');
    await projector.onRunStarted(scope('r1', 'c2'));
    await projector.onRunTerminal(scope('r1', 'c2'), 'completed');

    projector.clearConversation(PROJECT, 'c1');
    // The store state of the deleted conversation is gone — a retried
    // terminal is treated as a fresh recovery, not as a duplicate.
    expect(
      projector.artifactStore.runTerminalState(PROJECT, 'c1', 'r1'),
    ).toBeUndefined();
    expect(projector.artifactStore.snapshot(PROJECT, 'c1').artifacts).toHaveLength(0);
    // The sibling conversation is untouched.
    expect(
      projector.artifactStore.runTerminalState(PROJECT, 'c2', 'r1'),
    ).toBe('finished');
    expect(projector.artifactStore.snapshot(PROJECT, 'c2').artifacts).toHaveLength(1);
    expect(writes).toHaveLength(2);
  });

  it('terminal bookkeeping stays bounded across many runs', async () => {
    const { port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: scanOf([]),
    });
    for (let i = 0; i < 70; i += 1) {
      const s = scope(`r${i}`, 'c1', `t${i}`, 1000 + i);
      await projector.onRunStarted(s);
      await projector.onRunTerminal(s, 'completed');
    }
    // The store's FIFO cap holds; the oldest marker was evicted.
    expect(projector.artifactStore.trackedTerminalRunCount(PROJECT, 'c1')).toBe(64);
    expect(projector.artifactStore.runTerminalState(PROJECT, 'c1', 'r0')).toBeUndefined();
    expect(projector.artifactStore.runTerminalState(PROJECT, 'c1', 'r69')).toBe('finished');
  });

  it('does not adopt foreign files from the shared .trylo/out (isolation, 2026-09-03)', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      // Baseline empty; the terminal scan surfaces a.md AND b.md. b.md was
      // created by ANOTHER conversation — with ownership evidence present the
      // projector must keep only this conversation's own a.md.
      scan: scriptedScan([[], [scanned('a.md'), scanned('b.md')]]),
    });
    const s = scope('r-iso');
    await projector.onRunStarted(s);
    // This run owns exactly one artifact via its scope-correct event.
    projector.onArtifact(s, `${ROOT}/a.md`, 'document');
    await projector.onRunTerminal(s, 'completed');
    const ids = (writes[0]!.work?.artifacts ?? []).map((a) => a.id);
    expect(ids).toContain('a.md');
    expect(ids).not.toContain('b.md');
  });
});

// ── PR-5 (spec §11): delivery verification wiring ──────────────────────
// The projector persists the scan result first, then folds the bounded
// validation verdicts back in. A failed verdict degrades the run — it never
// rewrites the agent's answer. A missing / failing pipeline is NO VERDICT,
// never a pass (§4.4).

describe('WorkResultProjector — PR-5 delivery verification (§11)', () => {
  /** The verdict fold is fire-and-forget (it must never block the terminal
   *  write); tests await one macrotask so the promise chain settles. */
  async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function verdictFor(relativePath: string, status: 'verified' | 'partial' | 'failed' | 'skipped', id = relativePath) {
    return {
      id,
      relativePath,
      status,
      checks: [{ id: 'file-present' as const, status: 'passed' as const }],
      skippedCapabilities: [],
      checkedAt: 5000,
    };
  }

  function makeVerifyingGuest(files: readonly string[]) {
    const { writes, port } = makeGuest();
    // A real run: EMPTY baseline, then the terminal scan surfaces the files —
    // only then do they belong to this run's delta and get verified (§11).
    const scan = scriptedScan([[], files.map((rel) => scanned(rel))]);
    const verify = async () => ({
      results: [
        ...(files.includes('.trylo/out/report.docx') ? [verdictFor('.trylo/out/report.docx', 'verified')] : []),
        ...(files.includes('.trylo/out/broken.docx') ? [verdictFor('.trylo/out/broken.docx', 'failed')] : []),
      ],
    });
    return { writes, port, scan, verify };
  }

  it('attaches verdicts after the scan write (two-phase, in order)', async () => {
    const { writes, port, scan, verify } = makeVerifyingGuest(['.trylo/out/report.docx', '.trylo/out/broken.docx']);
    const projector = new WorkResultProjector({
      port,
      scan,
      verify: verify as never,
    });
    const s = scope('r-verify');
    await projector.onRunStarted(s);
    await projector.onRunTerminal(s, 'completed');
    await flushAsync();
    // The dock appears with the scan result first, then the verdicts fold in.
    expect(writes.length).toBe(2);
    expect(writes[0]!.work!.artifacts[0]!.verification).toBeUndefined();
    const finalWrite = writes[1]!.work!;
    expect(finalWrite.artifacts.find((a) => a.id === '.trylo/out/report.docx')?.verification?.status).toBe('verified');
    expect(finalWrite.artifacts.find((a) => a.id === '.trylo/out/broken.docx')?.verification?.status).toBe('failed');
  });

  it('a failed verdict degrades a completed run to degraded (agent answer untouched)', async () => {
    const { writes, port, scan, verify } = makeVerifyingGuest(['.trylo/out/broken.docx']);
    const projector = new WorkResultProjector({
      port,
      scan,
      verify: verify as never,
    });
    const s = scope('r-degrade');
    await projector.onRunStarted(s);
    await projector.onRunTerminal(s, 'completed');
    await flushAsync();
    const finalWrite = writes[1]!.work!;
    expect(finalWrite.latestRun?.status).toBe('degraded');
    expect(finalWrite.latestRun?.warning).toContain('验证未通过');
  });

  it('does not degrade an already-failed run further', async () => {
    const { writes, port, scan, verify } = makeVerifyingGuest(['.trylo/out/broken.docx']);
    const projector = new WorkResultProjector({
      port,
      scan,
      verify: verify as never,
    });
    const s = scope('r-fail');
    await projector.onRunStarted(s);
    await projector.onRunTerminal(s, 'failed');
    await flushAsync();
    // Terminal itself failed → the run is already not completed; the verdict
    // must not overwrite that outcome with a different one.
    expect(writes[0]!.work!.latestRun?.status).toBe('failed');
    expect(writes[1]!.work!.latestRun?.status).toBe('failed');
    expect(writes[1]!.work!.artifacts[0]?.verification?.status).toBe('failed');
  });

  it('a null pipeline answer (transport failure) is no verdict — no second write', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: scriptedScan([[], [scanned('.trylo/out/report.docx')]]),
      verify: async () => null,
    });
    const s = scope('r-null');
    await projector.onRunStarted(s);
    await projector.onRunTerminal(s, 'completed');
    await flushAsync();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.work!.artifacts[0]!.verification).toBeUndefined();
  });

  it('a throwing pipeline never surfaces (no verdict, no crash)', async () => {
    const { writes, port } = makeGuest();
    const projector = new WorkResultProjector({
      port,
      scan: scriptedScan([[], [scanned('.trylo/out/report.docx')]]),
      verify: async () => { throw new Error('boom'); },
    });
    const s = scope('r-throw');
    await projector.onRunStarted(s);
    await expect(projector.onRunTerminal(s, 'completed')).resolves.toBeUndefined();
    await flushAsync();
    expect(writes).toHaveLength(1);
  });

  it('clearConversation invalidates a late verdict (generation guard)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { writes, port } = makeGuest();
    const verify = async () => {
      await gate;
      return { results: [verdictFor('.trylo/out/report.docx', 'failed')] };
    };
    const projector = new WorkResultProjector({
      port,
      scan: scriptedScan([[], [scanned('.trylo/out/report.docx')]]),
      verify: verify as never,
    });
    const s = scope('r-late');
    await projector.onRunStarted(s);
    const terminal = projector.onRunTerminal(s, 'completed');
    // Let the terminal write land first (scan → finishRun → update → the
    // verification starts and parks on the gate), THEN delete the
    // conversation while verification is in flight.
    await flushAsync();
    projector.clearConversation(PROJECT, 'c1');
    release();
    await terminal;
    await flushAsync();
    expect(writes).toHaveLength(1);
  });

  it('does not verify a run without a file delta', async () => {
    const { writes, port } = makeGuest();
    let calls = 0;
    const projector = new WorkResultProjector({
      port,
      scan: scanOf([]),
      verify: (async () => { calls += 1; return { results: [] }; }) as never,
    });
    const s = scope('r-empty');
    await projector.onRunStarted(s);
    await projector.onRunTerminal(s, 'completed');
    expect(calls).toBe(0);
    expect(writes).toHaveLength(1);
  });
});