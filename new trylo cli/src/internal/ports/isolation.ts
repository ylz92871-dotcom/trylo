import type { JsonObject } from "../protocol/envelope.js";

/**
 * WP04 — OS isolation.
 *
 * The existing `ToolSandbox` in `tools.ts` answers "may this call be shown to
 * a human at all". This port answers a different and stronger question: "when
 * the process actually starts, will the operating system — not a comment, not
 * a stripped proxy variable — confine it?"
 *
 * The distinction is not academic. `shell-spawn.ts` documents that
 * `network=restricted` is realised by clearing proxy variables, and a command
 * that opens a socket still succeeds. So the previous state was a *plan*
 * checked against paths, with no enforcement behind it. Everything here exists
 * to make the enforcement claim true and, where it cannot be true, to say so
 * instead of implying otherwise.
 *
 * Two rules shape the whole surface:
 *
 *  - **Unavailable is a real answer.** A platform or machine without an
 *    installed sandbox reports `unavailable` with a reason. It never reports
 *    `ready` on the strength of a prompt or a comment, and it never falls back
 *    to running the command unconfined.
 *  - **The caller owns the decision.** This port measures and applies; it
 *    never widens a policy on its own. `Permission` stays the only owner of
 *    what a command may do, exactly as before.
 */

/** Why a platform can or cannot confine a process here. */
export type IsolationBackend = "windows-srt" | "linux-bwrap" | "macos-seatbelt";

/** Explicit process boundary; host preserves caller authority, never grants approval. */
export type ShellIsolation = "sandbox" | "host";

/** Preparation failures are not command execution or permission decisions. */
export type ShellIsolationFailureCode = "isolation_preparation_failed" | "isolation_not_installed"
  | "isolation_broken" | "isolation_unavailable" | "isolation_closed" | "isolation_helper_protection_failed";

export class ShellIsolationError extends Error {
  constructor(readonly code: ShellIsolationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShellIsolationError";
  }
}

/**
 * Availability is a state machine, not a boolean: `not_installed` and
 * `broken` both mean "do not run this", but they mean different things to the
 * person reading `doctor`, and only the first is fixed by running an installer.
 */
export type IsolationAvailability =
  | {
      readonly state: "ready";
      readonly backend: IsolationBackend;
      /** Human-readable proof that enforcement is live, e.g. the fence probe. */
      readonly evidence: string;
    }
  | {
      readonly state: "not_installed";
      readonly backend: IsolationBackend;
      /** The exact command that would install it. Never run automatically. */
      readonly installHint: string;
    }
  | {
      readonly state: "unavailable";
      /** Why no isolation exists here — unsupported platform, or a helper error. */
      readonly reason: string;
    }
  | {
      readonly state: "broken";
      readonly backend: IsolationBackend;
      /** Installed but not enforcing; running anyway would be a lie. */
      readonly reason: string;
    };

/**
 * The file boundary the OS will enforce, as opposed to the one the planner
 * believes in. Both exist: the planner refuses out-of-workspace paths up
 * front, and these entries stop a command that ignores it.
 */
export type IsolationFilePolicy = {
  /** Absolute paths the confined process may write. */
  readonly writableRoots: readonly string[];
  /** Absolute paths the confined process may not write, applied after the roots. */
  readonly denyWritePaths: readonly string[];
  /** Absolute paths the confined process may not read. Empty means "no read carve-out". */
  readonly denyReadPaths: readonly string[];
};

/**
 * A network boundary expressed as destinations rather than as a boolean. An
 * empty allowlist is not "no restriction": it means every destination must be
 * named, because the failure mode of guessing is silently allowing the
 * network the policy was written to close.
 */
export type IsolationNetworkPolicy = {
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  /**
   * Whether the OS fence is actually up. `false` means a direct connect from
   * inside the sandbox may succeed, so an allowlist is advisory at best —
   * callers must treat the policy as unenforced.
   */
  readonly egressFenceVerified: boolean;
};

/** What to confine one spawn, and what came back. */
export type IsolationRequest = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly files: IsolationFilePolicy;
  readonly network: IsolationNetworkPolicy;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

export type IsolationOutcome = IsolationExecutionOutcome & {
  /** Command facts remain intact; cleanup failure must never trigger an automatic replay. */
  readonly cleanupFailure?: { readonly code: "isolation_cleanup_failed"; readonly message: string };
};

type IsolationExecutionOutcome =
  | {
      readonly outcome: "completed";
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
      readonly timedOut: boolean;
      readonly backend: IsolationBackend;
    }
  | {
      /**
       * The command could not be started under isolation. This is deliberately
       * distinct from `completed` with a non-zero exit: nothing ran, so a
       * caller must not read the failure as the command's own verdict.
       */
      readonly outcome: "isolation_failed";
      readonly code: IsolationFailureCode;
      readonly message: string;
    }
  | {
      readonly outcome: "cancelled";
    };

/**
 * Typed so a caller can branch without reading prose. `unavailable` is the
 * one that must never be treated as "carry on without the sandbox".
 */
export const ISOLATION_FAILURE_CODES = [
  "isolation_unavailable",
  "isolation_not_installed",
  "isolation_broken",
  "isolation_start_failed",
  "isolation_refused",
] as const;
export type IsolationFailureCode = (typeof ISOLATION_FAILURE_CODES)[number];

/**
 * The one place a confined process is started.
 *
 * Implementations must not fall back to an unconfined spawn on any failure
 * path. A sandbox that quietly degrades is worse than no sandbox, because the
 * permission the user approved was granted on the assumption of a boundary
 * that is not there.
 */
export type IsolationPort = {
  /** Measures readiness. Never installs anything. */
  probe(): Promise<IsolationAvailability>;
  run(request: IsolationRequest): Promise<IsolationOutcome>;
};

/** Diagnostic rows for `doctor`, kept free of rendering concerns. */
export type IsolationDiagnostic = {
  readonly backend: string;
  readonly state: IsolationAvailability["state"];
  readonly detail: string;
  /** Present when the machine can be fixed by running an installer. */
  readonly remedy?: string;
  readonly raw?: JsonObject;
};
