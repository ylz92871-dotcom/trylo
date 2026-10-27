// Trylo Desktop — TryloV1Runner integration tests (P08 WP1).
//
// These drive the runner through a scripted ProcessService, so the four
// lifecycle cases WP1's exit criterion names are exercised for real:
// a fixture text run, stdin EOF, an exit with no terminal event, and a
// cancellation. The bytes fed to stdout are the frozen golden traces.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent, RuntimeWarningEvent } from './loop-events';
import type { LoopEndEvent, TextEvent } from './loop-events';
import type { LiveProcessInfo, ProcessExitInfo } from './process-service';
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
    exit: (info: ProcessExitInfo) => void;
  };
  let seq = 0;
  const sinks = new Map<string, Sink>();
  const registrations = new Map<string, LiveProcessInfo>();
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
      onExit?: (info: ProcessExitInfo) => void;
    }): Promise<{ id: string; pid: number; label: string; command: string }> {
      const id = `proc-${++seq}`;
      const handle = { id, pid: 1000 + seq, label: opts.label, command: opts.command };
      registrations.set(id, { ...handle, metadata: {} });
      sinks.set(id, {
        out: opts.onOutput,
        err: opts.onStderr ?? (() => undefined),
        exit: info => { registrations.delete(id); opts.onExit?.(info); },
      });
      record.spawns.push({
        id,
        command: opts.command,
        args: [...opts.args],
        hasStderr: typeof opts.onStderr === 'function',
      });
      return handle;
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
    async list(): Promise<readonly LiveProcessInfo[]> {
      return [...registrations.values()];
    },
  };
  return {
    sinks,
    registrations,
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
  isTryloV1Process,
  TryloV1UnsupportedError,
} = await import('./trylo-v1-runner');

const CLI_PATH = 'C:/work/demo-ws/new trylo cli/dist/cmd/trylo/main.js' as never;
const CWD = 'C:/work/demo-ws/workspace' as never;

describe('cancellation before native spawn response', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['confirmed', 'refused'] as const)('delivers the cancelled handle before %s cleanup', async mode => {
    let ready!: (id: string) => void; let release!: () => void;
    const acquired = new Promise<string>(resolve => { ready = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const spawn = h.service.spawn.bind(h.service);
    vi.spyOn(h.service, 'spawn').mockImplementationOnce(async options => {
      const handle = await spawn(options); ready(handle.id); await delayed; return handle;
    });
    let cancelled = false;
    const onSpawn = vi.fn(); const onExit = vi.fn();
    const starting = startTryloV1({ prompt: 'must not be delivered', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', guard: { isSuperseded: () => cancelled }, onEvents: () => {}, onSpawn, onExit });
    const settled = starting.then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, error }));
    const id = await acquired; cancelled = true;
    vi.spyOn(h.service, 'send').mockRejectedValue(new Error('cancelled control pipe'));
    vi.spyOn(h.service, 'stop').mockImplementationOnce(async processId => {
      if (mode === 'refused') throw new Error('cancelled startup cleanup refused');
      emitExit(processId, 130);
    });
    try {
      release(); const result = await settled;
      expect(onSpawn).toHaveBeenCalledOnce();
      expect(onSpawn.mock.calls[0][0].id).toBe(id);
      expect(h.record.sent.some(row => JSON.parse(row.message).type === 'user')).toBe(false);
      if (mode === 'refused') {
        expect(result.kind).toBe('rejected');
        if (result.kind === 'rejected') {
          expect(result.error).toBeInstanceOf(AggregateError);
          expect((result.error as AggregateError).errors.map(String).join(' ')).toContain('cleanup refused');
        }
        expect(isTryloV1Process(id)).toBe(true);
        vi.spyOn(h.service, 'stop').mockImplementationOnce(async processId => { emitExit(processId, 130); });
        await stopTryloV1(id);
      } else {
        expect(result.kind).toBe('rejected');
        if (result.kind === 'rejected') expect(String(result.error)).toContain('superseded');
      }
      expect(isTryloV1Process(id)).toBe(false);
      expect(onExit).toHaveBeenCalledOnce();
    } finally { release(); emitExit(id, 130); await settled; }
  });
});

describe('tracked stop with a lost exit callback', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['acknowledged', 'refused'] as const)('confirms native absence after %s Stop, exactly once', async mode => {
    vi.useFakeTimers();
    const sink = collect();
    const exits: ProcessExitInfo[] = [];
    const run = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: events => sink.events.push(...events),
      onTerminal: outcome => sink.outcomes.push(outcome), onExit: info => exits.push(info) });
    const other = await startTryloV1({ prompt: 'other', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: () => {} });
    const handle = h.registrations.get(run.processId)!;
    h.registrations.delete(run.processId); // Native wait observed exit; WebView callback was lost.
    vi.spyOn(h.service, 'send').mockRejectedValueOnce(new Error('closed stdin'));
    if (mode === 'refused') vi.spyOn(h.service, 'stop').mockRejectedValueOnce(new Error('stop IPC refused'));
    const receipt = { error: undefined as unknown };
    const stopping = stopTryloV1(run.processId).catch(error => { receipt.error = error; });
    try {
      await vi.advanceTimersByTimeAsync(2000);
      await stopping;
      expect(receipt.error).toBeUndefined();
      expect(run.state()).toBe('exited');
      expect(isTryloV1Process(run.processId)).toBe(false);
      expect(exits).toEqual([{ id: run.processId, pid: handle.pid, code: null, signal: null, outputComplete: false }]);
      expect(sink.outcomes).toEqual(['cancelled']);
      expect(isTryloV1Process(other.processId)).toBe(true);
      emitExit(run.processId, 130); // A delayed callback must not publish another terminal or exit.
      expect(exits).toHaveLength(1);
      expect(sink.events.filter(event => event.type === 'loop_end')).toHaveLength(1);
      expect(h.record.stopped).not.toContain(other.processId);
    } finally { emitExit(run.processId, 130); emitExit(other.processId, 130); await stopping; }
  });

  it.each(['rejected', 'null', 'bad-row', 'still-live'] as const)('retains ownership for a %s native snapshot', async mode => {
    vi.useFakeTimers();
    const exits = vi.fn();
    const run = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: () => {}, onExit: exits });
    vi.spyOn(h.service, 'send').mockRejectedValueOnce(new Error('closed stdin'));
    vi.spyOn(h.service, 'stop').mockRejectedValueOnce(new Error('stop IPC refused'));
    const listing = vi.spyOn(h.service, 'list');
    if (mode === 'rejected') listing.mockRejectedValueOnce(new Error('list IPC refused'));
    if (mode === 'null') listing.mockResolvedValueOnce(null as never);
    if (mode === 'bad-row') listing.mockResolvedValueOnce([{ id: '' }] as never);
    const receipt = { error: undefined as unknown };
    const stopping = stopTryloV1(run.processId).catch(error => { receipt.error = error; });
    try {
      await vi.advanceTimersByTimeAsync(2000); await stopping;
      expect(listing).toHaveBeenCalledOnce();
      expect(String(receipt.error)).toMatch(/stop|停止/i);
      if (mode !== 'still-live') {
        expect(receipt.error).toBeInstanceOf(AggregateError);
        const aggregate = receipt.error as AggregateError;
        expect(aggregate.errors.map(String).join(' ')).toMatch(/list|列表/i);
      }
      expect(isTryloV1Process(run.processId)).toBe(true);
      expect(exits).not.toHaveBeenCalled();
    } finally { emitExit(run.processId, 130); await stopping; }
  });

  it('bounds the list waiter, ignores its late empty result and permits an explicit retry', async () => {
    vi.useFakeTimers();
    const exits = vi.fn();
    const run = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: () => {}, onExit: exits });
    let release!: (rows: readonly LiveProcessInfo[]) => void;
    vi.spyOn(h.service, 'list').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    vi.spyOn(h.service, 'send').mockRejectedValue(new Error('closed stdin'));
    vi.spyOn(h.service, 'stop').mockRejectedValue(new Error('stop IPC refused'));
    const receipt = { error: undefined as unknown };
    const stopping = stopTryloV1(run.processId).catch(error => { receipt.error = error; });
    try {
      await vi.advanceTimersByTimeAsync(1100); await stopping;
      expect(receipt.error).toBeInstanceOf(AggregateError);
      release([]); await vi.advanceTimersByTimeAsync(1);
      expect(isTryloV1Process(run.processId)).toBe(true);
      expect(exits).not.toHaveBeenCalled();
      h.registrations.delete(run.processId);
      await stopTryloV1(run.processId);
      expect(exits).toHaveBeenCalledOnce();
      expect(isTryloV1Process(run.processId)).toBe(false);
    } finally { release?.([]); emitExit(run.processId, 130); await stopping; }
  });

  it('accepts a real exit without waiting for a stalled native list', async () => {
    vi.useFakeTimers();
    const exits = vi.fn();
    const run = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: () => {}, onExit: exits });
    vi.spyOn(h.service, 'send').mockRejectedValueOnce(new Error('closed stdin'));
    vi.spyOn(h.service, 'stop').mockRejectedValueOnce(new Error('stop IPC refused'));
    vi.spyOn(h.service, 'list').mockImplementationOnce(() => new Promise(() => {}));
    const receipt = { state: 'pending' };
    const stopping = stopTryloV1(run.processId).then(() => { receipt.state = 'resolved'; }, () => { receipt.state = 'rejected'; });
    try {
      await vi.advanceTimersByTimeAsync(1); emitExit(run.processId, 130);
      await vi.advanceTimersByTimeAsync(1);
      expect(receipt.state).toBe('resolved'); expect(exits).toHaveBeenCalledOnce();
    } finally { emitExit(run.processId, 130); await stopping; }
  });
});

describe('bounded tracked v1 stop', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(['send', 'stop'] as const)('an actual exit releases a pending %s receipt', async channel => {
    vi.useFakeTimers();
    const sink = collect();
    const { processId } = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: events => sink.events.push(...events) });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    if (channel === 'stop') vi.spyOn(h.service, 'send').mockRejectedValueOnce(new Error('broken control pipe'));
    vi.spyOn(h.service, channel).mockImplementationOnce(() => pending);
    const receipt = { state: 'pending' };
    const stopping = stopTryloV1(processId).then(() => { receipt.state = 'resolved'; }, () => { receipt.state = 'rejected'; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      emitExit(processId, 130);
      await vi.advanceTimersByTimeAsync(1);
      expect(receipt.state).toBe('resolved');
      expect(sink.events.filter(event => event.type === 'loop_end')).toHaveLength(1);
    } finally { release(); await stopping; }
  });

  it.each(['send', 'stop'] as const)('a hung %s times out without an exit fact and permits an explicit retry', async channel => {
    vi.useFakeTimers();
    const sink = collect();
    const { processId, state } = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
      providerId: 'fixture', onEvents: events => sink.events.push(...events) });
    let refuse!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { refuse = reject; });
    if (channel === 'stop') vi.spyOn(h.service, 'send').mockRejectedValueOnce(new Error('broken control pipe'));
    vi.spyOn(h.service, channel).mockImplementationOnce(() => pending);
    const receipt = { state: 'pending', message: '' };
    const stopping = stopTryloV1(processId).then(() => { receipt.state = 'resolved'; }, error => {
      receipt.state = 'rejected'; receipt.message = String(error);
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(receipt.state).toBe('rejected');
      expect(receipt.message).toMatch(/exit|退出|超时/i);
      expect(state()).not.toBe('exited');
      expect(sink.events.some(event => event.type === 'loop_end')).toBe(false);
      // A late refusal is observed by the expired waiter, not a new terminal.
      refuse(new Error('late IPC refusal'));
      await vi.advanceTimersByTimeAsync(1);
      const retry = stopTryloV1(processId);
      emitExit(processId, 130);
      await retry;
      expect(state()).toBe('exited');
      expect(sink.events.filter(event => event.type === 'loop_end')).toHaveLength(1);
    } finally {
      refuse(new Error('test cleanup'));
      emitExit(processId, 130);
      await stopping;
    }
  });
});

describe('initial prompt delivery ownership', () => {
  it('reports incomplete tail on an actual exit without manufacturing completed', async () => {
    const sink = collect();
    const { processId } = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture',
      onEvents: events => sink.events.push(...events), onTerminal: outcome => sink.outcomes.push(outcome) });
    h.sinks.get(processId)!.exit({ id: processId, pid: 1001, code: 0, signal: null, outputComplete: false });
    expect(sink.events.some(event => event.type === 'runtime_warning' && event.code === 'process_output_incomplete')).toBe(true);
    expect(sink.outcomes).toEqual(['unknown']);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('does not dispatch a prompt when acquiring its handle synchronously supersedes startup', async () => {
    let superseded = false;
    vi.spyOn(h.service, 'stop').mockImplementationOnce(async id => { emitExit(id, 130); });
    const args = { prompt: 'must not dispatch', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture',
      guard: { isSuperseded: () => superseded }, onEvents() {}, onSpawn: () => { superseded = true; } };
    try {
      await expect(startTryloV1(args)).rejects.toThrow(/prompt/i);
      expect(h.record.sent.some(frame => JSON.parse(frame.message).type === 'user')).toBe(false);
    } finally { emitExit(h.record.spawns[0]!.id, 130); }
  });

  it('publishes the spawned handle before attempting prompt IO', async () => {
    const order: string[] = [];
    vi.spyOn(h.service, 'send').mockImplementationOnce(async () => { order.push('write'); });
    const args = { prompt: 'hello', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture',
      onEvents() {}, onSpawn: () => { order.push('owner'); } };
    const { processId } = await startTryloV1(args);
    try { expect(order).toEqual(['owner', 'write']); } finally { emitExit(processId, 0); }
  });

  it('an actual exit releases an initial write that never acknowledges', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(h.service, 'send').mockImplementationOnce(() => pending);
    const receipt = { state: 'pending' };
    const starting = startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture', onEvents() {} });
    const settled = starting.then(() => { receipt.state = 'resolved'; }, () => { receipt.state = 'rejected'; });
    await vi.advanceTimersByTimeAsync(1);
    const processId = h.record.spawns[0]!.id;
    try {
      emitExit(processId, 41);
      await vi.advanceTimersByTimeAsync(1);
      expect(receipt.state).toBe('resolved');
    } finally { release(); await settled; }
  });

  it('a rejected prompt with refused cleanup keeps its original live owner for Stop retry', async () => {
    const outcomes: string[] = [];
    vi.spyOn(h.service, 'send').mockRejectedValue(new Error('write refused'));
    vi.spyOn(h.service, 'stop').mockRejectedValueOnce(new Error('native stop refused'));
    await expect(startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture',
      onEvents() {}, onTerminal: outcome => outcomes.push(outcome) }))
      .rejects.toThrow(/prompt|stdin/i);
    const processId = h.record.spawns[0]!.id;
    try {
      expect(isTryloV1Process(processId)).toBe(true);
      expect(outcomes).toEqual([]);
    } finally {
      const retry = stopTryloV1(processId);
      emitExit(processId, 130);
      await retry;
    }
    expect(isTryloV1Process(processId)).toBe(false);
    expect(outcomes).toEqual(['cancelled']);
  });

  it('a hung initial write fails within the delivery and cleanup deadlines without losing ownership', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(h.service, 'send').mockImplementationOnce(() => pending);
    const events: LoopEvent[] = [];
    const receipt = { state: 'pending' };
    const starting = startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD, providerId: 'fixture',
      onEvents: batch => events.push(...batch) });
    const settled = starting.then(() => { receipt.state = 'resolved'; }, () => { receipt.state = 'rejected'; });
    await vi.advanceTimersByTimeAsync(1);
    const processId = h.record.spawns[0]!.id;
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(receipt.state).toBe('rejected');
      expect(isTryloV1Process(processId)).toBe(true);
      expect(events.some(event => event.type === 'loop_end')).toBe(false);
      expect(events.some(event => event.type === 'runtime_warning' && event.code === 'prompt_delivery_uncertain')).toBe(true);
    } finally { emitExit(processId, 130); release(); await settled; }
  });
});

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
  h.registrations.clear();
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
    vi.useFakeTimers();
    try {
    const sink = collect();
    const { processId } = await startTryloV1({
      prompt: 'hello',
      cliPath: CLI_PATH,
      cwd: CWD,
      providerId: 'fixture',
      onEvents: (events) => sink.events.push(...events),
      onTerminal: (outcome) => sink.outcomes.push(outcome),
    });
    const stopping = stopTryloV1(processId);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.record.stopped).toEqual([processId]);
    emitExit(processId, 1);
    await stopping;
    expect(sink.outcomes).toEqual(['cancelled']);
    } finally { vi.useRealTimers(); }
  });

  it('does not treat an acknowledged kill command as a confirmed process exit', async () => {
    vi.useFakeTimers();
    try {
      const sink = collect();
      const { processId } = await startTryloV1({ prompt: 'hello', cliPath: CLI_PATH, cwd: CWD,
        providerId: 'fixture', onEvents: events => sink.events.push(...events) });
      const stopping = stopTryloV1(processId);
      const rejected = expect(stopping).rejects.toThrow(/exit|退出/i);
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(h.record.stopped).toEqual([processId]);
      expect(sink.events.some(event => event.type === 'loop_end')).toBe(false);
      emitExit(processId, 1);
      expect(sink.events.filter(event => event.type === 'loop_end')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
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
    vi.spyOn(h.service, 'send').mockRejectedValueOnce(new Error('cancelled control pipe'));
    vi.spyOn(h.service, 'stop').mockImplementationOnce(async id => { h.record.stopped.push(id); emitExit(id, 130); });
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
