// Trylo Desktop — CLI session binding tests (P08 §6.2 / WP4).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  let seq = 0;
  const sinks = new Map<
    string,
    {
      out: (line: string) => void;
      exit: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
    }
  >();
  const record = {
    spawns: [] as { id: string; args: string[] }[],
    closed: [] as string[],
    stopped: [] as string[],
  };
  let spawnFails = false;
  let neverExits = false;
  const service = {
    async spawn(opts: {
      command: string;
      args: readonly string[];
      label: string;
      onOutput: (line: string) => void;
      onExit?: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
    }): Promise<{ id: string; pid: number; label: string; command: string }> {
      if (spawnFails) throw new Error('nope');
      const id = `proc-${++seq}`;
      sinks.set(id, { out: opts.onOutput, exit: opts.onExit ?? (() => undefined) });
      record.spawns.push({ id, args: [...opts.args] });
      return { id, pid: 1, label: opts.label, command: opts.command };
    },
    async send(): Promise<void> {
      /* unused */
    },
    async closeInput(id: string): Promise<void> {
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
    setSpawnFails: (v: boolean) => {
      spawnFails = v;
    },
    setNeverExits: (v: boolean) => {
      neverExits = v;
    },
    finish: (id: string, lines: readonly string[], code: number) => {
      const s = sinks.get(id);
      if (!s) throw new Error('no sink');
      for (const l of lines) s.out(l);
      if (!neverExits) s.exit({ id, pid: 1, code, signal: null });
    },
  };
});

vi.mock('./index', () => ({ hostAdapter: { process: h.service } }));

const {
  beginSessionCreate,
  isSessionResumable,
  markSessionEstablished,
  markSessionUnknown,
  newCliSessionId,
  probeCliSessions,
  resolveUnknownBinding,
  sessionArgsFor,
} = await import('./cli-session-binding');

const CLI_PATH = 'D:/CC/trylo/new trylo cli/dist/cmd/trylo/main.js' as never;

beforeEach(() => {
  h.record.spawns.length = 0;
  h.record.closed.length = 0;
  h.record.stopped.length = 0;
  h.sinks.clear();
  h.setSpawnFails(false);
  h.setNeverExits(false);
});

describe('newCliSessionId', () => {
  it('uses an unpredictable id, not a timestamp', () => {
    const a = newCliSessionId();
    const b = newCliSessionId();
    expect(a).not.toBe(b);
    // Guessing one conversation's session id must not let another run
    // attach to its journal.
    expect(a.startsWith('desktop-')).toBe(true);
    expect(a.length).toBeGreaterThan('desktop-'.length + 8);
  });

  it('honours an injected generator (so tests stay deterministic)', () => {
    expect(newCliSessionId(() => 'fixed')).toBe('desktop-fixed');
  });
});

describe('binding state machine', () => {
  it('starts a creation bound to the run that asked for it', () => {
    const b = beginSessionCreate('run-1', 'desktop-abc');
    expect(b).toEqual({ state: 'creating', sessionId: 'desktop-abc', runId: 'run-1' });
    expect(sessionArgsFor(b)).toEqual({ kind: 'session', sessionId: 'desktop-abc' });
  });

  it('switches to --resume once the CLI confirmed the session', () => {
    const b = markSessionEstablished(beginSessionCreate('run-1', 'desktop-abc'));
    expect(b.state).toBe('established');
    expect(sessionArgsFor(b)).toEqual({ kind: 'resume', sessionId: 'desktop-abc' });
  });

  it('retries creation with the same id rather than orphaning the first', () => {
    // Re-inventing an id mid-creation would leave the first attempt's
    // journal behind with nothing pointing at it.
    const creating = beginSessionCreate('run-1', 'desktop-abc');
    expect(sessionArgsFor(creating).kind).toBe('session');
  });

  it('blocks argv until an unknown binding is probed', () => {
    const b = markSessionUnknown(beginSessionCreate('run-1', 'desktop-abc'), 'process exited');
    expect(b.state).toBe('unknown');
    // The whole point: there is no safe flag to send while we don't know.
    expect(sessionArgsFor(b)).toEqual({ kind: 'needs_probe', sessionId: 'desktop-abc' });
  });

  it('has no session flag when no binding exists (M0 behaviour)', () => {
    expect(sessionArgsFor({ state: 'none' })).toEqual({ kind: 'none' });
  });

  it('leaves a none binding alone', () => {
    expect(markSessionEstablished({ state: 'none' })).toEqual({ state: 'none' });
    expect(markSessionUnknown({ state: 'none' }, 'x')).toEqual({ state: 'none' });
  });
});

describe('probeCliSessions', () => {
  it('parses the real session list --json shape', async () => {
    const promise = probeCliSessions({ cliPath: CLI_PATH, sessionId: 'desktop-abc' });
    const id = await Promise.resolve().then(() => h.record.spawns[0]!.id);
    h.finish(
      id,
      ['{"sessions":[{"id":"desktop-abc","path":"x","bytes":418,"modifiedAtMs":1,"formatVersion":"1"}]}'],
      0,
    );
    const probe = await promise;
    expect(probe.ok).toBe(true);
    expect(h.record.spawns[0]!.args).toEqual(expect.arrayContaining(['--search', 'desktop-abc', '--all']));
    if (!probe.ok) return;
    expect(isSessionResumable(probe, 'desktop-abc')).toBe(true);
    expect(isSessionResumable(probe, 'desktop-missing')).toBe(false);
  });

  it('asks for machine-readable output and closes stdin', async () => {
    const promise = probeCliSessions({ cliPath: CLI_PATH });
    const id = await Promise.resolve().then(() => h.record.spawns[0]!.id);
    h.finish(id, ['{"sessions":[]}'], 0);
    await promise;
    expect(h.record.spawns[0]!.args).toContain('--json');
    expect(h.record.closed).toHaveLength(1);
  });

  it('fails closed when the probe cannot be trusted', async () => {
    h.setSpawnFails(true);
    const probe = await probeCliSessions({ cliPath: CLI_PATH });
    expect(probe.ok).toBe(false);
    // A failed probe is NOT "not resumable" — it is "unknown".
    expect(isSessionResumable(probe, 'desktop-abc')).toBeNull();
  });

  it('gives up on a probe that never exits', async () => {
    h.setNeverExits(true);
    const promise = probeCliSessions({ cliPath: CLI_PATH, timeoutMs: 30 });
    await Promise.resolve().then(() => undefined);
    const probe = await promise;
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe('timeout');
    expect(h.record.stopped).toHaveLength(1);
  });
});

describe('resolveUnknownBinding', () => {
  const unknown = markSessionUnknown(beginSessionCreate('run-1', 'desktop-abc'), 'crash');

  it('keeps the session when the CLI says it is resumable', () => {
    expect(resolveUnknownBinding(unknown, true)).toEqual({
      state: 'established',
      sessionId: 'desktop-abc',
    });
  });

  it('starts fresh when the CLI says it is not', () => {
    expect(resolveUnknownBinding(unknown, false)).toEqual({ state: 'none' });
  });

  it('stays unknown when the probe failed — never guesses', () => {
    // Guessing "resumable" would attach to a journal that may not exist;
    // guessing "not resumable" would silently drop real history.
    expect(resolveUnknownBinding(unknown, null)).toEqual(unknown);
  });

  it('does nothing to a binding that is not unknown', () => {
    const established = markSessionEstablished(beginSessionCreate('run-1', 'desktop-abc'));
    expect(resolveUnknownBinding(established, true)).toEqual(established);
  });
});
