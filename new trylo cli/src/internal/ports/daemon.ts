/**
 * The scheduler daemon's lifecycle contract (WP26 / A04 + the A06 host).
 *
 * ## Why a daemon and not a `setInterval` in the foreground process
 *
 * ADR §5: "CLI 关闭后继续调度的具体宿主是受管 daemon，不是前台进程内一个
 * setInterval." The reason is not tidiness. A `setInterval` dies with the
 * terminal that ran it, so `trylo run` would end the schedule it was created to
 * keep — and the person would find out by a job that silently stopped. The
 * daemon is the thing that has to outlive the session for a *background*
 * schedule to mean anything.
 *
 * ## The states, and the two refusals that matter
 *
 * ```text
 * stopped ──start──> running ──stop──> stopped
 *    ▲                │
 *    │                ├──crash──> crashed ──restart──> running
 *    └────unhealthy───┘
 * ```
 *
 * `running` is the only state that claims work is being done. `crashed` is
 * **not** `stopped`: a daemon that died with work in flight has an unsettled
 * occurrence, and restarting it is a different operation from starting it fresh.
 * That distinction is the reason this is a union rather than a boolean — a
 * supervisor that answers "is it up?" with `crashed → false` would happily start
 * a second daemon over the first one's lease.
 *
 * `unhealthy` is a third refusal, and it is here because the win32 identity check
 * can come back `unverifiable`. A daemon whose identity cannot be confirmed must
 * not be reported as running, and must not be reported as gone either — the third
 * answer is what stops a supervisor from spawning replacements at a daemon it
 * merely failed to ask about.
 */
export const DAEMON_STATUSES = ["stopped", "running", "crashed", "unhealthy"] as const;

export type DaemonStatus = (typeof DAEMON_STATUSES)[number];

export type DaemonState =
  | { readonly status: "stopped" }
  | {
      readonly status: "running";
      readonly pid: number;
      readonly startedAtMs: number;
      /** Epoch ms of the last tick, so "running" is not just "exists". */
      readonly lastTickAtMs: number;
      /** Occurrences fired since start. A number a person can watch climb. */
      readonly firedCount: number;
    }
  | {
      readonly status: "crashed";
      readonly pid: number;
      readonly startedAtMs: number;
      /** Why it is believed to have crashed, in plain words. */
      readonly reason: string;
      /** Occurrences left unsettled — the reason `crashed` exists. */
      readonly unsettled: number;
    }
  | {
      readonly status: "unhealthy";
      readonly pid: number;
      readonly reason: string;
    };

/**
 * Why a lifecycle operation was refused.
 *
 * Every code is something the person can act on. `already_running` is the one that
 * must never be treated as "fine": starting a second daemon over a live one is how
 * two schedulers race for the same lease, and the lease is the only thing standing
 * between them.
 */
export type DaemonFailureCode =
  | "already_running"
  | "not_running"
  | "identity_unverifiable"
  | "spawn_failed"
  | "discovery_unreadable";

export type DaemonRefusal = { readonly ok: false; readonly code: DaemonFailureCode; readonly message: string };

export type DaemonResult<T> = { readonly ok: true; readonly value: T } | DaemonRefusal;

/**
 * What a caller may ask about a daemon.
 *
 * `status` answers from the *discovery file plus a live identity check*, never
 * from "the file exists". A discovery file left by a daemon that crashed an hour
 * ago still exists, and reading it as a status is how a supervisor convinces
 * itself everything is fine.
 */
export type DaemonPort = {
  /**
   * The current state.
   *
   * Returns a state rather than a result, because asking "is the daemon running"
   * cannot fail in the way the mutating verbs can: every answer is one of the
   * four states, and a refusal here would raise the question "refused to answer,
   * so is it running?" — which is strictly less useful than "unhealthy, and here
   * is why". The identity check's failure mode is already a state.
   */
  readonly status: () => Promise<DaemonState>;
  /** Spawn the daemon if one is not already verified running. */
  readonly start: () => Promise<DaemonResult<{ readonly pid: number }>>;
  /**
   * Ask it to stop, and wait for it to be gone.
   *
   * `force` skips the graceful path. It is a separate flag rather than a boolean
   * argument stacked onto one method, because "please stop" and "make it stop"
   * are different promises: the first lets work settle, the second does not.
   */
  readonly stop: (options: { readonly force?: boolean }) => Promise<DaemonResult<"stopped">>;
  /** Discard a crashed daemon's record so a fresh one may start. */
  readonly clear: () => Promise<DaemonResult<true>>;
};

/**
 * Whether starting is allowed given what is already there.
 *
 * Pure, so the decision is testable and so it lives in exactly one place: the
 * refusal "already running" is the one a supervisor most wants to get wrong, and
 * three copies of this predicate would be three chances to get it right.
 */
export function startRefusal(
  current: DaemonState | undefined,
): { readonly ok: true } | { readonly ok: false; readonly code: DaemonFailureCode; readonly message: string } {
  if (current === undefined) {
    return { ok: true };
  }

  if (current.status === "running") {
    return {
      ok: false,
      code: "already_running",
      message: `a daemon is already running as pid ${current.pid}; starting another would race it for the schedule lease`,
    };
  }

  if (current.status === "unhealthy") {
    return {
      ok: false,
      code: "identity_unverifiable",
      message: `pid ${current.pid} exists but its identity could not be confirmed (${current.reason}); ` +
        "run `trylo daemon status` before starting another",
    };
  }

  // `stopped` and `crashed` both permit a start. `crashed` needs no extra step
  // here because the daemon re-reads its own record and finds unsettled
  // occurrences; that is recovery, not a precondition.
  return { ok: true };
}

/**
 * Whether a stop is allowed.
 *
 * A daemon that is not running is already the answer, so this reports
 * `not_running` rather than pretending to have stopped something. The distinction
 * matters for scripts: "I stopped it" and "there was nothing to stop" lead a
 * person to different next steps.
 */
export function stopRefusal(
  current: DaemonState | undefined,
): { readonly ok: true } | { readonly ok: false; readonly code: DaemonFailureCode; readonly message: string } {
  if (current === undefined || current.status === "stopped") {
    return {
      ok: false,
      code: "not_running",
      message: current === undefined ? "no daemon has been started" : "the daemon is already stopped",
    };
  }
  return { ok: true };
}

/**
 * A one-line description for a person, not a machine.
 *
 * `unhealthy` and `crashed` are described differently on purpose: the first needs
 * somebody to look at the system, the second needs somebody to look at the work.
 * Both being "not running" would flatten that difference away.
 */
export function describeDaemon(state: DaemonState): string {
  switch (state.status) {
    case "stopped":
      return "no daemon is running";
    case "running":
      return `running as pid ${state.pid}, last tick ${new Date(state.lastTickAtMs).toISOString()}, ${state.firedCount} fired`;
    case "crashed":
      return `pid ${state.pid} is gone (${state.reason}); ${state.unsettled} occurrence(s) may be unsettled`;
    case "unhealthy":
      return `pid ${state.pid} exists but could not be confirmed (${state.reason})`;
  }
}
