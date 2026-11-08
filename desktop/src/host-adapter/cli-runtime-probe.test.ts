// Trylo Desktop — the read-only runtime-kind probe (P08 §WP7.1).
//
// §5.1 requires that a path the user supplied be PROBED rather than
// guessed at, and both CLI families ship an entry whose name gives
// nothing away (`trylo cli/cli.js` vs `new trylo cli/dist/cmd/trylo/main.js`
// — one is a Claude Code fork, the other is the new runtime). The probe
// therefore asks the binary, and it claims a family only on a positive
// product marker.
//
// Markers asserted here were read off the two real binaries on
// 2026-09-22 (evidence/wp7-red/probe-versions.txt, probe-help.txt):
//
//   legacy `--version` → 2.1.88-trylo (Claude Code)
//   legacy `--help`    → Usage: claude … / Claude Code - starts …
//   v1     `--help`    → trylo - learning agent CLI
//   v1     `--version` → 0.0.0
//
// The last line is the point of the redesign recorded in the source: a
// bare version number is NOT evidence of the family, so it is never used
// to decide one.

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
    spawns: [] as { id: string; command: string; args: string[] }[],
    stopped: [] as string[],
    statted: [] as string[],
  };
  // The probe checks existence before spawning (so "no file there" stays a
  // distinct answer from "the spawn failed"), which makes the fs capability
  // part of its contract — so the mock has to model it.
  const missing = new Set<string>();
  const fs = {
    async statFile(path: string) {
      record.statted.push(path);
      if (missing.has(path)) throw new Error('ENOENT: no such file or directory');
      return { size: 1, isFile: true, isDirectory: false, modifiedMs: 0 };
    },
  };
  let spawnFails = false;
  // Spawns at or after this index never emit an exit. Per-index rather
  // than one flag, because "the first run hangs" and "the second run
  // hangs" are different failures and BOTH must surface as `timeout`.
  let neverExitsFrom = Number.POSITIVE_INFINITY;
  const service = {
    async spawn(opts: {
      command: string;
      args: readonly string[];
      label: string;
      onOutput: (line: string) => void;
      onExit?: (info: { id: string; pid: number; code: number | null; signal: number | null }) => void;
    }): Promise<{ id: string; pid: number; label: string; command: string }> {
      if (spawnFails) throw new Error('spawn refused');
      const id = `proc-${++seq}`;
      sinks.set(id, { out: opts.onOutput, exit: opts.onExit ?? (() => undefined) });
      record.spawns.push({ id, command: opts.command, args: [...opts.args] });
      return { id, pid: 1, label: opts.label, command: opts.command };
    },
    async send(): Promise<void> {
      /* unused */
    },
    async closeInput(): Promise<void> {
      /* unused */
    },
    async stop(id: string): Promise<void> {
      record.stopped.push(id);
    },
    async list(): Promise<readonly never[]> {
      return [];
    },
  };
  return {
    record,
    service,
    fs,
    setPathMissing: (path: string, v: boolean) => {
      if (v) missing.add(path);
      else missing.delete(path);
    },
    clearMissing: () => missing.clear(),
    setSpawnFails: (v: boolean) => {
      spawnFails = v;
    },
    setNeverExits: (v: boolean) => {
      neverExitsFrom = v ? 0 : Number.POSITIVE_INFINITY;
    },
    setNeverExitsFrom: (index: number) => {
      neverExitsFrom = index;
    },
    finish: (id: string, lines: readonly string[], code: number) => {
      const s = sinks.get(id);
      if (!s) throw new Error('no sink');
      for (const l of lines) s.out(l);
      const at = record.spawns.findIndex((spawn) => spawn.id === id);
      if (at >= neverExitsFrom) return;
      s.exit({ id, pid: 1, code, signal: null });
    },
    spawnArgs: (i: number) => record.spawns[i]?.args ?? [],
    spawnCommand: (i: number) => record.spawns[i]?.command ?? '',
    lastId: () => record.spawns[record.spawns.length - 1]?.id ?? '',
  };
});

vi.mock('./index', () => ({ hostAdapter: { process: h.service, fs: h.fs } }));

const { probeCliRuntimeKind } = await import('./cli-runtime-probe');

const V1_ENTRY = 'D:/CC/trylo/new trylo cli/dist/cmd/trylo/main.js';
const LEGACY_ENTRY = 'D:/CC/trylo/trylo cli/cli.js';

const V1_HELP = ['trylo - learning agent CLI', '', 'Usage:', '  trylo   start the interactive REPL'];
const LEGACY_HELP = ['Usage: claude [options] [command] [prompt]', '', 'Claude Code - starts an'];

/** Wait until spawn #i has happened, then answer it. */
async function waitForSpawn(i: number): Promise<string> {
  for (let n = 0; n < 200; n += 1) {
    const id = h.record.spawns[i]?.id;
    if (id !== undefined) return id;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`spawn #${i} never happened`);
}

async function driveSpawns(answers: readonly { lines: readonly string[]; code: number }[]): Promise<void> {
  for (let i = 0; i < answers.length; i += 1) {
    const id = await waitForSpawn(i);
    const answer = answers[i];
    if (answer === undefined) throw new Error('missing answer');
    h.finish(id, answer.lines, answer.code);
  }
}

beforeEach(() => {
  h.record.spawns.length = 0;
  h.record.stopped.length = 0;
  h.record.statted.length = 0;
  h.clearMissing();
  h.setSpawnFails(false);
  h.setNeverExits(false);
});

describe('probeCliRuntimeKind', () => {
  it('can prove runtime identity from help alone without a redundant version process', async () => {
    const promise = probeCliRuntimeKind({ entryScript: V1_ENTRY, preferredProbe: 'help', timeoutMs: 200 });
    const id = await waitForSpawn(0);
    h.finish(id, V1_HELP, 0);
    const result = await promise;
    expect(result).toMatchObject({ ok: true, kind: 'trylo-v1' });
    expect(h.record.spawns).toHaveLength(1);
    expect(h.spawnArgs(0)).toEqual([V1_ENTRY, '--help']);
  });
  it('help-first still reports a mismatched legacy runtime instead of trusting the preference', async () => {
    const promise = probeCliRuntimeKind({ entryScript: V1_ENTRY, preferredProbe: 'help' });
    await driveSpawns([{ lines: LEGACY_HELP, code: 0 }]);
    expect(await promise).toMatchObject({ ok: true, kind: 'legacy' });
    expect(h.record.spawns).toHaveLength(1);
  });
  it('help-first falls back to version only when help cannot establish identity', async () => {
    const promise = probeCliRuntimeKind({ entryScript: V1_ENTRY, preferredProbe: 'help' });
    await driveSpawns([{ lines: ['Usage: an unknown program'], code: 0 },
      { lines: ['2.1.88-trylo (Claude Code)'], code: 0 }]);
    expect(await promise).toMatchObject({ ok: true, kind: 'legacy' });
    expect(h.spawnArgs(1)).toEqual([V1_ENTRY, '--version']);
  });
  it('recognises the legacy CLI from its version banner, in one spawn', async () => {
    const promise = probeCliRuntimeKind({ entryScript: LEGACY_ENTRY, nodeProgram: 'node' });
    await driveSpawns([{ lines: ['2.1.88-trylo (Claude Code)'], code: 0 }]);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('legacy');
      expect(result.version).toBe('2.1.88-trylo');
    }
    expect(h.record.spawns).toHaveLength(1);
  });

  it('requires the v1 help banner before claiming the new runtime', async () => {
    const promise = probeCliRuntimeKind({ entryScript: V1_ENTRY, nodeProgram: 'D:/node/node.exe' });
    await driveSpawns([
      { lines: ['0.0.0'], code: 0 },
      { lines: V1_HELP, code: 0 },
    ]);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('trylo-v1');
      expect(result.version).toBe('0.0.0');
      // The evidence names the marker that decided it, not the version.
      expect(result.evidence).toContain('learning agent CLI');
    }
    expect(h.record.spawns).toHaveLength(2);
  });

  it('a CLI that merely prints a version number is refused, not adopted', async () => {
    // The hole this closes: the first cut treated "looks like semver" as
    // proof of the new runtime. An unrelated tool would then have been
    // handed `run --format stream-json`.
    const promise = probeCliRuntimeKind({ entryScript: 'D:/tools/something.js', nodeProgram: 'node' });
    await driveSpawns([
      { lines: ['3.4.5'], code: 0 },
      { lines: ['Usage: something --do-a-thing'], code: 0 },
    ]);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unrecognized');
  });

  it('runs the interpreter from the same resolution as the entry', async () => {
    // Audit P1 at the probe: a pinned Node that never reaches the spawn
    // would make the probe report the wrong thing on a machine with none
    // on PATH.
    const promise = probeCliRuntimeKind({
      entryScript: V1_ENTRY,
      nodeProgram: 'C:/Program Files/Trylo/resources/runtime/node/win-x64/node.exe',
    });
    await waitForSpawn(0);
    expect(h.spawnCommand(0)).toBe('C:/Program Files/Trylo/resources/runtime/node/win-x64/node.exe');
    expect(h.spawnArgs(0)).toEqual([V1_ENTRY, '--version']);
    await driveSpawns([
      { lines: ['0.0.0'], code: 0 },
      { lines: V1_HELP, code: 0 },
    ]);
    await promise;
  });

  it('a --help that never exits is a TIMEOUT, not "unrecognized"', async () => {
    // Regression for the first cut, which swallowed a failed second run:
    // `helpBanner: help.ok ? help.stdout : null` turned "it never answered"
    // into "it answered and we do not know it". Those are different facts
    // and the WP's test matrix forbids collapsing a timeout into an
    // ordinary verdict.
    h.setNeverExitsFrom(1);
    const promise = probeCliRuntimeKind({ entryScript: V1_ENTRY, timeoutMs: 40 });
    await driveSpawns([{ lines: ['0.0.0'], code: 0 }]);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('timeout');
    expect(h.record.stopped).toHaveLength(1);
  });

  it('is bounded: a CLI that never exits is stopped and reported as a timeout', async () => {
    h.setNeverExits(true);
    const result = await probeCliRuntimeKind({ entryScript: V1_ENTRY, timeoutMs: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('timeout');
    expect(h.record.stopped).toHaveLength(1);
  });

  it('a binary that is not on disk is not_found, BEFORE any spawn', async () => {
    // The taxonomy has `not_found` and the caller's table maps it to
    // `entry_missing`. Until this check existed nothing on the real path
    // could produce it: a missing file made the host reject the spawn, and
    // the only thing that comes back is a localised OS string.
    h.setPathMissing(V1_ENTRY, true);
    const result = await probeCliRuntimeKind({ entryScript: V1_ENTRY, nodeProgram: 'D:/node/node.exe' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.detail).toContain(V1_ENTRY);
    }
    expect(h.record.spawns).toHaveLength(0);
  });

  it('checks the interpreter as well as the script', async () => {
    // `node <script>` fails on whichever of the two is absent; naming the
    // wrong one sends the reader looking in the wrong place.
    h.setPathMissing('D:/node/node.exe', true);
    const result = await probeCliRuntimeKind({ entryScript: V1_ENTRY, nodeProgram: 'D:/node/node.exe' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_found');
      expect(result.detail).toContain('D:/node/node.exe');
    }
    expect(h.record.spawns).toHaveLength(0);
  });

  it('a bare command name is not stat-ed (PATH resolves it, a file stat cannot)', async () => {
    const promise = probeCliRuntimeKind({ entryScript: LEGACY_ENTRY, nodeProgram: 'node' });
    await driveSpawns([{ lines: ['2.1.88-trylo (Claude Code)'], code: 0 }]);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(h.record.statted).not.toContain('node');
  });

  it('a spawn failure is typed rather than thrown', async () => {
    h.setSpawnFails(true);
    const result = await probeCliRuntimeKind({ entryScript: V1_ENTRY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('spawn_failed');
  });

  it('an already-aborted signal does not spawn at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await probeCliRuntimeKind({ entryScript: V1_ENTRY, signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('timeout');
    expect(h.record.spawns).toHaveLength(0);
  });

  it('refuses an empty entry without spawning', async () => {
    const result = await probeCliRuntimeKind({ entryScript: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(h.record.spawns).toHaveLength(0);
  });

  it('a legacy --help is also enough when --version is silent', async () => {
    // Belt and braces: if a future legacy build drops the version banner
    // the help banner still identifies it, and the failure mode stays
    // "identified", never "guessed as the new CLI".
    const promise = probeCliRuntimeKind({ entryScript: LEGACY_ENTRY, nodeProgram: 'node' });
    await driveSpawns([
      { lines: [], code: 0 },
      { lines: LEGACY_HELP, code: 0 },
    ]);
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe('legacy');
  });
});
