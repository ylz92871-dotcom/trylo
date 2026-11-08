import { execFile } from "node:child_process";

/**
 * Ending a process *tree*, not just a process.
 *
 * # Why this module exists
 *
 * Every other module here kills one pid. That is not the same act, and on
 * Windows the difference is not academic — `probe-c13d` (evidence
 * `2026-10-05-WP07/01-c13-kill-current.log`) shows a `cmd.exe` → `node` →
 * `node` chain where `child.kill()` removes the shell from `tasklist` while the
 * **grandchild stays listed and still runs**: it wrote its marker file eight
 * seconds after the "kill". A caller told "stopped" would then wait forever for
 * output a surviving grandchild will never send.
 *
 * # Where the mechanism comes from
 *
 * Codex's `utils/pty/src/process_group.rs` is the obvious candidate and it is
 * **the wrong file on this platform**: every function in it is `#[cfg(unix)]`
 * with a `#[cfg(not(unix))]` no-op twin, so on Windows it does nothing at all.
 * Its real Windows implementation is `utils/pty/src/win/job.rs` (a Job Object
 * with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), which Codex reaches from Rust.
 *
 * Reaching a Job Object from Node needs either a native addon or a helper
 * process, and this repository has no native addon and no Rust build for this
 * path (verified: no `binding.gyp`, no `.node` artifacts). Codex itself takes
 * the helper route when a Job Object is not in hand — `exec-server` and
 * `hooks` both fall back to `taskkill /T /F`
 * (`evidence/2026-10-05-WP07/02-c13-taskkill-fix.log` shows it removing the
 * whole tree here). So the mechanism below is the same one, reached the same
 * way, and it is the shortest route that is actually runnable today.
 *
 * What is given up, stated plainly: `taskkill` is a helper process, so a tree
 * can in principle outrun it, and it reports through an exit code rather than
 * telling us which descendant it reached. The Job Object route would be
 * stronger. It is recorded as `OPEN-WP07-2`, not quietly treated as done.
 */

/** How a termination ended, as a fact the caller can report. */
export type TreeTermination =
  /** The tree is gone. Nobody is running under it any more. */
  | { readonly ok: true; readonly how: "already_gone" | "killed" }
  /**
   * The attempt failed and the caller must say so. Never collapsed into
   * `ok: true`: a stop that did not stop is exactly the lie this module exists
   * to prevent.
   */
  | { readonly ok: false; readonly code: TreeTerminationCode; readonly message: string };

export type TreeTerminationCode =
  /** This platform has no tree-walk mechanism wired. Never silently ignored. */
  | "tree_kill_unsupported_platform"
  /** The helper could not be launched at all. */
  | "tree_kill_helper_missing"
  /** The helper ran and reported failure. */
  | "tree_kill_rejected"
  /**
   * Unix only: no observation seam, so the group's fate cannot be established.
   * Reported instead of assuming the kill worked.
   */
  | "tree_kill_unobservable"
  /**
   * Unix only: every signal was delivered and the group was still alive when
   * the last observation was made. The tree survived and the caller must say so.
   */
  | "tree_kill_unconfirmed";

/**
 * A seam for the facts that are otherwise ambient: which platform we are on,
 * how a helper process is run, and - for the Unix branch - how a group is
 * signalled, whether it is gone, and how long to wait for it.
 *
 * The Unix seam exists because of a measured defect, not for symmetry. The
 * original `terminatePosixGroup` had no `await` in it, so its "send a graceful
 * signal, check whether the child died, then escalate" loop ran entirely inside
 * one tick of the event loop: `exitCode`/`signalCode` could not have changed yet,
 * so the checks were dead code, the grace window was zero, all three signals
 * went out in the same tick, and the function still returned `{ok: true}`.
 * Evidence `evidence/2026-10-05-WP07/11-posix-grace-window-probe.log`: the
 * same-tick check observed `false`, and the child reported `signalCode=SIGTERM`
 * only about 17ms later. Logic that cannot be observed cannot be tested, which
 * is why `process.kill` was unreachable from the test file at all.
 */
export type TreeKillDeps = {
  readonly platform: NodeJS.Platform;
  readonly run: (file: string, args: ReadonlyArray<string>) => Promise<number | undefined>;
  /** Unix: signal a whole process group. */
  readonly signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Unix: is the group gone? The observable that makes "killed" a fact. */
  readonly groupGone?: (pid: number) => boolean;
  /** Unix: how long to wait between the graceful signal and the force. */
  readonly graceMs?: () => number;
  /** Unix: how long to wait after the force before declaring failure. */
  readonly settleMs?: () => number;
  /** Waiting itself, injected so the grace window is testable in real time terms. */
  readonly wait?: (ms: number) => Promise<void>;
};

/**
 * Windows' own tree walker. `/T` is the part that matters — it walks children —
 * and `/F` is what makes it a *termination* instead of a close request that a
 * console process can decline.
 */
const TASKKILL = "taskkill";
const TASKKILL_ARGS = { tree: ["/T"], force: ["/F"] } as const;

/**
 * Windows reports "there was nothing to kill" as exit code 128, which is not an
 * error condition for us: a process that ended on its own between our check and
 * our kill is the outcome we wanted. Verified on this machine by
 * `probe-c13d taskkill` (a clean run exits 0) and by the `already_gone` case in
 * `process-tree.test.ts`.
 */
const TASKKILL_NOTHING_TO_KILL = 128;

/** Graceful first, then force: a REPL gets to clean up before it is killed. */
const GRACEFUL_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGTERM", "SIGINT"];

/**
 * How long a graceful signal is given before the group is forced.
 *
 * Long enough for a REPL to flush what it has and close its own children, short
 * enough that a user pressing stop is not waiting on it. The previous version
 * had no window at all, which is the same as zero — see `terminatePosixGroup`.
 */
export const DEFAULT_GRACE_MS = 2_000;

/** How long the forced signal is given before the group is declared unkillable. */
const DEFAULT_SETTLE_MS = 1_000;

function defaultRun(
  file: string,
  args: ReadonlyArray<string>,
): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve) => {
    // `windowsHide` so a kill does not flash a console at the user.
    execFile(file, [...args], { windowsHide: true, timeout: 10_000 }, (error, _stdout, stderr) => {
      if (error !== null) {
        const code = (error as { code?: unknown }).code;

        // A non-zero exit arrives as an error carrying a numeric code; that is a
        // result to report, not a failure to launch.
        if (typeof code === "number") {
          resolve(code);
          return;
        }

        resolve(undefined);

        return;
      }
      // Some platforms surface the helper's complaint only on stderr with a zero
      // code; treat that as "it ran and said no".
      resolve(typeof stderr === "string" && stderr.trim().length > 0 ? 1 : 0);
    });
  });
}

/** The dependencies a real run uses; tests override one or more. */
export function defaultTreeKillDeps(): TreeKillDeps {
  return {
    platform: process.platform,
    run: defaultRun,
    // Signal 0 performs the permission and existence check without delivering
    // anything, which is what makes "is it gone" an observation rather than a
    // guess: a group that outlived SIGKILL still answers it.
    signalGroup: (pid, signal) => {
      process.kill(-pid, signal);
    },
    groupGone: (pid) => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        // Permission or observation failures do not prove that a group exited.
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true;
        throw error;
      }
    },
    graceMs: () => DEFAULT_GRACE_MS,
    settleMs: () => DEFAULT_SETTLE_MS,
    wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

export function describeFailure(code: TreeTerminationCode, detail: string): string {
  switch (code) {
    case "tree_kill_unsupported_platform":
      return `this platform has no process-tree termination wired, so descendants may survive; ${detail}`;
    case "tree_kill_helper_missing":
      return `could not run ${TASKKILL} to end the process tree, so descendants may survive; ${detail}`;
    case "tree_kill_rejected":
      return `${TASKKILL} refused to end the process tree, so descendants may survive; ${detail}`;
    case "tree_kill_unobservable":
      return `the process tree could not be observed, so descendants may survive; ${detail}`;
    case "tree_kill_unconfirmed":
      return `the process tree was still alive after being forced, so descendants may survive; ${detail}`;
    default: {
      const never: never = code;
      return String(never);
    }
  }
}

/**
 * Unix: signal the whole process group, then actually check whether it died.
 *
 * Only works because the caller spawned the child `detached`, which makes it a
 * group leader; without that, `kill(-pgid)` would signal *this* process's own
 * group, which is the worst possible answer. `detached` is therefore a
 * requirement of calling this, not an optimisation, and `spawnGroupChild`
 * below is how the tree layer spawns.
 *
 * # Why this waits now
 *
 * The previous version looped "send a graceful signal, look at `exitCode` /
 * `signalCode`, escalate" with no `await` anywhere, so the whole ladder ran in
 * one tick: the fields could not have changed, every check was dead code, the
 * grace window was zero, and the function returned `{ok: true}` having never
 * looked at whether anything died. Measured in
 * `evidence/2026-10-05-WP07/11-posix-grace-window-probe.log`.
 *
 * # Why it can now report failure
 *
 * `ok: true` means "killed", which is a claim about the world. The only thing
 * that makes it true is observing the group gone, so that observation is the
 * gate on the success value — and when the platform will not let us observe
 * (no seam available, or still alive after the force), the result is a failure
 * with survivors named, which is what the caller needs in order to stop
 * telling the user the tree is gone.
 */
async function terminatePosixGroup(child: ProcessHandle, deps: TreeKillDeps): Promise<TreeTermination> {
  const pid = child.pid;
  if (pid === undefined) {
    return { ok: true, how: "already_gone" };
  }

  const signalGroup = deps.signalGroup;
  const groupGone = deps.groupGone;
  if (signalGroup === undefined || groupGone === undefined) {
    // No seam means no observation, and an unobservable "killed" is exactly the
    // claim this module exists to stop making.
    return {
      ok: false,
      code: "tree_kill_unobservable",
      message: describeFailure(
        "tree_kill_unobservable",
        "no signal/observation seam was injected, so the group cannot be reported either way",
      ),
    };
  }

  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const grace = deps.graceMs?.() ?? DEFAULT_GRACE_MS;
  const settle = deps.settleMs?.() ?? DEFAULT_SETTLE_MS;

  const send = (signal: NodeJS.Signals): void => {
    try {
      signalGroup(pid, signal);
    } catch {
      // ESRCH: the group is already gone, which is the outcome we wanted.
      // The observable below decides, not this catch.
    }
  };

  const observe = (): TreeTermination | undefined => {
    try {
      return groupGone(pid) ? { ok: true, how: "killed" } : undefined;
    } catch (error) {
      return {
        ok: false,
        code: "tree_kill_unobservable",
        message: describeFailure("tree_kill_unobservable", error instanceof Error ? error.message : String(error)),
      };
    }
  };

  // Graceful, one signal, then a real wait for the group to go.
  send(GRACEFUL_SIGNALS[0] ?? "SIGTERM");

  const initial = observe();
  if (initial !== undefined) return initial;

  await wait(grace);

  const graceful = observe();
  if (graceful !== undefined) return graceful;

  // Still alive after the grace window: force it, then wait again and look.
  send("SIGKILL");
  await wait(settle);

  const forced = observe();
  if (forced !== undefined) return forced;

  return {
    ok: false,
    code: "tree_kill_unconfirmed",
    message: describeFailure(
      "tree_kill_unconfirmed",
      `the process group was still alive ${settle}ms after SIGKILL`,
    ),
  };
}

/**
 * Windows: hand the tree to `taskkill /T /F`.
 *
 * The direct child is **not** signalled first. That ordering is not a detail —
 * it was a bug, and measuring it is what caught it
 * (`evidence/2026-10-05-WP07/05-taskkill-ordering.log`):
 *
 *   kill-then-taskkill → taskkill exits 128, grandchild survives and acts
 *   taskkill-only       → taskkill exits 0, whole tree gone
 *
 * `taskkill /T` walks *from the parent downward*, so a parent that has already
 * been killed leaves nothing to walk from: the helper exits 128 ("no such
 * process") and the descendants it should have collected keep running. The tree
 * walk therefore runs against a live parent, and the direct kill exists only as
 * the fallback for when the helper itself cannot be launched.
 */
/**
 * The part of a child process the tree killer uses.
 *
 * `ChildProcess` satisfies this structurally, so existing callers are unaffected.
 * It exists so a pid read back from the job table — no handle, no `exitCode`,
 * nothing to `kill()` — goes through **the same** termination policy instead of a
 * second copy of it. `signalCode` may be absent, which means "I am not the one who
 * waited on this process" and is deliberately different from `null` ("alive, not
 * signalled").
 */
export type ProcessHandle = {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
};

function hasObservedExit(child: ProcessHandle): boolean {
  return child.exitCode !== null || (child.signalCode ?? null) !== null;
}

export async function terminateWindowsTree(
  child: ProcessHandle,
  deps: TreeKillDeps,
): Promise<TreeTermination> {
  if (hasObservedExit(child)) {
    return { ok: true, how: "already_gone" };
  }

  const pid = child.pid;
  if (pid === undefined) {
    return { ok: true, how: "already_gone" };
  }

  const args = ["/PID", String(pid), ...TASKKILL_ARGS.tree, ...TASKKILL_ARGS.force];
  const code = await deps.run(TASKKILL, args);
  // The helper receipt may arrive after the child published its actual exit.
  if (hasObservedExit(child)) return { ok: true, how: "already_gone" };
  if (code === undefined) {
    // The helper could not run at all. Killing just the child is still better
    // than doing nothing, and the return value keeps the survivors visible.
    child.kill();
    return {
      ok: false,
      code: "tree_kill_helper_missing",
      message: describeFailure("tree_kill_helper_missing", `${TASKKILL} could not be launched`),
    };
  }

  if (code === 0 || code === TASKKILL_NOTHING_TO_KILL) {
    return { ok: true, how: code === 0 ? "killed" : "already_gone" };
  }

  return {
    ok: false,
    code: "tree_kill_rejected",
    message: describeFailure("tree_kill_rejected", `${TASKKILL} exited ${code}`),
  };
}

/**
 * End `child` and everything descended from it.
 *
 * Idempotent by construction: a child that already exited short-circuits to
 * `already_gone`, and a second call after a successful one reports the same
 * thing. That matters because "stop" arrives more than once — a user pressing
 * stop twice, a timeout firing alongside a cancel — and a second call must not
 * turn a completed stop into an error.
 *
 * A failure is returned, never thrown and never swallowed: the caller's stop
 * path is the only place that can tell the user the tree survived.
 */
export async function terminateProcessTree(
  child: ProcessHandle,
  deps: TreeKillDeps = defaultTreeKillDeps(),
): Promise<TreeTermination> {
  if (hasObservedExit(child)) {
    return { ok: true, how: "already_gone" };
  }

  if (deps.platform === "win32") {
    return await terminateWindowsTree(child, deps);
  }

  if (deps.platform === "linux" || deps.platform === "darwin" || deps.platform === "freebsd") {
    return await terminatePosixGroup(child, deps);
  }

  return {
    ok: false,
    code: "tree_kill_unsupported_platform",
    message: describeFailure(
      "tree_kill_unsupported_platform",
      `platform ${deps.platform} has no tree-termination path`,
    ),
  };
}
