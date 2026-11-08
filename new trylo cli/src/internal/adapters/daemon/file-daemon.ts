import { spawn } from "node:child_process";
import { closeSync } from "node:fs";

import {
  clearDiscovery,
  logPath,
  openLog,
  readDiscovery,
  readHeartbeat,
  readLogTail,
  requestStop as leaveStopRequest,
  type DaemonHeartbeat,
} from "./record.js";
import { verifyIdentity, type DaemonIdentityProbe } from "../../domain/daemon-identity.js";
import {
  startRefusal,
  stopRefusal,
  type DaemonPort,
  type DaemonResult,
  type DaemonState,
} from "../../ports/daemon.js";

/**
 * Starting, finding and stopping the scheduler daemon (WP26 / A04).
 *
 * ## The spawn flags, and why they are the opposite of a command's
 *
 * A tool command is spawned **so it dies with the session** —
 * `adapters/tools/mutating/shell-spawn.ts` deliberately leaves `detached` off on
 * win32 and sets it on POSIX so the tree stays reachable for `terminateProcessTree`.
 * A daemon is the other requirement: it has to **outlive** the terminal that
 * started it, or a background schedule would end when the person closes the
 * window that created it.
 *
 * Measured on this host (`evidence/2026-10-07-WP26-review/detach-facts.out.txt`,
 * win32 / Node v22.22.2):
 *
 *  - `detached: true` + `windowsHide: true` + `stdio: "ignore"` ⇒ the child
 *    **survived** its spawning process's exit (`afterParentExit: true`).
 *  - The same spawn without `detached` ⇒ the child never even got far enough to
 *    announce itself, because the parent exited immediately.
 *
 * `windowsHide` matters on its own account: without it, win32's `detached` maps to
 * `CREATE_NEW_CONSOLE`, so a background daemon would open a console window. That
 * is a visible interruption of whatever the person is doing, and the whole point
 * of this process is that they never have to think about it.
 *
 * `stdio` is **not** `"ignore"`, and that is a recent correction. Ignoring the
 * streams is the right shape for "do not keep the terminal's pipes open" and the
 * wrong shape for "the child died before it advertised": the reason went nowhere,
 * so `start` could only ever report a pid for a process that had already failed —
 * which is exactly what happened when the launch target was wrong. stdout and
 * stderr now go to `daemon/daemon.log`, and a failed launch quotes the tail of it.
 * The daemon still must not hold the terminal open, so stdin stays ignored.
 *
 * ## `start` waits for the daemon to say it is here
 *
 * It used to answer "spawned" and leave the question of liveness to `status`, on
 * the reasoning that this process cannot observe the child's success. That
 * reasoning was wrong in a way a person pays for: `trylo daemon start` returned 0
 * while nothing was running. Every implementation surveyed resolves this — codex
 * opens the pid and checks it right after spawning (`pid_start.rs`), goose races
 * an exit flag against a readiness poll, opencode health-checks before trusting a
 * registration. So `start` waits until the child has written its discovery record
 * with **its own pid**, or until it dies, or until the bound runs out. No timer
 * is used to decide *whether* the daemon failed (that is the trap of "if it exits
 * within N ms it failed"); the bound only decides when to stop waiting, and the
 * exit event short-circuits it.
 *
 * ## Why `stop` asks rather than kills, by default
 *
 * A graceful stop lets the current tick settle before the process leaves. The
 * force path exists because a wedged daemon will not respond to anything, and a
 * person who cannot stop it has no way to start a new one. Both are explicit:
 * `force` is a separate flag, not a mode argument that could be passed by mistake.
 */
export type FileDaemonOptions = {
  readonly home: string;
  readonly clock: { readonly now: () => number };
  /** How to launch the daemon: the compiled entry plus its arguments. */
  readonly launch: { readonly file: string; readonly args: ReadonlyArray<string> };
  /** This process's platform token; win32 and POSIX take different spawn shapes. */
  readonly platform: string;
  /** Verifies a discovered identity against the live system. */
  readonly probe: DaemonIdentityProbe;
  /** Kills a process; separate so a test can observe the request. */
  readonly kill: (pid: number, options: { readonly force: boolean }) => Promise<void>;
  /** Asks a process to stop politely; resolves when it has been asked. */
  readonly requestStop?: (pid: number) => Promise<void>;
  /**
   * How many heartbeat intervals may pass before a daemon is reported unhealthy.
   * Two is deliberate: one missed heartbeat can be a busy tick, three can be a
   * machine that swapped.
   */
  readonly maxHeartbeatsBehind?: number;
  readonly tickIntervalMs?: number;
  /**
   * How long `start` waits for the spawned daemon to advertise itself, and how it
   * waits between looks.
   *
   * The bound is what keeps this from becoming a hang: a child that neither
   * advertises nor exits is a wedged machine, not a promise to wait on forever.
   * The wait is "look, then sleep" plus the child's own `exit`/`error` events —
   * deliberately not a "did it die within N ms" timer, which is the shape none of
   * the surveyed implementations uses and which turns a slow-but-healthy start
   * into a false failure. Tests inject both, so nothing about them depends on how
   * long the process took.
   */
  readonly ready?: {
    readonly attempts?: number;
    readonly intervalMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  };
};

const DEFAULT_MAX_BEHIND = 2;
// Measured on this host: a cold `node daemon-main.js` takes about 2s to write its
// discovery record, because it loads the whole compiled CLI first. The bound is
// therefore a ceiling on a *wedged* start, not a bet on how long a healthy one
// takes — a child that actually dies is reported the moment its `exit` event
// lands, which is why this can afford to be generous.
const DEFAULT_READY_ATTEMPTS = 100;
const DEFAULT_READY_INTERVAL_MS = 100;
/** How much of the daemon's log a failed launch quotes. Enough for a stack head. */
const LAUNCH_LOG_TAIL_BYTES = 2_000;

/**
 * The token a stop request must carry to be honoured by this daemon.
 *
 * Built from the identity pair rather than from the owner id, because the owner
 * is the *stopping* side's choice while the identity is what the *daemon* knows
 * about itself. A request addressed to one daemon therefore cannot be picked up
 * by another that happens to start later.
 */
function identityToken(state: DaemonState): string {
  if (state.status === "stopped") {
    return "stopped";
  }
  return `pid-${state.pid}-${"startedAtMs" in state ? state.startedAtMs : 0}`;
}

/** Whether a heartbeat is far enough behind to call the daemon unhealthy. */
function isStale(
  heartbeat: DaemonHeartbeat | undefined,
  nowMs: number,
  intervalMs: number,
  maxBehind: number,
): boolean {
  if (heartbeat === undefined || intervalMs <= 0) {
    // No heartbeat yet is normal before the first tick; it is not staleness.
    return false;
  }
  return nowMs - heartbeat.lastTickAtMs > intervalMs * (maxBehind + 1);
}

export function createFileDaemon(options: FileDaemonOptions): DaemonPort {
  const maxBehind = options.maxHeartbeatsBehind ?? DEFAULT_MAX_BEHIND;

  /**
   * Read the current state, from the discovery record **plus** a live check.
   *
   * The record alone is not a status: a daemon that crashed an hour ago left its
   * file behind, and reading that as `running` is how a supervisor convinces
   * itself everything is fine. So the identity pair is verified, and the three
   * answers are kept apart — an unanswerable system check is `unhealthy`, not
   * `stopped` and not `running`.
   *
   * Always a state, never `undefined`: "no discovery file" and "a discovery file
   * whose process is gone" are the same fact for a caller — nothing is running —
   * and collapsing them here means `status` can answer with one value instead of
   * forcing every caller to handle absence separately. The distinction that
   * matters (a stale *record* versus a live process) is preserved.
   */
  async function readState(): Promise<DaemonState> {
    const discovered = readDiscovery(options.home);
    if (discovered === undefined) {
      return { status: "stopped" };
    }

    const verdict = await verifyIdentity(discovered, options.probe);
    if (verdict.verdict === "unverifiable") {
      return { status: "unhealthy", pid: discovered.pid, reason: verdict.reason };
    }

    if (verdict.verdict === "gone") {
      // The record outlived its process. Reported as stopped rather than crashed:
      // nothing is known about work in flight from a discovery file alone, and
      // the durable occurrence record is where that fact lives.
      return { status: "stopped" };
    }

    const heartbeat = readHeartbeat(options.home);
    if (isStale(heartbeat, options.clock.now(), options.tickIntervalMs ?? 1_000, maxBehind)) {
      return {
        status: "unhealthy",
        pid: discovered.pid,
        reason:
          `the last heartbeat was at ${new Date(heartbeat?.lastTickAtMs ?? 0).toISOString()}, ` +
          `more than ${maxBehind} tick intervals ago`,
      };
    }

    return {
      status: "running",
      pid: discovered.pid,
      startedAtMs: discovered.startedAtMs,
      lastTickAtMs: heartbeat?.lastTickAtMs ?? options.clock.now(),
      firedCount: heartbeat?.firedCount ?? 0,
    };
  }

  /**
   * Why a start failed, with whatever the daemon managed to say.
   *
   * The log tail is the point: "spawned a pid that died" told a person nothing,
   * and the platform's complaint (a missing module, an unparseable bundle) is
   * exactly the sentence they need. This mirrors codex's
   * `append_stderr_log_tail_context` on a failed daemon launch.
   */
  function failedLaunch(log: string, detail: string): DaemonResult<{ pid: number }> {
    const tail = readLogTail(log, LAUNCH_LOG_TAIL_BYTES);
    return {
      ok: false,
      code: "spawn_failed",
      message:
        tail === undefined || tail.trim() === ""
          ? `${detail}; nothing had been written to ${log} when this was read`
          : `${detail}; its output ends with:\n${tail.trimEnd()}`,
    };
  }

  return {
    status: () => readState(),

    async start(): Promise<DaemonResult<{ pid: number }>> {
      const current = await readState();
      const permitted = startRefusal(current);
      if (!permitted.ok) {
        return permitted;
      }

      const log = logPath(options.home);
      let descriptor: number;

      try {
        descriptor = openLog(options.home);
      } catch (error: unknown) {
        // Being unable to record *why* a start failed is itself a reportable
        // failure, not a reason to spawn blind and hope.
        return {
          ok: false,
          code: "spawn_failed",
          message: `cannot open the daemon log ${log}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      try {
        const child = spawn(options.launch.file, [...options.launch.args], {
          // The flags that make a background process actually background — each
          // verified on this host, see the file comment. stdin is ignored so the
          // daemon never holds the terminal's pipes open; stdout/stderr go to the
          // log so a death on the way up leaves its reason behind.
          detached: true,
          windowsHide: true,
          stdio: ["ignore", descriptor, descriptor],
        });
        const pid = child.pid;
        if (pid === undefined) {
          return {
            ok: false,
            code: "spawn_failed",
            message: `could not spawn ${options.launch.file}; the platform gave no pid`,
          };
        }

        // `detached` is not the same thing as "the parent is free to leave":
        // libuv still holds the child handle until it exits, so a CLI that spawned
        // a daemon without this `unref` **never exited** — measured, `trylo daemon
        // start` hung until it was killed.
        child.unref();
        // What is *not* redundant is removing a stale record: a previous daemon's
        // file would otherwise answer for the seconds before the new one writes,
        // naming a pid that is not this one.
        clearDiscovery(options.home);
        let died: string | undefined;

        child.on("exit", (code, signal) => {
          died = signal !== null ? `killed by ${signal}` : `exited with code ${code}`;
        });
        child.on("error", (error) => {
          died = error.message;
        });
        const attempts = options.ready?.attempts ?? DEFAULT_READY_ATTEMPTS;
        const intervalMs = options.ready?.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
        const sleep =
          options.ready?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        let lastStatus = "stopped";

        for (let attempt = 0; attempt < attempts; attempt += 1) {
          // The child's own event wins over the poll: a process that says it is
          // gone has already answered, and waiting longer adds nothing.
          if (died !== undefined) {
            return failedLaunch(log, `the daemon died during launch (${died})`);
          }

          const state = await readState();

          lastStatus = state.status;

          if (state.status === "running" && state.pid === pid) {
            return { ok: true, value: { pid } };
          }

          await sleep(intervalMs);
        }

        return failedLaunch(
          log,
          `the daemon did not advertise itself as pid ${pid} within ${attempts} looks (last status: ${lastStatus})`,
        );
      } finally {
        // The child duplicated the descriptor at spawn; this process must not keep
        // it open, or the log stays locked on win32 after the CLI leaves.
        closeSync(descriptor);
      }
    },

    async stop(stopOptions): Promise<DaemonResult<"stopped">> {
      const current = await readState();
      const permitted = stopRefusal(current);
      if (!permitted.ok) {
        return permitted;
      }

      // `stopRefusal` admits only the states that carry a pid, so the narrowing
      // here is the type system confirming the same thing. `stopped` is
      // impossible here and would mean the refusal above let it through.
      if (current.status === "stopped") {
        return { ok: false, code: "not_running", message: "the daemon is already stopped" };
      }

      const pid = current.pid;

      // `force` is absent by default, and absent means *polite*. Written as
      // `!== true` rather than `=== false` because the previous form made an
      // omitted flag mean "force": `stop({})` — the shape a caller writes when it
      // simply wants a daemon stopped — killed the process instead of asking it.
      // The default has to be the gentle one, because the forceful one is the one
      // that can interrupt work.
      if (stopOptions.force !== true && options.requestStop !== undefined) {
        try {
          // The request goes out two ways, because either one alone is unreliable
          // on this platform. A signal reaches a console process and nothing else;
          // a file reaches a detached one. Measured: the detached win32 daemon
          // ignored `SIGTERM` entirely and kept running (see `record.ts`), so the
          // file is the channel that actually works and the signal is a courtesy
          // for a daemon someone attached a terminal to.
          //
          // The token is the identity pair, so the request can only be honoured by
          // the daemon it was addressed to and not by one that starts later.
          await options.requestStop(pid);
          leaveStopRequest(options.home, `trylo daemon stop: asked pid ${pid} to finish its tick`, identityToken(current));
          // The record is withdrawn anyway. Leaving it behind would make the next
          // `status` answer about a process that is on its way out, and if the
          // request is honoured that answer becomes a phantom within seconds. A
          // record with no process behind it is exactly what `status` reports as
          // `stopped`, so withdrawing it here is the same fact stated earlier.
          clearDiscovery(options.home);

          return { ok: true, value: "stopped" };
        } catch (error: unknown) {
          // One `catch`, one outcome: the polite path failed, so fall through to
          // the forceful one. A person who asked to stop did not ask to be told
          // the request was delivered.
          void error;
        }
      }

      await options.kill(pid, { force: stopOptions.force === true });
      clearDiscovery(options.home);

      return { ok: true, value: "stopped" };
    },

    async clear(): Promise<DaemonResult<true>> {
      // Only ever called after the caller has established that no verified daemon
      // is running — it removes the *record*, not a process.
      clearDiscovery(options.home);
      return { ok: true, value: true };
    },
  };
}
