/**
 * The daemon process entry's one ambient surface (WP26 / A04).
 *
 * ## Why this file is a seam rather than a whitelist entry
 *
 * The repository's static scan rejects `process.env` / `process.exit` outside an
 * allowlist, and — unlike `Date.now` — offers no `??` injection exemption for
 * them. That is the rule working as intended: a process entry point's ambient
 * reads are exactly the thing that should be *visible*, not sprinkled through a
 * file. So they are gathered here, once, with each read named, and everything
 * below this file receives them as arguments.
 *
 * Adding this path to `AMBIENT_FILE_ALLOWLIST` would have silenced the check
 * without reducing the number of places that read the environment; this does the
 * opposite. The allowlist is for files that legitimately read the environment as
 * part of their job and cannot be given an alternative — a whole-file exemption,
 * not a per-read one.
 *
 * ## What is read, and why each one is here
 *
 *  - `HOME` (via `homedir()` as the fallback) — the account's home, from which
 *    `tryloHome` derives everything else. Read through the same formula as every
 *    other surface; a second derivation would be right until `TRYLO_HOME` is set.
 *  - `TRYLO_HOME` and the rest of the environment — passed as a table so
 *    `tryloHome` and `sessionQueuePath` see exactly what this process sees.
 *  - `pid` and the process start time — the daemon's identity pair. `Date.now()`
 *    rather than an OS query, because the process is recording *its own* start and
 *    already knows it; the query exists for verifying *someone else's*.
 *  - signal handlers — the only way to be asked to stop.
 *  - the exit code — the only way to report an outcome.
 */

export type ProcessAmbient = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly home: string;
  readonly pid: number;
  readonly startedAtMs: number;
  /** Installs handlers for the given signals; returns a function that removes them. */
  readonly onSignal: (signals: ReadonlyArray<NodeJS.Signals>, handler: () => void) => () => void;
  /** Reports the process's outcome. */
  readonly setExitCode: (code: number) => void;
};

/**
 * Read the process's ambient facts.
 *
 * A parameter rather than a hidden read, so a test can hand a daemon entry point
 * a home directory and a clock and watch what it does — and so the reads above are
 * the complete list, visible in one place.
 */
export function readProcessAmbient(ambient: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly now: () => number;
  readonly startedAtMs?: number;
  readonly pid: number;
  readonly installSignals: (signals: ReadonlyArray<NodeJS.Signals>, handler: () => void) => () => void;
  readonly report: (code: number) => void;
  /** Builds the home directory from the formula every surface uses. */
  readonly tryloHome: (homeDir: string, env: Readonly<Record<string, string | undefined>>) => string;
}): ProcessAmbient {
  const home = ambient.tryloHome(ambient.homeDir, ambient.env);
  return {
    env: ambient.env,
    homeDir: ambient.homeDir,
    home,
    pid: ambient.pid,
    startedAtMs: ambient.startedAtMs ?? ambient.now(),
    onSignal: (signals, handler) => ambient.installSignals(signals, handler),
    setExitCode: (code) => ambient.report(code),
  };
}
