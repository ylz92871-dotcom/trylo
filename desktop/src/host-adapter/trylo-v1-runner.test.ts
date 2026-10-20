// Trylo Desktop — TryloV1Runner integration tests (P08 WP1).
//
// These drive the runner through a scripted ProcessService, so the four
// lifecycle cases WP1's exit criterion names are exercised for real:
// a fixture text run, stdin EOF, an exit with no terminal event, and a
// cancellation. The bytes fed to stdout are the frozen golden traces.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent, RuntimeWarningEvent } from './loop-events';
import type { LoopEndEvent, TextEvent } from './loop-events';
import {
  TRACE_PRERUN_FAILURE,
  TRACE_SUCCESS,
  traceExitCode,
  traceLines,
  traceStderr,
} from './trylo-v1-fixtures';
import {
  beginSessionCreate,
  markSessionEstablished,
  markSessionUnknown,
  type CliSessionBinding,
} from './cli-session-binding';

const h = vi.hoisted(() => {
  type Sink = {
    out: (line: string) => void;
    err: (line: string) => void;
    exit: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
  };
  let seq = 0;
  const sinks = new Map<string, Sink>();
  const record = {
    spawns: [] as { id: string; command: string; args: string[]; hasStderr: boolean }[],
    sent: [] as { id: string; message: string }[],
    closed: [] as string[],
    stopped: [] as string[],
  };
  let closeInputFails = false;
  const service = {
    async spawn(opts: {
      command: string;
      args: readonly string[];
      label: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      onOutput: (line: string) => void;
      onStderr?: (line: string) => void;
      onExit?: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
    }): Promise<{ id: string; pid: number; label: string; command: string }> {
      const id = `proc-${++seq}`;
      sinks.set(id, {
        out: opts.onOutput,
        err: opts.onStderr ?? (() => undefined),
        exit: opts.onExit ?? (() => undefined),
      });
      record.spawns.push({
        id,
        command: opts.command,
        args: [...opts.args],
        hasStderr: typeof opts.onStderr === 'function',
      });
      return { id, pid: 1000 + seq, label: opts.label, command: opts.command };
    },
    async send(id: string, message: string): Promise<void> {
      record.sent.push({ id, message });
    },
    async closeInput(id: string): Promise<void> {
      if (closeInputFails) throw new Error('broken pipe');
      record.closed.push(id);
    },
    async stop(id: string): Promise<void> {
      record.stopped.push(id);
    },
    async list(): Promise<readonly never[]> {
      return [];
    },
  };
  return {
    sinks,
    record,
    service,
    setCloseInputFails: (v: boolean) => {
      closeInputFails = v;
    },
  };
});

vi.mock('./index', () => ({ hostAdapter: { process: h.service } }));

const {
  buildTryloV1Args,
  permissionFlagsForV1,
  startTryloV1,
  stopTryloV1,
  TryloV1UnsupportedError,
} = await import('./trylo-v1-runner');

const CLI_PATH = 'C:/work/demo-ws/new trylo cli/dist/cmd/trylo/main.js' as never;
const CWD = 'C:/work/demo-ws/workspace' as never;

function emitStdout(id: string, lines: readonly string[]): void {
  const sink = h.sinks.get(id);
  if (!sink) throw new Error(`no sink for ${id}`);
  for (const line of lines) sink.out(line);
}

function emitExit(id: string, code: number | null): void {
  const sink = h.sinks.get(id);
  if (!sink) throw new Error(`no sink for ${id}`);
  sink.exit({ id, pid: 1001, code, signal: null });
}

function emitStderr(id: string, lines: readonly string[]): void {
  const sink = h.sinks.get(id);
  if (!sink) throw new Error(`no sink for ${id}`);
  for (const line of lines) sink.err(line);
}

function collect(): { events: LoopEvent[]; outcomes: string[] } {
  const events: LoopEvent[] = [];
  const outcomes: string[] = [];
  return { events, outcomes };
}

beforeEach(() => {
  h.record.spawns.length = 0;
  h.record.sent.length = 0;
  h.record.closed.length = 0;
  h.record.stopped.length = 0;
  h.sinks.clear();
  h.setCloseInputFails(false);
});

afterEach(() => {
  h.setCloseInputFails(false);
});

describe('buildTryloV1Args', () => {
  it('never puts the prompt in argv', () => {
    const { args } = buildTryloV1Args({ cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture' });
    // Windows command-line limits, argv in process logs, and attachment
    // size are all reasons the prompt travels on stdin (spec §3.1).
    expect(args.join(' ')).not.toContain('secret prompt');
    expect(args[args.length - 1]).toBe('-');
  });

  it('uses the new contract: run + --format stream-json + --workspace + -', () => {
    const { command, args } = buildTryloV1Args({
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
    });
    expect(command).toBe('node');
    expect(args.slice(1, 6)).toEqual(['run', '--format', 'stream-json', '--workspace', CWD]);
    expect(args).toContain('--provider');
  });

  it('forwards the effective learning switch, and nothing when none is set', () => {
    // WP-CL / B: an unset setting must leave argv byte-for-byte unchanged;
    // a hard-coded `--learning=all` would enable subsystems nobody asked for.
    const off = buildTryloV1Args({ cliPath: CLI_PATH, cwd: CWD });
    expect(off.args.some(arg => arg.startsWith('--learning'))).toBe(false);

    const on = buildTryloV1Args({ cliPath: CLI_PATH, cwd: CWD, learning: 'user' });
    expect(on.args).toContain('--learning=user');
  });

  it('maps each permission level to explicit tool flags', () => {
    expect(permissionFlagsForV1('read_only')).toEqual([
      '--ask', 'always', '--deny-tools', 'write_file,edit_file,apply_patch,notebook_edit,run_shell',
      '--permission-prompt-tool', 'stdio',
    ]);
    expect(permissionFlagsForV1('workspace_write')).toEqual([
      '--ask', 'always',
      '--permission-prompt-tool', 'stdio', '--shell-isolation', 'host', '--filesystem-access', 'reviewed', '--shell', 'auto',
    ]);
    expect(permissionFlagsForV1('unrestricted')).toEqual([
      '--ask', 'always',
      '--permission-prompt-tool', 'stdio', '--shell-isolation', 'host', '--filesystem-access', 'host', '--shell', 'auto',
    ]);
  });

  it('maps ask to the explicit bidirectional stdio transport', () => {
    expect(permissionFlagsForV1('ask')).toEqual(['--ask', 'always', '--permission-prompt-tool', 'stdio', '--shell-isolation', 'host', '--filesystem-access', 'reviewed', '--shell', 'auto']);
  });

  it('lets the host distinguish patch operations rather than allow-listing a whole tool', () => {
    const flags = permissionFlagsForV1('workspace_write');
    const allowed = flags[flags.indexOf('--allow-tools') + 1]?.split(',');
    expect(allowed).not.toContain('apply_patch');
    expect(flags).toContain('--permission-prompt-tool');
    expect(flags[flags.indexOf('--ask') + 1]).toBe('always');
  });

  it('appends Desktop instructions and product identity without replacing CLI seeds', () => {
    const { args } = buildTryloV1Args({ cliPath: CLI_PATH, cwd: CWD, systemPrompt: 'Keep progress updates concise.' });
    const index = args.indexOf('--append-system-prompt');
    expect(index).toBeGreaterThan(0);
    expect(args[index + 1]).toContain('Keep progress updates concise.');
    expect(args[index + 1]).toContain('You are Trylo Code');
    expect(args).not.toContain('--system-prompt');
  });
});

describe('TryloV1Runner lifecycle', () => {
  it('handles exit before spawn resolves without retaining a dead process or writing a prompt', async () => {
    const spy = vi.spyOn(h.service, 'spawn').mockImplementationOnce(async opts => {
      opts.onExit?.({ id: 'early', pid: 1, code: 52, signal: null });
      return { id: 'early', pid: 1, command: opts.command, label: opts.label };
    });
    const outcomes: string[] = [];
    try {
      const result = await startTryloV1({ cliPath: CLI_PATH, cwd: CWD, prompt: 'hello', onEvents: () => undefined,
        onTerminal: outcome => outcomes.push(outcome) });
      expect(result.state()).toBe('exited');
      expect(outcomes).toEqual(['failed']);
      expect(h.record.sent).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it('keeps approval stdin open and routes requests with the owning process id', async () => {
    const controls: unknown[] = [];
    const { processId } = await startTryloV1({ prompt: 'hello\nworld', cliPath: CLI_PATH, cwd: CWD,
      permissionLevel: 'ask', onEvents: () => undefined,
      onControlFrame: (frame, owner) => controls.push({ frame, owner }),
    });
    expect(h.record.closed).toEqual([]);
    expect(JSON.parse(h.record.sent[0]!.message)).toMatchObject({ type: 'user', message: { content: [{ text: 'hello\nworld' }] } });
    emitStdout(processId, [JSON.stringify({ type: 'control_request', request_id: 'approval-1',
      request: { subtype: 'can_use_tool', tool_name: 'write_file', input: { path: 'a.txt' } },
    })]);
    expect(controls).toEqual([{ owner: processId, frame: { kind: 'permission', requestId: 'approval-1', toolName: 'write_file', input: { path: 'a.txt' } } }]);
    emitExit(processId, 130);
  });

  it('fails before spawn when an ask run has no approval handler', async () => {
    await expect(startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      permissionLevel: 'ask', onEvents: () => undefined,
    })).rejects.toThrow(TryloV1UnsupportedError);
    expect(h.record.spawns).toHaveLength(0);
  });

  it('keeps automatic editing stdin open so shell commands can still request approval', async () => {
    const controls: unknown[] = [];
    const { processId } = await startTryloV1({ prompt: 'edit then verify', cliPath: CLI_PATH, cwd: CWD,
      permissionLevel: 'workspace_write', onEvents: () => undefined,
      onControlFrame: (frame, owner) => controls.push({ frame, owner }),
    });
    expect(h.record.closed).toEqual([]);
    expect(JSON.parse(h.record.sent[0]!.message)).toMatchObject({ type: 'user' });
    emitStdout(processId, [JSON.stringify({ type: 'control_request', request_id: 'shell-approval',
      request: { subtype: 'can_use_tool', tool_name: 'run_shell', input: { command: 'npm test' } },
    })]);
    expect(controls).toEqual([{ owner: processId, frame: { kind: 'permission', requestId: 'shell-approval',
      toolName: 'run_shell', input: { command: 'npm test' } } }]);
    emitExit(processId, 130);
  });

  it('refuses automatic editing before spawn when its approval transport has no handler', async () => {
    await expect(startTryloV1({ prompt: 'edit then verify', cliPath: CLI_PATH, cwd: CWD,
      permissionLevel: 'workspace_write', onEvents: () => undefined,
    })).rejects.toThrow(TryloV1UnsupportedError);
    expect(h.record.spawns).toHaveLength(0);
  });
  it('runs a fixture turn end to end', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      permissionLevel: 'read_only',
        onControlFrame: () => undefined,
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });

    emitStdout(processId, traceLines(TRACE_SUCCESS));
    // A terminal event does not stop us awaiting the process for cleanup.
    expect(sink.outcomes).toEqual(['completed']);
    emitExit(processId, 0);

    const ends = sink.events.filter((e): e is LoopEndEvent => e.type === 'loop_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(false);
    const texts = sink.events.filter((e): e is TextEvent => e.type === 'text');
    expect(texts[texts.length - 1]!.fullText).toBe('The package name is @trylo/cli.');
  });

  it('writes one framed prompt and retains stdin for input and cancellation', async () => {
    const { processId } = await startTryloV1({
      prompt: 'write a haiku',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: () => undefined,
    });
    expect(h.record.sent).toHaveLength(1);
    expect(h.record.sent[0]!.id).toBe(processId);
    expect(JSON.parse(h.record.sent[0]!.message)).toMatchObject({ type: 'user', message: { role: 'user', content: [{ text: 'write a haiku' }] } });
    // Framed prompts start the run without closing its reply channel.
    expect(h.record.closed).toEqual([]);
    expect(h.record.stopped).toHaveLength(0);
  });

  it('requests a separate stderr channel', async () => {
    await startTryloV1({
      prompt: 'x',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: () => undefined,
    });
    expect(h.record.spawns[0]!.hasStderr).toBe(true);
  });

  it('keeps bootstrap history out of the current human instruction', async () => {
    await startTryloV1({ prompt: '你好', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture',
      priorMessages: [
        { role: 'assistant', kind: 'text', text: '我是 Historical-Assistant，请记住' },
        { role: 'user', kind: 'text', text: 'old human' },
        { role: 'assistant', kind: 'runtime_warning', text: 'do not replay this notice' },
        { role: 'system', kind: 'text', text: 'untrusted system' },
      ], onEvents: () => undefined });
    expect(JSON.parse(h.record.sent[0]!.message)).toMatchObject({
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
      bootstrap_context: { version: 1, messages: [
        { role: 'assistant', content: '我是 Historical-Assistant，请记住' },
        { role: 'user', content: 'old human' },
      ] },
    });
  });

  it('turns an exit with no run_result into a failure, never a completion', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });
    // Half a stream: run_start + a tool call, then the process dies.
    emitStdout(processId, traceLines(TRACE_SUCCESS).slice(0, 3));
    emitExit(processId, traceExitCode(TRACE_PRERUN_FAILURE));

    expect(sink.outcomes).toEqual(['failed']);
    const end = sink.events.find((e): e is LoopEndEvent => e.type === 'loop_end');
    expect(end).toBeDefined();
    expect(end!.isError).toBe(true);
  });

  it('reports a clean exit with no run_result as unknown', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });
    emitExit(processId, 0);
    // Exit 0 is not evidence the run completed.
    expect(sink.outcomes).toEqual(['unknown']);
  });

  it('carries the stderr root cause into the synthesised terminal', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
    });
    emitStderr(processId, traceStderr(TRACE_PRERUN_FAILURE));
    emitExit(processId, 52);
    const end = sink.events.find((e): e is LoopEndEvent => e.type === 'loop_end');
    expect(end!.finalResult).toContain('missing_session');
  });

  it('cancellation yields cancelled, not failed', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });
    await stopTryloV1(processId);
    expect(h.record.stopped).toEqual([processId]);
    emitExit(processId, 1);
    expect(sink.outcomes).toEqual(['cancelled']);
  });

  it('does not close or retry a turn on a broken EOF channel', async () => {
    h.setCloseInputFails(true);
    const sink = collect();
    const { processId, state } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });
    // The prompt WAS written; the turn may have side effects. Retrying
    // would re-run it, so the runner waits for the exit instead.
    expect(h.record.sent).toHaveLength(1);
    expect(h.record.stopped).toHaveLength(0);
    emitExit(processId, 0);
    expect(sink.outcomes).toEqual(['unknown']);
    expect(state()).toBe('exited');
  });

  it('never fires a second terminal for the same run', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });
    emitStdout(processId, traceLines(TRACE_SUCCESS));
    emitExit(processId, 0);
    expect(sink.outcomes).toEqual(['completed']);
    expect(sink.events.filter((e) => e.type === 'loop_end')).toHaveLength(1);
  });

  it('drops every event from a superseded run', async () => {
    let superseded = false;
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      guard: { isSuperseded: () => superseded },
      onEvents: (events) => sink.events.push(...events),
    });
    superseded = true;
    emitStdout(processId, traceLines(TRACE_SUCCESS));
    emitExit(processId, 0);
    expect(sink.events).toHaveLength(0);
  });

  it('stops the child when it is superseded before startup completes', async () => {
    const sink = collect();
    await expect(
      startTryloV1({
        prompt: 'hello',
        cliPath: CLI_PATH,
        cwd: CWD,
        providerId: 'fixture',
        guard: { isSuperseded: () => true },
        onEvents: (events) => sink.events.push(...events),
      }),
    ).rejects.toThrow(/superseded/);
    expect(h.record.stopped).toHaveLength(1);
    expect(h.record.sent).toHaveLength(0);
  });
});

describe('TryloV1Runner — session binding (P08 §6.2)', () => {
  const CLI_ARGS = {
    cliPath: CLI_PATH,
    cwd: CWD,
    providerId: 'fixture',
    permissionLevel: 'read_only' as const,
    onControlFrame: () => undefined,
  };

  /** The real CLI echoes back the id it was given (verified 2026-09-22). */
  const linesForSession = (sessionId: string): string[] =>
    traceLines(TRACE_SUCCESS).map((l) =>
      l.replace(/"sessionId":"[^"]*"/g, `"sessionId":"${sessionId}"`),
    );

  it('sends --session while creating and --resume once established', async () => {
    const creating = beginSessionCreate('run-1', 'desktop-abc');
    const changes: string[] = [];
    const { processId } = await startTryloV1({
      ...CLI_ARGS,
      prompt: 'hello',
      binding: creating,
      onEvents: () => undefined,
      onBindingChange: (b) => changes.push(b.state),
    });
    expect(h.record.spawns[0]!.args).toContain('--session');
    expect(h.record.spawns[0]!.args).toContain('desktop-abc');

    emitStdout(processId, linesForSession('desktop-abc'));
    // `run_start` is the CLI confirming the session — and it must name
    // OUR id, not just any id.
    expect(changes).toEqual(['established']);
    emitExit(processId, 0);

    const resumed = await startTryloV1({
      ...CLI_ARGS,
      prompt: 'and again',
      binding: markSessionEstablished(creating),
      onEvents: () => undefined,
    });
    const args = h.record.spawns[h.record.spawns.length - 1]!.args;
    expect(args).toContain('--resume');
    expect(args).toContain('desktop-abc');
    expect(args).not.toContain('--session');
    expect(resumed.processId).toBeTruthy();
  });

  it('does NOT confirm a session the CLI names differently', async () => {
    // Audit finding: any `loop_start` used to be treated as confirmation.
    // A crossed frame would then attach this conversation to another
    // session's journal. The binding must stay `creating`, and a crash
    // afterwards lands it in `unknown` where a probe settles it.
    const creating = beginSessionCreate('run-1', 'desktop-abc');
    const changes: CliSessionBinding[] = [];
    const { processId } = await startTryloV1({
      ...CLI_ARGS,
      prompt: 'hello',
      binding: creating,
      onEvents: () => undefined,
      onBindingChange: (b) => changes.push(b),
    });
    // The CLI answers with somebody else's session id.
    emitStdout(processId, linesForSession('desktop-someone-else'));
    expect(changes).toEqual([]);
    emitExit(processId, 1);
    // Still creating at exit ⇒ unknown, never established.
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toBe('unknown');
  });

  it('surfaces protocol rejections instead of a generic no-terminal message', async () => {
    // Audit finding: unparseable stdout only reached `rejectedLines()`,
    // which had no production consumer, so the user saw "no terminal
    // event" with no hint that the protocol had drifted.
    const events: LoopEvent[] = [];
    const { processId } = await startTryloV1({
      ...CLI_ARGS,
      prompt: 'hello',
      onEvents: (batch) => events.push(...batch),
    });
    emitStdout(processId, ['{"type":"brand_new_event","x":1}', 'not json at all']);
    emitExit(processId, 1);
    const warnings = events.filter(
      (e): e is RuntimeWarningEvent => e.type === 'runtime_warning',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('protocol_rejected');
    expect(warnings[0]!.message).toContain('unknown_type');
  });

  it('marks the binding unknown when the process dies mid-creation', async () => {
    const creating = beginSessionCreate('run-1', 'desktop-abc');
    const changes: CliSessionBinding[] = [];
    const { processId } = await startTryloV1({
      ...CLI_ARGS,
      prompt: 'hello',
      binding: creating,
      onEvents: () => undefined,
      onBindingChange: (b) => changes.push(b),
    });
    emitExit(processId, 1);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toBe('unknown');
    // Only a probe may resolve it — the runner must not guess.
    if (changes[0]!.state === 'unknown') {
      expect(changes[0]!.sessionId).toBe('desktop-abc');
      expect(changes[0]!.reason).toContain('exited');
    }
  });

  it('does not touch the binding when the run completed normally', async () => {
    const established = markSessionEstablished(beginSessionCreate('run-1', 'desktop-abc'));
    const changes: string[] = [];
    const { processId } = await startTryloV1({
      ...CLI_ARGS,
      prompt: 'hello',
      binding: established,
      onEvents: () => undefined,
      onBindingChange: (b) => changes.push(b.state),
    });
    emitStdout(processId, traceLines(TRACE_SUCCESS));
    emitExit(processId, 0);
    expect(changes).toHaveLength(0);
  });

  it('refuses to start with an unresolved unknown binding', async () => {
    const unknown = markSessionUnknown(beginSessionCreate('run-1', 'desktop-abc'), 'crash');
    await expect(
      startTryloV1({ ...CLI_ARGS, prompt: 'hello', binding: unknown, onEvents: () => undefined }),
    ).rejects.toThrow(/probe/);
    expect(h.record.spawns).toHaveLength(0);
  });

  it('sends no session flag for an ephemeral turn (M0 behaviour)', async () => {
    await startTryloV1({ ...CLI_ARGS, prompt: 'hello', onEvents: () => undefined });
    const args = h.record.spawns[0]!.args;
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--resume');
  });
});
