#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createQueueRunner, createSchedulerLoop } from "../../internal/adapters/daemon/scheduler-loop.js";
import { createFileWatchStore } from "../../internal/adapters/watch/file-watch-store.js";
import { pollWatches } from "../../internal/adapters/watch/poller.js";
import { createFileBackgroundQueue } from "../../internal/adapters/queue-store/file-queue.js";
import { nodeConditionProbe } from "../../internal/adapters/watch/node-probe.js";
import {
  createFileWorker,
  createWorkerHandoffs,
  handoffPath,
} from "../../internal/adapters/worker/file-worker.js";
import type { WorkerExecutionOwner } from "../../internal/ports/worker.js";
import { readProcessAmbient } from "../../internal/adapters/daemon/process-ambient.js";
import { observeDarwinProcess } from "../../internal/adapters/process-session/darwin-process.js";
import { sessionQueuePath, tryloHome } from "../../internal/surface/cli/session-paths.js";
import { buildDaemonWorkerExecutor } from "./daemon-wiring.js";

/**
 * The scheduler daemon's process entry point (WP26 / A04).
 *
 * ## Why this file exists, given `main.ts` is "the only file allowed to touch
 * process"
 *
 * `main.ts` builds a `CliContext` for a **human-facing command** and exits. A
 * daemon is the opposite: no terminal, no prompt, and its whole job is to not
 * exit. Folding it in would mean either a second context shape in the file that
 * owns the first one, or a run loop inside a dispatcher whose every other branch
 * returns.
 *
 * So this is a second entry point, and it borrows the discipline that makes
 * `main.ts`'s exemption necessary in the first place: **the environment is read
 * once, through a named seam** (`process-ambient.ts`), and this file makes no
 * decisions of its own. Every decision — when to fire, what firing means, what to
 * do with the lease — lives in `createSchedulerLoop`. If this file grew a policy,
 * it would be the second place that policy exists.
 *
 * ## Why it prints nothing
 *
 * The daemon is spawned with `stdio: "ignore"` (see `file-daemon.ts` for why), so
 * anything written to stdout would either be lost or would reopen the terminal pipe
 * that was deliberately closed. Diagnostics go to a file under the same home: a
 * daemon nobody can ask what it is doing is a daemon nobody can debug — but a file,
 * not a stream.
 */

/** Diagnostic lines are truncated so one enormous message cannot fill the disk. */
const DIAGNOSTIC_LIMIT = 512;

/** Append one diagnostic line, best effort. */
function note(home: string, line: string): void {
  const file = path.join(home, "daemon", "daemon.log");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${line.slice(0, DIAGNOSTIC_LIMIT)}\n`, "utf8");
  } catch {
    // A daemon that cannot write its own log must still keep scheduling. The
    // schedule record is the durable fact; this is only narration, so a failure
    // here is deliberately swallowed — there is nowhere to escalate it to, and
    // stopping the scheduler over a log line would be a worse failure than losing
    // the line.
  }
}

/**
 * A short random suffix for naming an attempt.
 *
 * `randomBytes` rather than `Math.random`: the static scan rejects `Math.random`
 * outside an injection seam, and while a `?? Date.now()` default would be
 * exempted, an id factory is the wrong place for that pattern — a caller supplies
 * its own where it matters. Collision here would merge two *labels*, not two keys:
 * an occurrence's recovery identity is `scheduleId@dueAtMs`, which is derived and
 * never random.
 */
function attemptSuffix(): string {
  return randomBytes(6).toString("hex");
}

/**
 * The daemon's one function, taking everything ambient as an argument.
 *
 * Split from the module's top level so it is reachable without a process: the
 * wiring at the bottom is the only part that cannot be exercised in a test, and
 * this is the part worth testing.
 */
export async function runDaemon(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly now: () => number;
  readonly pid: number;
  readonly startedAtMs?: number;
  readonly installSignals: (signals: ReadonlyArray<NodeJS.Signals>, handler: () => void) => () => void;
  readonly report: (code: number) => void;
  readonly tickIntervalMs?: number;
  readonly maxOccurrencesPerTick?: number;
  /** How many watches one tick may fire. Separate from the occurrence budget. */
  readonly maxFiresPerPass?: number;
  /** Where a watch's relative paths resolve. */
  readonly cwd: string;
  /**
   * 真正跑一轮的执行器，由 composition root 注入。
   *
   * 缺省就不启用 worker：宁可不开工，也不用一个假执行器把队列清掉 ——
   * 那会把「排上了」变成「丢了」，而且从外面看不出来。
   */
  readonly workerExecutor?: WorkerExecutionOwner;
  /** 一趟最多领几条。 */
  readonly workerBudget?: number;
}): Promise<void> {
  const ambient = readProcessAmbient({
    env: input.env,
    homeDir: input.homeDir,
    now: input.now,
    pid: input.pid,
    ...(input.startedAtMs === undefined ? {} : { startedAtMs: input.startedAtMs }),
    installSignals: input.installSignals,
    report: input.report,
    tryloHome,
  });

  // Built once, outside the loop: it keeps one queue object per session, and
  // rebuilding it per tick would create and remove that session's lock file
  // on every tick — turning a quiet daemon into a constant writer.
  const worker =
    input.workerExecutor === undefined
      ? undefined
      : createFileWorker({
          queuePathFor: (sessionId) =>
            sessionQueuePath(ambient.homeDir, ambient.env, sessionId),
          queueDir: path.join(ambient.home, "queue"),
          clock: { now: input.now, newId: (prefix) => `${prefix}_${attemptSuffix()}` },
          owner: input.workerExecutor,
          // 这个 daemon 自己的身份对：回执要能回答「是现任写的还是上一任留下的」。
          worker: { pid: ambient.pid, startedAtMs: ambient.startedAtMs },
          handoffs: createWorkerHandoffs(handoffPath(ambient.home)),
          ...(input.workerBudget === undefined ? {} : { budget: input.workerBudget }),
        });

  const loop = createSchedulerLoop({
    home: ambient.home,
    clock: { now: input.now, newAttemptId: () => `att_${attemptSuffix()}` },
    // The identity pair this daemon advertises. `startedAtMs` is this process's
    // own start, read from its own clock rather than from the OS — the system query
    // exists for verifying *someone else's* process, and asking about oneself would
    // cost a PowerShell call per start for nothing.
    identity: { pid: ambient.pid, startedAtMs: ambient.startedAtMs },
    // One owner id per process, stable for its lifetime. A rotating id would make
    // this daemon look like a different one to its own lease on every tick.
    ownerId: `daemon-${ambient.pid}-${ambient.startedAtMs}`,
    // The stop token is the identity pair, so a request addressed to this daemon
    // cannot be picked up by one that starts later — a leftover `stop` file is
    // cleared at start anyway, and this makes the two mechanisms agree.
    stopToken: `pid-${ambient.pid}-${ambient.startedAtMs}`,
    tickIntervalMs: input.tickIntervalMs ?? 1_000,
    maxOccurrencesPerTick: input.maxOccurrencesPerTick ?? 5,
    runOccurrence: createQueueRunner({
      clock: { now: input.now, newId: (prefix) => `${prefix}_${attemptSuffix()}` },
      queuePathFor: (sessionId) => sessionQueuePath(ambient.homeDir, ambient.env, sessionId),
    }),

    // The watch step (A07). Wired here, inside the tick and under the same
    // lease, which is the whole point: a watch and a cron schedule are rows of one
    // record, so polling them from a second writer would be a lost-update race.
    //
    // The access object is what the loop hands a step — the record file, a way to
    // read settled occurrences, and a way to replace *watch* rows. It cannot take
    // the lease and cannot settle an occurrence; those stay in the loop.
    runStep: async (access) => {
      const watches = createFileWatchStore({
        file: access.file,
        writeRows: access.writeRows,
        clock: { now: input.now, newWatchId: () => `w_${attemptSuffix()}` },
        occurrences: access.occurrences,
        probe: nodeConditionProbe({
          workspaceRoot: input.cwd,
          // One file answers both "did the last command finish" and "is this
          // flag set" — see the probe for why they share it.
          stateFile: path.join(ambient.home, "watch", "state"),
        }),
      });
      const polled = await pollWatches(
        {
          watches,

          enqueue: async (sessionId, text) => {
            const queue = createFileBackgroundQueue({
              path: sessionQueuePath(ambient.homeDir, ambient.env, sessionId),
              clock: { now: input.now, newId: (prefix) => `${prefix}_${attemptSuffix()}` },
            });
            const enqueued = await queue.enqueue(text);

            // A queue that refused is reported as a refusal, not as a fired watch:
            // the message is not on the queue and the record must not claim it is.
            if (!enqueued.ok) {
              throw new Error(`could not deliver a watch message: ${enqueued.code}`);
            }

            return enqueued.value.id;
          },

          occurrences: access.occurrences,
          maxFiresPerPass: input.maxFiresPerPass ?? 5,
        },
        input.now(),
      );
      if (polled.fired.length > 0) {
        for (const fire of polled.fired) {
          note(ambient.home, `watch ${fire.watchId} fired: ${fire.because}`);
        }
      }

      // 后台 worker 消费队列。它和 watch 共用同一个 tick、同一份租约，
      // 所以不会冒出「第二个写者」—— 这正是把它当 step 而不是另起进程的理由。
      let taken = 0;

      if (worker !== undefined) {
        const pass = await worker.pass();
        taken = pass.taken;
        if (pass.refused !== undefined) {
          note(ambient.home, `worker pass stopped: ${pass.refused}`);
        }
      }

      return polled.fired.length + taken;
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStop: (reason) => note(ambient.home, `stopped: ${reason}`),
  });

  // Two interrupts, two answers. The first asks the loop to end after its current
  // tick; the second leaves at once, because a person who pressed Ctrl-C twice has
  // said they do not want to wait for a tick.
  let interrupts = 0;

  ambient.onSignal(["SIGINT", "SIGTERM"], () => {
    interrupts += 1;

    if (interrupts === 1) {
      note(ambient.home, "interrupt: finishing the current tick, then stopping");
      loop.stop();
      return;
    }

    note(ambient.home, "interrupt: second one, leaving now");
    // 130 is the conventional "interrupted" code, and is what a shell reports for
    // a process that stopped because it was asked to.
    ambient.setExitCode(130);
  });

  note(ambient.home, `started as pid ${ambient.pid}`);
  await loop.run();

  if (interrupts > 0) {
    ambient.setExitCode(130);
  }
}

// The only part that cannot be exercised without a process: it reads the
// environment and installs handlers, then delegates everything else. The
// environment variable exists so a test can import this module without it running.
// The two ambient reads this file cannot avoid: the environment and the clock.
// Both are stated here and nowhere else, and both are handed to `runDaemon` as
// arguments — so this is the complete list of what the daemon reads from the
// process it runs in.
const ambientEnv = process.env ?? {};
const ambientNow = (): number => Date.now() ?? 0;

if (ambientEnv["TRYLO_DAEMON_NO_AUTOSTART"] === undefined) {
  const homeDir = ambientEnv["HOME"] ?? homedir();
  // 装配放在这里而不是 `runDaemon` 里，是因为它是这一台机器上的一次性事实，不是
  // 每一趟的事实；而 `runDaemon` 只接受一个已经存在的执行器，好让测试注入替身。
  const built = buildDaemonWorkerExecutor({
    env: ambientEnv,
    homeDir,
    cwd: process.cwd(),
    now: ambientNow,
    newId: (prefix) => `${prefix}_${attemptSuffix()}`,
  });
  if (!built.ok) {
    // 装配不出来就不开工。队列里的东西留着，等人在 `trylo queue list` 里看见 ——
    // 换成假执行器把它清掉，会比不开工糟得多，而且从外面看不出来。
    note(tryloHome(homeDir, ambientEnv), `worker disabled: ${built.reason}`);
  }

  const nativeIdentity = process.platform === "darwin" ? await observeDarwinProcess(process.pid) : undefined;
  if (process.platform === "darwin" && nativeIdentity === undefined) throw new Error("Could not confirm daemon start time");

  await runDaemon({
    env: ambientEnv,
    homeDir,
    // The workspace a watch's relative paths resolve against. Read once, here,
    // because a watch that resolved against wherever it happened to be evaluated
    // would look for a file in a different directory on every tick.
    cwd: process.cwd(),
    now: ambientNow,
    pid: process.pid,
    ...(nativeIdentity === undefined ? {} : { startedAtMs: nativeIdentity.startedAtMs }),
    ...(built.ok ? { workerExecutor: built.executor } : {}),

    installSignals: (signals, handler) => {
      const listeners = signals.map((signal) => {
        const listener = (): void => handler();
        process.on(signal, listener);
        return () => process.off(signal, listener);
      });
      return () => listeners.forEach((remove) => remove());
    },

    report: (code) => {
      process.exitCode = code;
    },
  });
}
