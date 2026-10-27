// Trylo Desktop — the read-only CLI runtime probe (P08 §WP7.1 / §5.1).
//
// §5.1: "用户显式自定义路径时必须探测其协议，不得根据文件名猜测". Both CLI
// families ship an entry whose name gives nothing away (`trylo cli/cli.js`
// vs `new trylo cli/dist/cmd/trylo/main.js` — one is a Claude Code fork,
// the other the new runtime), so the probe asks the binary.
//
// This is the ONLY file in the package that spawns anything. It is split
// from `cli-runtime-resolution.ts` so the selection logic stays free of a
// process bridge — a caller that only needs "which runtime did we choose?"
// should not have to load one.
//
// Everything here is bounded and typed: no path throws, a timeout stops the
// child, and "we could not find out" is never collapsed into "we know".

import { hostAdapter } from './index';
import type {
  CliProbeFailureCode,
  CliRuntimeKind,
  CliRuntimeProbeResult,
} from './cli-runtime-adapter';

/**
 * The budget for EACH read-only probe run, sized for the TYPICAL case.
 *
 * Two rounds of three runs each on this machine (2026-09-22,
 * `node <entry> <flag>`, evidence/wp7-benchmark/01-probe-timing.txt):
 *
 *              round 1                 round 2
 *   v1     --version   593 / 582 / 592     10117 / 740 / 741
 *   v1     --help      685 / 708 / 631     743 / 938 / 994
 *   legacy --version  1694 / 836 / 796    2415 / 1452 / 844
 *   legacy --help    30665 / 2801 / 2485  32886 / 6213 / 15501
 *
 * Two things this table says that a bare number would hide:
 *
 *   1. The steady-state cost is 0.6-2.4 s. The first cut used 4000, chosen
 *      with no measurement behind it — that is 1.7x the legacy `--version`
 *      steady state and it would have timed out on a COLD read of EITHER
 *      binary. (For scale, Claude Code budgets 3000 ms to probe a *small C
 *      binary* and 10-30 s for network/IO work.)
 *   2. Cold first reads are not a legacy problem: round 2 caught the NEW CLI
 *      at 10.1 s on `--version`, and legacy at 15.5 s and 32.9 s. These are
 *      filesystem/AV costs of touching a multi-megabyte file the first time.
 *
 * Across 24 samples over three rounds the steady state was: median 845 ms,
 * worst 4058 ms (3.7x headroom here); the cold outliers were 6.8 s, 11.8 s
 * and 28.1 s. 15000 covers the steady state and the smallest cold outlier.
 * It does NOT cover the largest ones, on purpose: a budget that absorbs a
 * 28 s outlier means the caller — the settings screen, or a turn — blocks for
 * half a minute, which is worse than saying so.
 *
 * So a `timeout` from this probe means **"not answered within the budget;
 * retry with a larger one, or memoise"** — never "this binary is wrong". A
 * caller that knows it is probing something large should pass a bigger
 * `timeoutMs`; the real fix for the cold path is memoisation
 * (`OPEN-WP7-12`). Numbers live in
 * evidence/wp7-benchmark/01-probe-timing.txt; re-measure before changing
 * this constant.
 */
export const DEFAULT_KIND_PROBE_TIMEOUT_MS = 15000;


/**
 * Positive family markers.
 *
 * The first cut of this classified `trylo-v1` by "the banner looks like a
 * semantic version". That is a heuristic, and §5.1 forbids heuristics
 * here: any third CLI that prints `1.2.3` would have been accepted as the
 * new runtime and then handed `run --format stream-json`. A kind is now
 * claimed only when a product marker says so, and anything else is
 * `unrecognized`.
 *
 * Both markers were read off the real binaries on 2026-09-22
 * (`evidence/wp7-red/probe-versions.txt`, `probe-help.txt`):
 *
 *   legacy  `--version` → `2.1.88-trylo (Claude Code)`
 *   legacy  `--help`    → `Usage: claude …` / `Claude Code - starts an interactive session…`
 *   v1      `--help`    → `trylo - learning agent CLI`
 *   v1      `--version` → `0.0.0`   ← NOT used to decide the kind
 */
const LEGACY_VERSION_MARKER = '(Claude Code)';
const LEGACY_HELP_MARKER = 'Claude Code';
const V1_HELP_MARKER = 'trylo - learning agent CLI';

/** Does this `--version` output identify the legacy runtime? */
export function classifyLegacyVersion(banner: string): string | null {
  const firstLine = banner.trim().split('\n')[0]?.trim() ?? '';
  if (!firstLine.includes(LEGACY_VERSION_MARKER)) return null;
  return firstLine.split(' ')[0] ?? firstLine;
}

/** Does this `--help` output identify either family? */
export function classifyHelpBanner(help: string): CliRuntimeKind | null {
  if (help.includes(V1_HELP_MARKER)) return 'trylo-v1';
  if (help.includes(LEGACY_HELP_MARKER)) return 'legacy';
  return null;
}

/**
 * Turn raw probe output into the probe's typed answer.
 *
 * Split out from the spawn so a caller that already has the bytes — the
 * live classification check against the real binaries, and any future
 * "probe from a cached banner" path — gets the identical verdict rather
 * than a second implementation that can disagree.
 *
 * `helpBanner` is consulted only when `--version` did not already settle
 * it, so the legacy path costs one spawn and the v1 path costs two.
 */
export function probeResultOfBanners(args: {
  readonly versionBanner: string;
  /** Only consulted when `--version` did not already settle the family. */
  readonly helpBanner?: string | null;
  /**
   * Exit code of the `--version` run — the only run guaranteed to have
   * happened by the time this is called. It is used solely to tell
   * "the process failed without saying anything" (`spawn_failed`) apart
   * from "it answered, and we do not recognise the answer"
   * (`unrecognized`); it never influences which kind is claimed.
   */
  readonly exitCode: number | null;
}): CliRuntimeProbeResult {
  const legacyVersion = classifyLegacyVersion(args.versionBanner);
  if (legacyVersion !== null) {
    return {
      ok: true,
      kind: 'legacy',
      version: legacyVersion,
      evidence: `--version → ${legacyVersion}`,
    };
  }
  const helpKind = classifyHelpBanner(args.helpBanner ?? '');
  if (helpKind === 'trylo-v1') {
    const version = args.versionBanner.trim() === '' ? 'unknown' : args.versionBanner.trim();
    return {
      ok: true,
      kind: 'trylo-v1',
      version,
      evidence: `--help → ${V1_HELP_MARKER}`,
      supportedFlags: [...new Set([...String(args.helpBanner).matchAll(/^\s{2,}(--[\w-]+)/gm)].map(match => match[1]!))],
    };
  }
  if (helpKind === 'legacy') {
    const version = args.versionBanner.trim() === '' ? 'unknown' : args.versionBanner.trim();
    return { ok: true, kind: 'legacy', version, evidence: `--help → ${LEGACY_HELP_MARKER}` };
  }
  const saw = [args.versionBanner, args.helpBanner ?? '']
    .map((t) => t.trim().slice(0, 80))
    .filter((t) => t !== '')
    .join(' | ');
  return {
    ok: false,
    code: args.exitCode !== 0 && saw === '' ? 'spawn_failed' : 'unrecognized',
    detail: `exit=${String(args.exitCode)} output=${saw === '' ? '<empty>' : saw}`,
  };
}

export interface ProbeCliRuntimeKindArgs {
  readonly entryScript: string;
  /** Selects the cheapest authoritative banner for a known protocol. It never
   * changes classification: an unexpected runtime still reports its real kind. */
  readonly preferredProbe?: 'help' | 'version';
  /** Pinned Node from the same resolution as the entry, when there is one. */
  readonly nodeProgram?: string;
  /**
   * Applies to EACH of the (at most two) read-only runs.
   *
   * Cost note for callers: this probe spawns the target every time it is
   * called, and the legacy bundle takes ~0.8-1.7 s cold just to print its
   * version. Whatever ends up calling this on a hot path (the settings
   * screen, or every turn once `requireProbe` is on) must MEMOISE the
   * result per entry — the answer cannot change while the process runs.
   * See `OPEN-WP7-12`.
   */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Output kept per run: enough for a banner, never a whole help page. */
const MAX_PROBE_OUTPUT_LINES = 200;

type ReadOnlyRun =
  | { readonly ok: true; readonly stdout: string; readonly exitCode: number | null }
  | { readonly ok: false; readonly code: CliProbeFailureCode; readonly detail: string };

/**
 * One bounded, read-only CLI invocation: spawn, close stdin immediately,
 * race the exit against a timer, and stop the tree on timeout so a wedged
 * CLI cannot hold the app. Never throws.
 */
async function runReadOnly(
  command: string,
  argv: readonly string[],
  label: string,
  timeoutMs: number,
): Promise<ReadOnlyRun> {
  let stdout = '';
  let lines = 0;
  let exitCode: number | null = null;
  const gate: { resolve: (() => void) | null } = { resolve: null };
  const done = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });

  let handle: { id: string } | null = null;
  try {
    handle = await hostAdapter.process.spawn({
      command,
      args: [...argv],
      label,
      onOutput: (line) => {
        if (lines >= MAX_PROBE_OUTPUT_LINES) return;
        lines += 1;
        stdout = stdout === '' ? line : `${stdout}\n${line}`;
      },
      onExit: (info) => {
        exitCode = info.code;
        gate.resolve?.();
      },
    });
    await hostAdapter.process.closeInput(handle.id).catch(() => undefined);
  } catch (error) {
    return {
      ok: false,
      code: 'spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([done, timer]);
  clearTimeout(timeoutId);
  if (exitCode === null) {
    await hostAdapter.process.stop(handle.id).catch(() => undefined);
    return { ok: false, code: 'timeout', detail: `no exit within ${timeoutMs}ms` };
  }
  return { ok: true, stdout, exitCode };
}

/**
 * The first of these paths that is not on disk, or null when they all are.
 *
 * Only paths are checked: a bare command name (`node`) resolves through
 * PATH, which a file stat cannot answer and must not pretend to.
 *
 * A stat rejection is treated as "missing" rather than propagated: the only
 * question asked here is whether it is worth spawning, and any answer other
 * than "yes, it is there" means it is not.
 */
async function firstMissingPath(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = candidate.trim();
    if (path === '' || !/[/\\]/.test(path)) continue;
    try {
      await hostAdapter.fs.statFile(path as never);
    } catch {
      return path;
    }
  }
  return null;
}

/**
 * Ask the entry what it is. Read-only, bounded, and never throws.
 *
 * `--version` first because it is the cheapest answer and settles the
 * legacy family on its own. Only when it does not do so is `--help`
 * consulted, which is the one place the new runtime states what it is.
 */
export async function probeCliRuntimeKind(
  args: ProbeCliRuntimeKindArgs,
): Promise<CliRuntimeProbeResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_KIND_PROBE_TIMEOUT_MS;
  if (args.signal?.aborted === true) {
    return { ok: false, code: 'timeout', detail: 'the caller aborted before the probe started' };
  }
  const entry = args.entryScript.trim();
  if (entry === '') {
    return { ok: false, code: 'not_found', detail: 'no entry path to probe' };
  }
  const node = (args.nodeProgram ?? '').trim();
  const isNodeEntry = /\.(m?js|cjs)$/i.test(entry);
  const command = isNodeEntry ? (node !== '' ? node : 'node') : entry;
  const prefix = isNodeEntry ? [entry] : [];

  // Existence first, so "there is no file there" stays a distinct answer.
  //
  // Without this the missing-binary case surfaces as `spawn_failed`: the host
  // rejects the spawn and all we get back is a STRING (`CommandError`
  // serialises as `Display`, and `std::io::Error`'s text comes from the OS,
  // so it is localised on Windows). Matching that string would be a language
  // dependency, so the check is a direct one instead. `not_found` is what the
  // caller's failure-code table maps to `entry_missing`, and until now
  // nothing on this path could produce it.
  const missing = await firstMissingPath([command, entry]);
  if (missing !== null) {
    return { ok: false, code: 'not_found', detail: `no file at ${missing}` };
  }

  const helpFirst = args.preferredProbe === 'help';
  const first = await runReadOnly(command, [...prefix, helpFirst ? '--help' : '--version'],
    'trylo-cli-kind-probe', timeoutMs);
  if (!first.ok) return first;
  const initial = probeResultOfBanners({
    versionBanner: helpFirst ? '' : first.stdout,
    ...(helpFirst ? { helpBanner: first.stdout } : {}), exitCode: first.exitCode,
  });
  if (initial.ok) return initial;
  const second = await runReadOnly(command, [...prefix, helpFirst ? '--version' : '--help'],
    'trylo-cli-kind-probe-fallback', timeoutMs);
  // A failed fallback is unknown-state, never a successful classification.
  if (!second.ok) return second;
  return probeResultOfBanners({
    versionBanner: helpFirst ? second.stdout : first.stdout,
    helpBanner: helpFirst ? first.stdout : second.stdout,
    exitCode: helpFirst ? second.exitCode : first.exitCode,
  });
}
