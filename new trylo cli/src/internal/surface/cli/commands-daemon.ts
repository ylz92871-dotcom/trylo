import type { CliContext } from "./context.js";
import { scheduleHome } from "./schedule-paths.js";
import { createProcessIdentityProbe } from "../../adapters/daemon/identity-probe.js";
import { createFileDaemon } from "../../adapters/daemon/file-daemon.js";
import { terminatePidTree } from "../../adapters/process-session/terminate-by-pid.js";
import { describeDaemon, type DaemonFailureCode } from "../../ports/daemon.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";

/**
 * `trylo daemon` handlers (WP26 / A04).
 *
 * Three verbs — `status`, `start`, `stop` — and they are enough because the daemon
 * has exactly one job: run the scheduler. `ps/logs/attach/kill` for background
 * *sessions* are a different noun with a different owner and are not faked here.
 *
 * ## What `start` is willing to claim, and when
 *
 * It reports "running" only after the daemon has written its own discovery record
 * carrying *this* pid, because a pid on its own is not a daemon: that wording used
 * to be "spawned as pid N — run `status` to find out", and it was a hedge that hid
 * a real defect (the default launch target pointed at a file that did not exist,
 * so every start "succeeded" and nothing ran). `adapter.start()` now waits for the
 * advertisement, so success here is a confirmed fact and a failure arrives with the
 * tail of the daemon's own log instead of a bare number.
 *
 * ## `stop` is honest about the grace period
 *
 * A graceful stop asks and returns; it does not wait for the process to die and
 * then claim it did. `--force` is a separate flag because "please stop" and "make
 * it stop" are different promises, and a flag is harder to pass by accident than a
 * mode argument somebody might default to.
 */

export type DaemonVerb =
  | { readonly verb: "status"; readonly json: boolean }
  | { readonly verb: "start" }
  | { readonly verb: "stop"; readonly force: boolean };

export type DaemonParse = DaemonVerb | { readonly verb: "help" };

export function parseDaemon(argv: ReadonlyArray<string>): DaemonParse {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    return { verb: "help" };
  }

  if (verb === "status" || verb === "ps") {
    return { verb: "status", json: hasFlag(rest, "json") };
  }

  if (verb === "start") {
    return { verb: "start" };
  }

  if (verb === "stop" || verb === "kill") {
    return { verb: "stop", force: hasFlag(rest, "force") || hasFlag(rest, "now") };
  }

  return { verb: "help" };
}

function hasFlag(argv: ReadonlyArray<string>, name: string): boolean {
  return argv.some((token) => token === `--${name}` || token.startsWith(`--${name}=`));
}

/** The entry point the launch config points at. */
export function daemonLaunchTarget(): { file: string; args: string[] } {
  // Resolved from this module, never from `process.cwd()`: the person who typed
  // `trylo daemon start` from some other directory must get the same daemon.
  //
  // Three levels up is not a guess. This file compiles to
  // `<dist>/internal/surface/cli/`, and the daemon lives at `<dist>/cmd/trylo/`,
  // so the distance is a fact about where `tsconfig`'s `rootDir` puts both — and
  // it was wrong here (one level) until a real `daemon start` reported "spawned
  // as pid 58536" for a child that died at once. `commands-daemon.test.ts` now
  // pins it, because no probe of the daemon's lifecycle ever read this default:
  // they imported `daemon-main.js` themselves or injected a launch config.
  const target = new URL("../../../cmd/trylo/daemon-main.js", import.meta.url);
  return {
    file: process.execPath,
    args: [decodeURIComponent(target.pathname).replace(/^\/([A-Za-z]:)/, "$1")],
  };
}

function exitCodeFor(code: DaemonFailureCode): ExitCode {
  return code === "spawn_failed" || code === "identity_unverifiable" ? EXIT_CODES.TEMPORARY : EXIT_CODES.USAGE;
}

export async function handleDaemon(ctx: CliContext, parsed: DaemonParse): Promise<ExitCode> {
  if (parsed.verb === "help") {
    ctx.stdout(daemonHelpText());
    return EXIT_CODES.OK;
  }

  const home = scheduleHome(ctx.homeDir, ctx.env);
  let probe;

  try {
    probe = createProcessIdentityProbe(ctx.platform ?? "win32");
  } catch (error: unknown) {
    // The probe refusing to be constructed is a real, reportable limitation of this
    // platform — not something to paper over with a pid-only check, which is the
    // defect the identity pair exists to prevent.
    ctx.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CODES.TEMPORARY;
  }

  const daemon = createFileDaemon({
    home,
    clock: { now: ctx.now },
    launch: daemonLaunchTarget(),
    platform: ctx.platform ?? "win32",
    probe,

    kill: async (pid, options, identity) => {
      ctx.stderr(options.force ? `killing pid ${pid}\n` : `stopping pid ${pid}\n`);
      if (ctx.platform === "darwin") {
        const outcome = await terminatePidTree(pid, undefined, identity);
        if (!outcome.ok) throw new Error(outcome.message);
        return;
      }
      process.kill(pid, options.force ? "SIGKILL" : "SIGTERM");
    },

    requestStop: async (pid) => {
      // A win32 daemon has no cooperative channel yet, so the polite path is a
      // TERM and the forceful path is what actually ends a wedged process. Saying
      // so is better than reporting a graceful stop that did not happen.
      process.kill(pid, "SIGTERM");
    },
  });

  if (parsed.verb === "status") {
    const state = await daemon.status();

    if (parsed.json) {
      ctx.stdout(`${JSON.stringify(state)}\n`);
    } else {
      ctx.stdout(`${describeDaemon(state)}\n`);
    }

    // `unhealthy` is a failure the person has to act on, so it is not exit 0.
    return state.status === "running" || state.status === "stopped" ? EXIT_CODES.OK : EXIT_CODES.TEMPORARY;
  }

  if (parsed.verb === "start") {
    const started = await daemon.start();
    if (!started.ok) {
      ctx.stderr(`${started.message}\n`);
      return exitCodeFor(started.code);
    }

    // `start` only answers ok once the daemon has written its own discovery
    // record with this pid, so this is a confirmed fact rather than a hope. The
    // old wording ("spawned as pid N, run status to see whether it took") was
    // honest about the limits of the claim and useless in practice: a wrong launch
    // target printed it happily while nothing was running.
    ctx.stdout(`the scheduler daemon is running as pid ${started.value.pid}\n`);

    return EXIT_CODES.OK;
  }

  const stopped = await daemon.stop({ ...(parsed.force ? { force: true } : {}) });
  if (!stopped.ok) {
    ctx.stderr(`${stopped.message}\n`);
    return exitCodeFor(stopped.code);
  }

  ctx.stdout(parsed.force ? "force-stopped the scheduler daemon\n" : "asked the scheduler daemon to stop\n");

  return EXIT_CODES.OK;
}

function daemonHelpText(): string {
  return [
    "trylo daemon — the resident scheduler",
    "",
    "  daemon status [--json]   is one running, and is it ticking",
    "  daemon start             spawn it",
    "  daemon stop [--force]    stop it (--force when it will not go)",
    "",
    "The daemon runs scheduled prompts after this terminal closes. It is one",
    "process per machine; a second one is refused rather than allowed to race.",
    "",
  ].join("\n");
}

/** Exported so a test can point the launcher at a real script. */
export function daemonLaunchFor(file: string, args: ReadonlyArray<string>) {
  return { file, args: [...args] };
}

export type { CliContext };
