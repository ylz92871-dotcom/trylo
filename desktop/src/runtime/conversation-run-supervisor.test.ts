// Trylo Desktop — ConversationRunSupervisor / CodeRunController tests.
//
// v1.16.6 (M4-A runtime ownership). Covers the spec §11.1 Code
// lifecycle requirements that moved OUT of App.tsx and into the
// supervisor:
//   - runs are keyed by (projectKey, conversationId) — two Code
//     conversations never share a process or a run state;
//   - Stop A does not affect B (scoped stop);
//   - a child that exits on its own (process.exited) clears only
//     its own conversation's binding;
//   - the warm path reuses the same conversation's idle CLI;
//   - background write-back stays on the original conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessExitInfo } from '../host-adapter/process-service';

interface Spawned {
  id: string;
  onOutput: (line: string) => void;
  onExit: (info: ProcessExitInfo) => void;
  metadata: Record<string, string | undefined>;
  label: string;
  promptLines: string[];
}

const spawned: Spawned[] = [];
const stopCalls: string[] = [];
// When true, `process.spawn` waits on a released promise so tests
// can deterministically interleave a stop during an in-flight spawn
// (guard branch, §11.1 gap #2).
let holdSpawn = false;
let releaseSpawn: () => void = () => {};
let failSpawn = false;

vi.mock('@tauri-apps/api/core', () => {
  return {
    Channel: class {
      onmessage: ((msg: unknown) => void) | null = null;
    },
    invoke: vi.fn(async () => undefined),
  };
});

vi.mock('../host-adapter/index', async () => {
  return {
    hostAdapter: {
      process: {
        spawn: async (req: {
          command: string;
          args: readonly string[];
          label: string;
          cwd?: string;
          env?: Record<string, string>;
          metadata?: Record<string, string | undefined>;
          onOutput: (line: string) => void;
          onExit?: (info: ProcessExitInfo) => void;
        }) => {
          if (failSpawn) throw new Error('spawn unavailable');
          if (holdSpawn) {
            await new Promise<void>((resolve) => {
              releaseSpawn = resolve;
            });
          }
          const id = `proc-${spawned.length + 1}`;
          spawned.push({
            id,
            onOutput: req.onOutput,
            onExit: (info) => req.onExit?.(info),
            metadata: req.metadata ?? {},
            label: req.label,
            promptLines: [],
          });
          return { id, pid: spawned.length, label: req.label, command: req.command };
        },
        send: async (processId: string, line: string) => {
          const s = spawned.find((x) => x.id === processId);
          if (s) s.promptLines.push(line);
        },
        stop: async (processId: string) => {
          stopCalls.push(processId);
        },
        list: async () => [],
      },
      fs: { readFile: async () => '', statFile: async () => ({ size: 0 }) },
    },
  };
});

// Import AFTER the mock.
import { ConversationRunSupervisor } from './conversation-run-supervisor';
import type { SettingsForCodeRun } from './runtime-types';

const baseSettings: SettingsForCodeRun = {
  cliPath: 'D:/cli/cli.js',
  cwd: 'D:/work',
};

function request(prompt: string) {
  return {
    prompt,
    settings: baseSettings,
    codeMode: 'agent' as const,
    // P2: the level is required. Tests use the recommended
    // default; specific runs in this file don't assert on
    // the CLI argv (a different test owns the policy mapping).
    permissionLevel: 'workspace_write' as const,
    priorMessages: [],
    onEvents: () => {},
  };
}

function loopEnd(): void {
  spawned[0]!.onOutput(JSON.stringify({ type: 'loop_end' }));
}

beforeEach(() => {
  spawned.length = 0;
  stopCalls.length = 0;
  holdSpawn = false;
  failSpawn = false;
  releaseSpawn = () => {};
});

afterEach(() => {
  spawned.length = 0;
  stopCalls.length = 0;
  holdSpawn = false;
  failSpawn = false;
  releaseSpawn = () => {};
});

describe('ConversationRunSupervisor (M4-A Code lifecycle)', () => {
  it('spawns on the first turn, then warm-reuses the idle CLI', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('p1'));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.metadata.runId).toContain('convA');
    // in-flight: running, not sendable
    expect(sup.getViewState('proj', 'convA').running).toBe(true);
    expect(sup.getViewState('proj', 'convA').sendable).toBe(false);

    // loop_end → idle, but the CLI is retained for warm reuse.
    loopEnd();
    expect(sup.getViewState('proj', 'convA').running).toBe(false);
    expect(sup.getViewState('proj', 'convA').sendable).toBe(true);
    expect(sup.getViewState('proj', 'convA').activeProcessId).toBe('proc-1');

    // Second turn reuses the same process — no new spawn.
    const sendsBefore = spawned[0]!.promptLines.length;
    await sup.runCode('proj', 'convA', request('p2'));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.promptLines.length).toBe(sendsBefore + 1);
  });

  it('steers a live turn without creating a second run or process', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('start'));
    const before = sup.getViewState('proj', 'convA');
    const linesBefore = spawned[0]!.promptLines.length;

    await expect(sup.steerCode('proj', 'convA', '改用更简单的方案')).resolves.toBe(true);

    const after = sup.getViewState('proj', 'convA');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.promptLines).toHaveLength(linesBefore + 1);
    expect(spawned[0]!.promptLines.at(-1)).toContain('改用更简单的方案');
    expect(after.runId).toBe(before.runId);
    expect(after.running).toBe(true);
  });

  it('stopTask writes a stop_task control_request to the live process', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('start'));
    await expect(sup.stopTask('proj', 'convA', 'tool-seat-w')).resolves.toBe(true);
    const last = spawned[0]!.promptLines.at(-1);
    expect(last).toBeTruthy();
    const parsed = JSON.parse(last!.trim()) as {
      type: string;
      request: { subtype: string; task_id: string };
    };
    expect(parsed.type).toBe('control_request');
    expect(parsed.request).toEqual({ subtype: 'stop_task', task_id: 'tool-seat-w' });
    expect(spawned).toHaveLength(1);
  });

  it('keeps two conversations fully independent', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    await sup.runCode('proj', 'convB', request('b'));
    expect(spawned).toHaveLength(2);
    const pidA = sup.getViewState('proj', 'convA').activeProcessId;
    const pidB = sup.getViewState('proj', 'convB').activeProcessId;
    expect(pidA).not.toBe(pidB);
  });

  it('Stop A does not affect B (scoped stop)', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    await sup.runCode('proj', 'convB', request('b'));
    await sup.stopConversation('proj', 'convA');
    expect(stopCalls).toContain('proc-1');
    expect(stopCalls).not.toContain('proc-2');
    expect(sup.getViewState('proj', 'convA').running).toBe(false);
    expect(sup.getViewState('proj', 'convB').running).toBe(true);
  });

  it('a child exit clears only its own conversation binding', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    await sup.runCode('proj', 'convB', request('b'));
    // A's child dies mid-run → A is marked failed/stopped; B is untouched.
    spawned[0]!.onExit({ id: 'proc-1', pid: 1, code: 1, signal: null });
    const viewA = sup.getViewState('proj', 'convA');
    expect(viewA.running).toBe(false);
    expect(viewA.activeProcessId).toBeNull();
    expect(viewA.error).toBe(true); // died while busy = crash
    expect(sup.getViewState('proj', 'convB').running).toBe(true);
  });

  it('an idle child exiting is not an error', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    loopEnd(); // idle
    spawned[0]!.onExit({ id: 'proc-1', pid: 1, code: 0, signal: null });
    expect(sup.getViewState('proj', 'convA').running).toBe(false);
    expect(sup.getViewState('proj', 'convA').error).toBe(false);
  });

  it('activeCodeRuns reflects in-flight runs only', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    await sup.runCode('proj', 'convB', request('b'));
    expect(sup.activeCodeRuns()).toHaveLength(2);
    loopEnd();
    const active = sup.activeCodeRuns();
    expect(active).toHaveLength(1);
    expect(active[0]!.conversationId).toBe('convB');
  });

  // ── Audit corrections (M4-A follow-up) ───────────────────────

  it('removeConversation ends a run even when it is not (and cannot be) the visible one (P0-1)', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    await sup.runCode('proj', 'convB', request('b'));
    // Deleting convA while its (possibly background) run is in
    // flight must stop THAT run and drop its controller — it must
    // not become an orphan that keeps projecting to a deleted
    // conversation, and Stop B is untouched.
    sup.removeConversation('proj', 'convA');
    await Promise.resolve(); // let the fire-and-forget stop settle
    expect(stopCalls).toContain('proc-1');
    expect(stopCalls).not.toContain('proc-2');
    // Controller is gone → getViewState falls back to idle default.
    expect(sup.getViewState('proj', 'convA').running).toBe(false);
    expect(sup.getViewState('proj', 'convB').running).toBe(true);
    expect(sup.activeCodeRuns().map((r) => r.conversationId)).toEqual(['convB']);
  });

  it('stopWorkspace stops+disposes every run of a project, leaves others (P1-2)', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.runCode('proj', 'convA', request('a'));
    await sup.runCode('proj', 'convB', request('b'));
    await sup.runCode('proj2', 'convC', request('c'));
    await sup.stopWorkspace('proj');
    expect([...stopCalls].sort()).toEqual(['proc-1', 'proc-2']);
    expect(stopCalls).not.toContain('proc-3');
    expect(sup.getViewState('proj', 'convA').running).toBe(false);
    expect(sup.getViewState('proj', 'convB').running).toBe(false);
    expect(sup.getViewState('proj2', 'convC').running).toBe(true);
    expect(sup.activeCodeRuns().map((r) => r.conversationId)).toEqual(['convC']);
  });

  it('a stop during an in-flight spawn cancels it and never projects a run state (§11.1 gap #2)', async () => {
    const sup = new ConversationRunSupervisor();
    holdSpawn = true;
    const runPromise = sup.runCode('proj', 'convA', request('a'));
    await Promise.resolve(); // the spawn is now suspended
    await sup.stopConversation('proj', 'convA'); // supersede the spawn
    holdSpawn = false;
    releaseSpawn();
    await runPromise;
    // The orphan it created was stopped, and no late spawn set a
    // wrong "running" state on the (now deleting) conversation.
    expect(stopCalls).toContain('proc-1');
    expect(sup.getViewState('proj', 'convA').running).toBe(false);
  });

  it('surfaces spawning immediately while an additive baseline is pending', async () => {
    const sup = new ConversationRunSupervisor();
    let releaseBaseline: () => void = () => {};
    const runPromise = sup.runCode('proj', 'convA', {
      ...request('with baseline'),
      lifecycleObserver: {
        onRunStarted: () => new Promise<void>((resolve) => { releaseBaseline = resolve; }),
        onEvents: () => {},
        onRunTerminal: () => {},
      },
    });
    await Promise.resolve();
    const pending = sup.getViewState('proj', 'convA');
    expect(pending.bindingState).toBe('spawning');
    expect(pending.running).toBe(true);
    expect(pending.sendable).toBe(false);
    releaseBaseline();
    await runPromise;
  });

  it('finalizes result lifecycle and marks the view failed when cold spawn fails', async () => {
    const sup = new ConversationRunSupervisor();
    failSpawn = true;
    const terminal = vi.fn();
    await expect(sup.runCode('proj', 'convA', {
      ...request('cannot start'),
      lifecycleObserver: {
        onRunStarted: () => {},
        onEvents: () => {},
        onRunTerminal: terminal,
      },
    })).rejects.toThrow('spawn unavailable');
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0]?.[1]).toBe('failed');
    const view = sup.getViewState('proj', 'convA');
    expect(view.running).toBe(false);
    expect(view.error).toBe(true);
  });
});

// ── M4-C1 prewarm (spec §7.1) ─────────────────────────────────
describe('ConversationRunSupervisor (M4-C1 prewarm)', () => {
  function warmPrewarm(index: number): void {
    spawned[index]!.onOutput(JSON.stringify({ type: 'session_start', sessionId: 's' }));
  }

  it('prewarms a Code CLI without sending a prompt; session_start marks it ready', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.prewarmCode('proj', 'convA', baseSettings);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.label).toBe('trylo-cli-prewarm');
    expect(spawned[0]!.promptLines).toHaveLength(0); // no prompt
    expect(stopCalls).toHaveLength(0); // not reclaimed
    // Not ready until the structured gate fires.
    expect(sup.idleTtlMs).toBeGreaterThan(0);
    warmPrewarm(0);
    // Ready is now recorded in the pure policy.
    expect(sup.getViewState('proj', 'convA').activeProcessId).toBeNull(); // not adopted yet
  });

  it('a turn adopts a ready prewarm instead of cold-spawning', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.prewarmCode('proj', 'convA', baseSettings);
    warmPrewarm(0);
    const sendsBefore = spawned[0]!.promptLines.length;
    await sup.runCode('proj', 'convA', request('use prewarm'));
    expect(spawned).toHaveLength(1); // NO second spawn — adopted
    expect(spawned[0]!.promptLines.length).toBe(sendsBefore + 1);
    expect(sup.getViewState('proj', 'convA').activeProcessId).toBe('proc-1');
  });

  it('adopts a spawned prewarm before session_start instead of deadlocking', async () => {
    const sup = new ConversationRunSupervisor();
    await sup.prewarmCode('proj', 'convA', baseSettings); // warming, not yet ready
    // Some CLI builds emit session_start only after the first stream-json
    // user message. The prompt must therefore be written as soon as the
    // spawned process exposes stdin; waiting for session_start deadlocks.
    await sup.runCode('proj', 'convA', request('early send'));
    expect(spawned).toHaveLength(1); // adopted, not cold-spawned
    expect(spawned[0]!.promptLines[0]).toContain('early send');
    expect(sup.getViewState('proj', 'convA').running).toBe(true);
  });

  it('TTL reclaims an idle runtime but never a busy one', async () => {
    const sup = new ConversationRunSupervisor({ idleTtlMsMs: 1 });
    // Busy turn in conversation B — must never be reclaimed.
    await sup.runCode('proj', 'convB', request('busy'));
    // Prewarm + adopt + finish in conversation A → idle.
    await sup.prewarmCode('proj', 'convA', baseSettings);
    warmPrewarm(1); // spawned[1] (proc-2) is convA's prewarm
    await sup.runCode('proj', 'convA', request('a')); // A adopts proc-2
    spawned[1]!.onOutput(JSON.stringify({ type: 'loop_end' })); // A idle
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reclaimed = await sup.reapIdleRuntimes();
    expect(reclaimed).toBe(1);
    expect(stopCalls).toContain('proc-2'); // the idle A runtime ended
    expect(stopCalls).not.toContain('proc-1'); // busy B untouched
    expect(sup.getViewState('proj', 'convB').running).toBe(true);
  });

  it('reaper start/stop mounts and unmounts the interval', () => {
    const sup = new ConversationRunSupervisor();
    const stop = sup.startPrewarmReaper(60_000);
    expect(typeof stop).toBe('function');
    stop();
    expect(sup.activeCodeRuns()).toEqual([]);
  });
});
