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

/** Payload of the Rust `##TRYLO_PROC_EXIT##` control frame. */
export interface ProcessExitInfo {
  readonly id: ProcessId;
  readonly pid: number;
  /** Exit code, or null when the wait failed / was signalled. */
  readonly code: number | null;
  /** Terminating signal, or null on Windows / when not signalled
   *  (spec §5.3 #5 — present so the wire format is platform-stable). */
  readonly signal: number | null;
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
    onOutput: (line: string) => void;
    onExit?: (info: ProcessExitInfo) => void;
  }): Promise<ProcessHandle>;

  /** Write a single line of text to the process's stdin. */
  send(id: ProcessId, message: string): Promise<void>;

  /** Stop the process. Idempotent. */
  stop(id: ProcessId): Promise<void>;

  /** List live processes (for debug panels). */
  list(): Promise<readonly LiveProcessInfo[]>;
}