// Trylo Desktop — CLI auth/provider status tests (P08 §3.4 / WP4).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Sink = {
    out: (line: string) => void;
    exit: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
  };
  let seq = 0;
  const sinks = new Map<string, Sink>();
  const record = {
    spawns: [] as { id: string; command: string; args: string[] }[],
    closed: [] as string[],
    stopped: [] as string[],
  };
  let spawnFails = false;
  /** When set, the fake never emits an exit (drives the timeout path). */
  let neverExits = false;
  const service = {
    async spawn(opts: {
      command: string;
      args: readonly string[];
      label: string;
      onOutput: (line: string) => void;
      onExit?: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
    }): Promise<{ id: string; pid: number; label: string; command: string }> {
      if (spawnFails) throw new Error('spawn exploded');
      const id = `proc-${++seq}`;
      sinks.set(id, {
        out: opts.onOutput,
        exit: opts.onExit ?? (() => undefined),
      });
      record.spawns.push({ id, command: opts.command, args: [...opts.args] });
      return { id, pid: 1000 + seq, label: opts.label, command: opts.command };
    },
    async send(): Promise<void> {
      /* status commands take no stdin */
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
    finishes: (id: string, lines: readonly string[], code: number) => {
      const s = sinks.get(id);
      if (!s) throw new Error('no sink');
      for (const l of lines) s.out(l);
      if (!neverExits) s.exit({ id, pid: 1001, code, signal: null });
    },
  };
});

vi.mock('./index', () => ({ hostAdapter: { process: h.service } }));

const {
  describeCliAuthProblem,
  providerArgsFor,
  readCliAuthStatus,
  readCliProviders,
} = await import('./cli-auth-status');

const CLI_PATH = 'D:/CC/trylo/new trylo cli/dist/cmd/trylo/main.js' as never;

/** Drive a status probe: spawn it, then finish it with the given output. */
function withProbe<T>(
  lines: readonly string[],
  code: number,
  run: () => Promise<T>,
  opts: { finish?: boolean } = {},
): Promise<T> {
  const promise = run();
  // Let the spawn microtask land, then complete the child.
  return Promise.resolve().then(async () => {
    const id = h.record.spawns[h.record.spawns.length - 1]!.id;
    if (opts.finish !== false) h.finishes(id, lines, code);
    return promise;
  });
}

beforeEach(() => {
  h.record.spawns.length = 0;
  h.record.closed.length = 0;
  h.record.stopped.length = 0;
  h.sinks.clear();
  h.setSpawnFails(false);
  h.setNeverExits(false);
});

describe('readCliAuthStatus', () => {
  it('parses the real status --json shape', async () => {
    const result = await withProbe(
      ['{"providers":[{"providerId":"openai-compatible","layer":"none","accountId":"","loggedIn":false},{"providerId":"fixture","layer":"none","accountId":"","loggedIn":false}]}'],
      0,
      () => readCliAuthStatus({ cliPath: CLI_PATH }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.providers.map((p) => p.providerId)).toEqual([
      'openai-compatible',
      'fixture',
    ]);
    expect(result.providers[0]!.loggedIn).toBe(false);
  });

  it('closes stdin so the probe cannot hang on EOF', async () => {
    await withProbe(['{"providers":[]}'], 0, () => readCliAuthStatus({ cliPath: CLI_PATH }));
    // Golden trace 06 shows a CLI waiting on stdin emits nothing at all;
    // closing is what makes a read-only probe deterministic.
    expect(h.record.closed).toHaveLength(1);
  });

  it('reports a failed spawn instead of pretending everything is fine', async () => {
    h.setSpawnFails(true);
    const result = await readCliAuthStatus({ cliPath: CLI_PATH });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn_failed');
    expect(result.detail).toContain('spawn exploded');
  });

  it('fails closed on a non-zero exit', async () => {
    const result = await withProbe(['some stderr text'], 41, () =>
      readCliAuthStatus({ cliPath: CLI_PATH }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('nonzero_exit');
  });

  it('fails closed when the CLI prints no JSON at all', async () => {
    const result = await withProbe(['not json'], 0, () =>
      readCliAuthStatus({ cliPath: CLI_PATH }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_json');
  });

  it('fails closed when the JSON has the wrong shape', async () => {
    const result = await withProbe(['{"providers":[{"nope":1}]}'], 0, () =>
      readCliAuthStatus({ cliPath: CLI_PATH }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_shape');
  });

  it('gives up on a probe that never exits', async () => {
    h.setNeverExits(true);
    const result = await withProbe([], 0, () =>
      readCliAuthStatus({ cliPath: CLI_PATH, timeoutMs: 30 }),
      { finish: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('timeout');
    // The hung child must not be left behind.
    expect(h.record.stopped).toHaveLength(1);
  });
});

describe('readCliProviders', () => {
  it('parses the provider list including what each needs', async () => {
    const result = await withProbe(
      ['{"selected":"fixture","providers":[{"id":"fixture","kind":"fixture","auth":"none","selected":true,"capabilities":["streaming"]},{"id":"openai-compatible","kind":"openai-compatible","auth":"api_key","selected":false,"capabilities":["streaming"]}]}'],
      0,
      () => readCliProviders({ cliPath: CLI_PATH }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selected).toBe('fixture');
    expect(result.providers.find((p) => p.id === 'openai-compatible')?.auth).toBe('api_key');
  });
});

describe('describeCliAuthProblem', () => {
  it('tells the user to log in, naming the provider', () => {
    const msg = describeCliAuthProblem(
      { ok: true, providers: [{ providerId: 'openai-compatible', layer: 'none', accountId: '', loggedIn: false }] },
      'openai-compatible',
    );
    expect(msg).toContain('未登录');
    expect(msg).toContain('openai-compatible');
  });

  it('says nothing when the provider is logged in', () => {
    expect(
      describeCliAuthProblem(
        { ok: true, providers: [{ providerId: 'fixture', layer: 'user', accountId: 'a', loggedIn: true }] },
        'fixture',
      ),
    ).toBe('');
  });

  it('reports an unknown provider instead of staying silent', () => {
    expect(
      describeCliAuthProblem({ ok: true, providers: [] }, 'openai-compatible'),
    ).toContain('未登记');
  });

  it('turns a probe failure into an actionable message', () => {
    expect(
      describeCliAuthProblem({ ok: false, reason: 'spawn_failed', detail: 'boom' }, 'fixture'),
    ).toContain('CLI 路径');
  });
});

describe('providerArgsFor', () => {
  it('never carries a credential through argv', () => {
    // §3.4: the new CLI reads its own ledger. Passing Desktop's key here
    // would create a second source of truth and put a secret in argv
    // (visible in process listings and in the Rust spawn log).
    const args = providerArgsFor({
      providerId: 'openai-compatible',
      apiHost: 'https://api.example.com',
      apiModel: 'gpt-x',
      apiFormat: 'openai',
    });
    expect(JSON.stringify(args)).not.toContain('sk-');
    expect(Object.keys(args)).toEqual(['providerId', 'endpoint', 'model']);
  });

  it('maps an openai-format connection onto the openai-compatible provider', () => {
    expect(providerArgsFor({ apiFormat: 'openai' }).providerId).toBe('openai-compatible');
  });

  it('omits an empty host so it cannot clobber the CLI endpoint', () => {
    // An empty --endpoint would override the CLI's own configuration
    // with nothing.
    expect(providerArgsFor({ apiHost: '   ' }).endpoint).toBeUndefined();
  });

  it('omits everything when nothing is configured', () => {
    expect(providerArgsFor({})).toEqual({});
  });
});
