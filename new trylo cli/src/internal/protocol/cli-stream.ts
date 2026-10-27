/**
 * CLI stream event catalog and exit codes.
 *
 * These are *projections* of the core envelope/journal, never a second state
 * source: fixture providers, real providers, the REPL and `run --format
 * stream-json` all emit through the same projector. Nothing here is assembled
 * ad hoc in `main.ts`.
 */

import { assertExhaustive } from "../contract/index.js";

export const CLI_STREAM_EVENT_TYPES = [
  "run_start",
  "message_start",
  "message_delta",
  "message_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_use",
  "tool_result",
  "warning",
  "usage",
  "compact",
  "subagent",
  "run_result",
] as const;

export type CliStreamEventType = (typeof CLI_STREAM_EVENT_TYPES)[number];

export function isCliStreamEventType(value: string): value is CliStreamEventType {
  return (CLI_STREAM_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Wire shape of one CLI stream line. Every field is derived from the core
 * envelope; no CLI code may invent a value the journal does not contain.
 */
/** Bounded committed-file metadata; absent on older v1 producers. */
export type CliFileMutation = {
  readonly path: string;
  readonly kind: "created" | "overwritten" | "patched" | "deleted" | "moved";
  readonly from?: string;
  readonly preview?: string;
  readonly truncated?: boolean;
};

export type CliStreamEvent =
  | { readonly type: "run_start"; readonly sessionId: string; readonly turnId: string; readonly providerId: string; readonly model: string; readonly operation?: "compact"; readonly contextWindow?: number }
  | { readonly type: "message_start" }
  | { readonly type: "message_delta"; readonly text: string }
  | { readonly type: "message_end" }
  | { readonly type: "reasoning_start"; readonly redacted: boolean }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "reasoning_end" }
  | { readonly type: "tool_use"; readonly toolCallId: string; readonly name: string; readonly input?: import("./envelope.js").JsonObject }
  | {
      readonly type: "tool_result";
      readonly toolCallId: string;
      readonly status: string;
      readonly output: string;
      readonly truncated: boolean;
      /**
       * Why a call failed, when the journal has a reason for it. Optional on
       * purpose: it is added to an existing field set, so a consumer that never
       * heard of it sees the same line it always saw (D3).
       */
      readonly message?: string;
      /** Additive journal facts; older streams may omit these fields. */
      readonly name?: string;
      readonly code?: string;
      /** Elapsed time between matching tool-use/result journal envelopes. */
      readonly durationMs?: number;
      readonly fileChanges?: ReadonlyArray<CliFileMutation>;
    }
  | {
      readonly type: "warning";
      readonly code: string;
      readonly message: string;
      /**
       * Additive diagnosis for degradations this build can classify. Absent on
       * every other warning, and older consumers keep reading `code`/`message`.
       */
      readonly diagnostic?: import("../ports/provider.js").NativeContinuationDiagnostic;
    }
  | { readonly type: "usage"; readonly usage: CliUsage }
  | { readonly type: "compact"; readonly status: "started" | "completed" | "failed";
      readonly tokensBefore?: number; readonly tokensAfter?: number; readonly reason: string }
  | { readonly type: "subagent"; readonly kind: "spawn" | "update" | "end"; readonly id: string;
      readonly teamRunId?: string; readonly memberId?: string;
      readonly activity?: import("./subagent-activity.js").SubagentToolActivity;
      readonly observation?: import("./subagent-observation.js").SubagentObservation;
      readonly status: "running" | "waiting" | "done" | "failed" | "cancelled";
      readonly agentType?: string; readonly prompt?: string; readonly result?: string;
      readonly error?: string; readonly round?: number; readonly canReceiveInput?: boolean; readonly displayName?: string;
      readonly taskId?: string; readonly resumedFrom?: string; readonly parked?: boolean;
      readonly budget?: import("./subagent-budget.js").SubagentBudgetSnapshot }
  | CliRunResult;

export type CliUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

export type CliRunStatus = "completed" | "failed" | "cancelled" | "unknown";

/**
 * Exactly one `run_result` terminates a stream. Field semantics are fixed:
 * `lastMessage` may be empty but is always present and always a string.
 */
export type CliRunResult = {
  readonly type: "run_result";
  readonly status: CliRunStatus;
  /** Unified provider finish reason; empty when no stream ever started. */
  readonly finishReason: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Actual final durable attempt when fallback spans multiple turns. */
  readonly attemptTurnId?: string;
  readonly iterations: number;
  readonly usage: CliUsage;
  readonly durationMs: number;
  readonly lastMessage: string;
};

export const EXIT_CODES = {
  /** Normal completion. */
  OK: 0,
  /** Execution, model or tool failure. */
  EXECUTION_FAILURE: 1,
  /** Argument or input error. */
  USAGE: 2,
  /** Authentication failure. */
  AUTH: 41,
  /** Configuration failure. */
  CONFIG: 52,
  /** Temporary failure; an outer caller may retry later. */
  TEMPORARY: 75,
  /** User cancellation. */
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const EXIT_CODE_SET: ReadonlySet<number> = new Set<number>(Object.values(EXIT_CODES));

export function isExitCode(value: number): value is ExitCode {
  return EXIT_CODE_SET.has(value);
}

export function exitCodeForRunStatus(status: CliRunStatus): ExitCode {
  switch (status) {
    case "completed":
      return EXIT_CODES.OK;
    case "cancelled":
      return EXIT_CODES.CANCELLED;
    case "failed":
    case "unknown":
      return EXIT_CODES.EXECUTION_FAILURE;
    default: {
      assertExhaustive(status);
      return EXIT_CODES.EXECUTION_FAILURE;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCliUsage(value: unknown): value is CliUsage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    typeof value.totalTokens === "number"
  );
}

export function isCliRunResult(value: unknown): value is CliRunResult {
  if (!isRecord(value) || value.type !== "run_result") {
    return false;
  }
  const status = value.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "unknown") {
    return false;
  }
  return (
    typeof value.finishReason === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.iterations === "number" &&
    typeof value.durationMs === "number" &&
    typeof value.lastMessage === "string" &&
    isCliUsage(value.usage)
  );
}
