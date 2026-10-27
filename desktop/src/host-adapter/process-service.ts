// Trylo Desktop — ProcessService interface. See ARCHITECTURE.md
// §2.2 + §3 Phase 2 task #3+#4 (Trylo Core subprocess + CC CLI
// channel).
//
// A long-running sidecar (Trylo Core, CC CLI, future Hermes)
// exposes its `stdout` as a stream of lines and accepts prompt
// lines on `stdin`. The Rust shell brokers the pipes; this
// service is the React-side view.
//
// v1.16.6 (M4-A): `onExit` lets the runtime supervision layer
// learn a child died even when nobody called `stop` — the Rust
// reaper emits a `process.exited` control frame once wait()
// returns. Without it the supervisor would think a dead CLI was
// still running indefinitely.

import type { ProcessId } from './types';

export interface ProcessHandle {
  readonly id: ProcessId;
  readonly pid: number;
  readonly label: string;
  readonly command: string;
}

export interface ProcessOutputEvent {
  readonly line: string;
}

export interface ProcessRecoveryIdentity { readonly teamRunId: string; readonly turnId: string }
export interface RecoverableProcess {
  readonly id: ProcessId;
  readonly pid: number;
  readonly projectKey: string;
  readonly conversationId: string;
  readonly identity: ProcessRecoveryIdentity;
}
export interface RetainedProcessOutput {
  readonly version: 1;
  readonly process: RecoverableProcess;
  readonly records: readonly { readonly sequence: number; readonly stream: 'stdout' | 'stderr'; readonly line: string }[];
  readonly nextSequence: number;
  readonly hasMore: boolean;
  readonly gap: boolean;
  readonly finished: boolean;
  readonly captureComplete: boolean;
  readonly exit: ProcessExitInfo | null;
  readonly answeredRequests: readonly string[];
}

/** Payload of the Rust `##TRYLO_PROC_EXIT##` control frame. */
export interface ProcessExitInfo {
  readonly id: ProcessId;
  readonly pid: number;
  /** Exit code, or null when the wait failed / was signalled. */
  readonly code: number | null;
  /** Terminating signal, or null on Windows / when not signalled
   *  (spec §5.3 #5 — present so the wire format is platform-stable). */
  readonly signal: number | null;
  /** False when native draining or the separate stderr delivery timed out. */
  readonly outputComplete?: boolean;
  /** Successfully queued stderr lines, for ordering independent IPC channels. */
  readonly stderrLines?: number;
}

/** A live process plus its debug attribution (from `process_list`). */
export interface LiveProcessInfo extends ProcessHandle {
  readonly metadata: {
    readonly projectKey?: string;
    readonly conversationId?: string;
    readonly runId?: string;
  };
}

export interface ProcessService {
  /**
   * Spawn a sidecar process. Returns once the Rust side has the
   * child handle. The `onOutput` callback is invoked for every
   * line of stdout; `onExit` fires once when the child exits.
   *
   * P08 §4.2: `onStderr` is a SEPARATE channel. It exists because the
   * new CLI reports pre-run failures (bad session id, missing
   * credential) on stderr with an exit code and NOTHING on stdout —
   * a caller that only reads stdout would wait forever for a terminal
   * event. stderr must never be merged into the stdout JSONL stream.
   *
   * It is opt-in: the legacy CC CLI floods stderr with debug logging,
   * so callers that don't need it get `Stdio::null()` on the Rust side.
   */
  spawn(opts: {
    command: string;
    args: readonly string[];
    label: string;
    cwd?: string;
    /** Extra env vars to set on the child (e.g. CLAUDE_CODE_LOOP_EVENTS_FILE). */
    env?: Readonly<Record<string, string>>;
    /** Debug attribution, surfaced by `list()` for diagnostics. */
    metadata?: Readonly<{ projectKey?: string; conversationId?: string; runId?: string }>;
    /** Opt-in shell retention for a frozen team; no prompt or environment metadata. */
    recoveryIdentity?: ProcessRecoveryIdentity;
    onOutput: (line: string) => void;
    /** P08 §4.2: stderr lines, on their own channel. Omit to discard. */
    onStderr?: (line: string) => void;
    onExit?: (info: ProcessExitInfo) => void;
  }): Promise<ProcessHandle>;

  /** Write a single line of text to the process's stdin. */
  send(id: ProcessId, message: string): Promise<void>;

  /**
   * P08 §4.2: close the process's STDIN and nothing else.
   *
   * This is how a one-shot CLI is told "the prompt is complete": the
   * new CLI's `run` does not start executing until stdin reaches EOF.
   * It is NOT a stop — stdout keeps streaming, the cancellation handle
   * stays armed, and the child's exit is still attributed to this id.
   *
   * Idempotent: closing an already-closed stdin succeeds. A later
   * `send` on the same id fails with a broken-pipe error.
   */
  closeInput(id: ProcessId): Promise<void>;

  /** Stop the process. Idempotent. */
  stop(id: ProcessId): Promise<void>;

  /** List live processes (for debug panels). */
  list(): Promise<readonly LiveProcessInfo[]>;
  /** Optional for browser/older hosts. Includes bounded recent exited roots. */
  recoveryList?(): Promise<readonly RecoverableProcess[]>;
  readOutput?(id: ProcessId, afterSequence: number): Promise<RetainedProcessOutput>;
  /** OS lease probe; true can include a root owned by a different Native shell. */
  hasTeamOwner?(workspaceRoot: string, conversationId: string): Promise<boolean>;
}
