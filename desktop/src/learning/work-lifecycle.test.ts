// work-lifecycle.ts：Work 表面单一观察者链（TRYLO-DUAL-SURFACE-SPEC §2.1）。

import { describe, it, expect, vi } from 'vitest';

import type { CodeRunLifecycleObserver } from '../runtime/code-run-lifecycle';
import type { RuntimeResultScope } from '../results/result-scope';
import type { WorkResultProjector } from '../results/work-result-projector';
import { createWorkLifecycleObserver, extractOutArtifactPaths, toWorkArtifactScope } from './work-lifecycle';

const SCOPE: RuntimeResultScope = {
  projectKey: 'ws-1',
  projectRoot: 'd:/repo',
  conversationId: 'sess-1',
  mode: 'code', // the controller always writes 'code' for Work too
  runId: 'run-1',
  turnId: 'turn-1',
  startedAt: 1,
};

function observer(opts: {
  projector?: Partial<WorkResultProjector>;
  mirror?: CodeRunLifecycleObserver;
  trigger?: CodeRunLifecycleObserver;
  userLearning?: CodeRunLifecycleObserver;
}) {
  const projector = {
    onRunStarted: vi.fn(async () => undefined),
    onRunTerminal: vi.fn(async () => undefined),
    ...opts.projector,
  } as unknown as WorkResultProjector;
  const call = vi.fn();
  const mirror: CodeRunLifecycleObserver = opts.mirror ?? {
    onRunTerminal: vi.fn(() => undefined),
  } as unknown as CodeRunLifecycleObserver;
  const trigger: CodeRunLifecycleObserver = opts.trigger ?? {
    onRunTerminal: vi.fn(() => undefined),
  } as unknown as CodeRunLifecycleObserver;
  const userLearning: CodeRunLifecycleObserver = opts.userLearning ?? {
    onRunStarted: vi.fn(),
    onRunTerminal: vi.fn(() => undefined),
  } as unknown as CodeRunLifecycleObserver;
  return { projector, mirror, trigger, userLearning, call };
}

describe('toWorkArtifactScope', () => {
  it('drops scope.mode (controller writes code for Work too)', () => {
    const mapped = toWorkArtifactScope(SCOPE);
    expect(mapped).toEqual({
      projectKey: 'ws-1',
      projectRoot: 'd:/repo',
      conversationId: 'sess-1',
      runId: 'run-1',
      turnId: 'turn-1',
      startedAt: 1,
    });
    // No `mode` field may survive (WorkArtifactScope has none).
    expect('mode' in mapped).toBe(false);
  });

  it('normalises an empty turnId to undefined', () => {
    expect(toWorkArtifactScope({ ...SCOPE, turnId: '' }).turnId).toBeUndefined();
  });
});

describe('createWorkLifecycleObserver', () => {
  it('drives projector start, stashes baseline, then user-learning start', async () => {
    const { projector, userLearning } = observer({
      userLearning: { onRunStarted: vi.fn(), onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
    });
    const seen = vi.fn();
    const wired = createWorkLifecycleObserver({
      workProjector: projector,
      mirror: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      trigger: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      userLearning,
      listBaseline: async () => ['baseline.pdf'],
      stashBaseline: (scope, paths) => seen([scope.runId, paths]),
    });
    await wired.onRunStarted?.(SCOPE);

    expect(projector.onRunStarted).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(['run-1', ['baseline.pdf']]);
    expect(userLearning.onRunStarted).toHaveBeenCalledTimes(1);
  });

  it('runs projector terminal → stash fileHints → mirror → trigger → userLearning', async () => {
    const order: string[] = [];
    const projector = {
      onRunTerminal: vi.fn(async () => { order.push('projector'); }),
    } as unknown as WorkResultProjector;
    const mirror = { onRunTerminal: vi.fn(() => { order.push('mirror'); }) } as unknown as CodeRunLifecycleObserver;
    const trigger = { onRunTerminal: vi.fn(() => { order.push('trigger'); }) } as unknown as CodeRunLifecycleObserver;
    const userLearning = { onRunTerminal: vi.fn(() => { order.push('userLearning'); }) } as unknown as CodeRunLifecycleObserver;
    const seen: string[] = [];
    const wired = createWorkLifecycleObserver({
      workProjector: projector,
      mirror,
      trigger,
      userLearning,
      collectFileHints: () => ['out.pdf'],
      stashFileHints: (scope, paths) => { seen.push(`${scope.runId}:${paths.join(',')}`); },
    });
    await wired.onRunTerminal?.(SCOPE, 'completed');

    expect(order).toEqual(['projector', 'mirror', 'trigger', 'userLearning']);
    // fileHints stashed AFTER the terminal scan, BEFORE the trigger reads.
    expect(seen).toEqual(['run-1:out.pdf']);
  });

  it('maps an exited terminal to failed for the Work projector (R9)', async () => {
    const { projector } = observer({});
    const wired = createWorkLifecycleObserver({
      workProjector: projector,
      mirror: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      trigger: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      userLearning: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
    });
    await wired.onRunTerminal?.(SCOPE, 'exited');
    expect(projector.onRunTerminal).toHaveBeenCalledWith(expect.anything(), 'failed');
  });

  it('forwards events to user learning and still projects a cancelled terminal', async () => {
    let projected = false;
    const userLearning = {
      onEvents: vi.fn(),
      onRunTerminal: vi.fn(() => undefined),
    } as unknown as CodeRunLifecycleObserver;
    const wired = createWorkLifecycleObserver({
      workProjector: { onRunTerminal: vi.fn(async () => { projected = true; }) } as unknown as WorkResultProjector,
      mirror: { onRunTerminal: vi.fn(() => undefined) } as unknown as CodeRunLifecycleObserver,
      trigger: { onRunTerminal: vi.fn(() => undefined) } as unknown as CodeRunLifecycleObserver,
      userLearning,
    });
    const marker = { prop: 'event' } as never;
    wired.onEvents?.(SCOPE, [marker]);
    expect(userLearning.onEvents).toHaveBeenCalledTimes(1);
    // A cancelled run is still handed to the projector (its store decides the
    // exact semantics) but never to a review.
    await wired.onRunTerminal?.(SCOPE, 'cancelled');
    expect(projected).toBe(true);
  });

  it('passes the terminal listing into collectFileHints and stashes the result', async () => {
    const seen: { scope: string; hints: string[] }[] = [];
    const wired = createWorkLifecycleObserver({
      workProjector: { onRunTerminal: vi.fn(async () => undefined) } as unknown as WorkResultProjector,
      mirror: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      trigger: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      userLearning: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      listAllowlistedOut: async () => ['.trylo/out/a.pptx', '.trylo/out/b.pdf'],
      collectFileHints: (_s, terminalRelPaths) => terminalRelPaths.slice(0, 1),
      stashFileHints: (scope, paths) => { seen.push({ scope: scope.conversationId, hints: [...paths] }); },
    });
    await wired.onRunTerminal?.(SCOPE, 'completed');
    expect(seen).toEqual([{ scope: 'sess-1', hints: ['.trylo/out/a.pptx'] }]);
  });

  it('extracts .trylo/out deliverable paths from tool summaries', () => {
    const events = [
      { type: 'tool_execute', tool: 'officecli', summary: 'saved .trylo/out/周报.pptx and .trylo/out/notes.md' },
      { type: 'tool_execute', tool: 'Bash', summary: 'no deliverable here' },
    ] as never[];
    expect(extractOutArtifactPaths(events)).toEqual(['.trylo/out/周报.pptx', '.trylo/out/notes.md']);
  });

  it('extracts Windows backslash summaries (P2-4: normalise before matching)', () => {
    const events = [
      // Absolute drive + backslashes — the classic Windows tool summary.
      { type: 'tool_execute', summary: 'written to D:\\repo\\.trylo\\out\\deck.pptx' },
      // Relative backslash form.
      { type: 'tool_execute', summary: 'saved \\.trylo\\out\\notes.md ok' },
    ] as never[];
    expect(extractOutArtifactPaths(events)).toEqual([
      '.trylo/out/deck.pptx',
      '.trylo/out/notes.md',
    ]);
  });

  it('does not notify the projector onArtifact when not wired', async () => {
    const wired = createWorkLifecycleObserver({
      workProjector: { onRunTerminal: vi.fn(async () => undefined) } as unknown as WorkResultProjector,
      mirror: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      trigger: { onRunTerminal: vi.fn() } as unknown as CodeRunLifecycleObserver,
      userLearning: { onEvents: vi.fn() } as unknown as CodeRunLifecycleObserver,
    });
    expect(() => wired.onEvents?.(SCOPE, [{ summary: '.trylo/out/a.pptx' }] as never[])).not.toThrow();
  });
});