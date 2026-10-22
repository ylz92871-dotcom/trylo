/**
 * The three tools a long-running command needs.
 *
 * # Why these are their own port
 *
 * `run_shell` decides whether a command may start. These decide what happens to
 * one that already did, and they answer a different question: not "may this run"
 * but "what has become of the thing that is running". Routing them through the
 * sandbox would mean asking permission to observe a process the sandbox already
 * approved — and a refusal there would be indistinguishable from the sandbox
 * refusing to start it.
 *
 * # Why they are read-only in effect
 *
 * None of them can start anything. `write_stdin` can only send characters to a
 * session that exists; `list_processes` reads; `stop_process` ends. So they
 * declare `read_only` and get mounted whenever the catalog exists, rather than
 * disappearing with the sandbox — a model that started a command must be able to
 * check on it even in a mode where it may not start another.
 */

import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { ToolBinding } from "../../../ports/tools.js";
import {
  MAX_PROCESS_YIELD_MS,
  MIN_PROCESS_YIELD_MS,
  MIN_PROCESS_POLL_YIELD_MS,
  isTerminalProcessStatus,
  type ProcessSessionId,
  type ProcessSessionEndReason,
  type ProcessSessionList,
  type ProcessSessionWriteResult,
  readYieldMs,
  yieldMsWithinBounds,
} from "../../../ports/process-session.js";
import {
  DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  DEFAULT_MAX_SHELL_OUTPUT_LINES,
} from "../../sandbox/policy.js";
import { describeProcessEnd, processEndFields, processEndSuffix } from "./process-session-presentation.js";

export const WRITE_STDIN_TOOL = "write_stdin";
export const LIST_PROCESSES_TOOL = "list_processes";
export const STOP_PROCESS_TOOL = "stop_process";

/**
 * What the session tools need. Deliberately the narrow shape: a tool that could
 * start a process through this port would make the sandbox's approval one
 * decision ago and irrelevant.
 */
export type ProcessSessionToolsPort = {
  write(request: {
    readonly sessionId: ProcessSessionId;
    readonly input: string;
    readonly eof: boolean;
    readonly yieldMs: number;
  }): Promise<ProcessSessionWriteResult>;
  list(): ProcessSessionList;
  stop(sessionId: ProcessSessionId): Promise<
    | { readonly ok: true; readonly end: ProcessSessionEndReason }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  /** Terminal sessions, when this build has a helper for the running platform. */
  readonly supportsTty: boolean;
};

const OUTPUT_LIMITS = {
  maxBytes: DEFAULT_MAX_SHELL_OUTPUT_BYTES,
  maxLines: DEFAULT_MAX_SHELL_OUTPUT_LINES,
};

export const WRITE_STDIN_BINDING: ToolBinding = {
  name: WRITE_STDIN_TOOL,
  description:
    "Send text to a command that is still running, or ask what it has produced. An empty `chars` is a poll: it returns whatever has appeared since the last read and never confuses that with input. Omitted yieldMs defaults to 250 ms for input or 1000 ms for polling. Every reply states process status and observed terminal details; an exited command succeeds only with exit code 0 and no terminating signal. This continues a command that already started — it does not start anything new, and it cannot revive one that has ended.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Id returned by the command that started it." },
      chars: {
        type: "string",
        description: "Text to send. Leave empty to poll for output without sending anything.",
      },
      eof: {
        type: "boolean",
        description: "Close the command's input, which is how it learns no more input is coming.",
      },
      yieldMs: {
        type: "number",
        description: `How long to wait for output before answering, in milliseconds (${MIN_PROCESS_YIELD_MS}–${MAX_PROCESS_YIELD_MS}). A poll waits at least ${MIN_PROCESS_POLL_YIELD_MS}.`,
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
  needsApproval: false,
  timeoutMs: MAX_PROCESS_YIELD_MS + 5_000,
  outputLimits: OUTPUT_LIMITS,
};

export const LIST_PROCESSES_BINDING: ToolBinding = {
  name: LIST_PROCESSES_TOOL,
  description:
    "List every command this session started and is still tracking, with each one's status: running, exited with a code, failed, or lost. A lost process is one whose output can no longer be observed — it is not the same as an exit, and is never reported as one.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      runningOnly: {
        type: "boolean",
        description: "Only list commands that have not reached an end yet.",
      },
    },
    additionalProperties: false,
  },
  needsApproval: false,
  timeoutMs: 5_000,
  outputLimits: OUTPUT_LIMITS,
};

export const STOP_PROCESS_BINDING: ToolBinding = {
  name: STOP_PROCESS_TOOL,
  description:
    "Stop a command this session started and is still tracking, by the id it was given. Reports what could be observed about the ending. Stopping something that already ended is not an error — it returns the end it had.",
  sideEffect: "read_only",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Id of the command to stop." },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
  // Not `needsApproval: true`, and the reason is worth stating because the
  // obvious reading says otherwise. Ending a process does end one — but only a
  // session this run started, addressed by the id this run issued. There is no
  // pid parameter and no way to name a process the run did not begin, so the
  // tool cannot reach anything that was not already approved to exist. A
  // prompt here would ask a human to authorise the obvious.
  needsApproval: false,
  timeoutMs: 10_000,
  outputLimits: OUTPUT_LIMITS,
};

function readString(call: ToolCallRequest, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(call: ToolCallRequest, key: string): boolean {
  return call.arguments[key] === true;
}

function optionalArgumentProblem(call: ToolCallRequest, key: string, expected: "string" | "boolean"): ToolOutcome | undefined {
  const value = call.arguments[key];
  if (value === undefined || typeof value === expected) return undefined;
  return { outcome: "error", code: "invalid_arguments", message: `${call.name} ${key} must be a ${expected} when present` };
}

/**
 * Omitted yields follow the advertised defaults. Explicit values still need
 * the normal bounds; a valid short poll uses the existing anti-spin floor.
 */
function resolveYieldMs(call: ToolCallRequest, input: string): number | undefined {
  const asked = readYieldMs(call.arguments["yieldMs"], input.length === 0 ? MIN_PROCESS_POLL_YIELD_MS : MIN_PROCESS_YIELD_MS);
  if (asked === undefined) {
    return undefined;
  }
  if (!yieldMsWithinBounds(asked)) {
    return undefined;
  }
  if (input.length === 0) {
    return Math.max(asked, MIN_PROCESS_POLL_YIELD_MS);
  }
  return asked;
}

export type ProcessSessionTools = {
  readonly bindings: ReadonlyArray<ToolBinding>;
  execute(call: ToolCallRequest): Promise<ToolOutcome>;
};

export function createProcessSessionTools(
  sessions: ProcessSessionToolsPort,
): ProcessSessionTools {
  async function execute(call: ToolCallRequest): Promise<ToolOutcome> {
    if (call.name === LIST_PROCESSES_TOOL) {
      const problem = optionalArgumentProblem(call, "runningOnly", "boolean");
      if (problem !== undefined) return problem;
      const runningOnly = readBoolean(call, "runningOnly");
      const listed = sessions.list().sessions.filter(
        (session) => !runningOnly || !isTerminalProcessStatus(session.status),
      );
      const value: JsonObject = {
        sessions: listed.map((session) => ({
          sessionId: session.id,
          status: session.status,
          command: session.command,
          cwd: session.cwd,
          tty: session.tty,
          ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
          ...(session.end === undefined ? {} : { end: session.end.kind }),
          ...processEndFields(session.end),
          bufferedBytes: session.bufferedBytes,
          droppedOutput: session.droppedOutput,
          ...(session.endedAtMs === undefined ? {} : { endedAtMs: session.endedAtMs }),
        })),
        supportsTty: sessions.supportsTty,
      };
      const lines = listed.map(
        (session) => `${session.id} ${session.status}${processEndSuffix(session.end)} ${session.command}`,
      );
      return {
        outcome: "result",
        value,
        output:
          listed.length === 0
            ? "No command sessions are being tracked."
            : lines.join("\n"),
        truncated: false,
      };
    }

    const sessionId = readString(call, "sessionId");
    if (sessionId === undefined) {
      return {
        outcome: "error",
        code: "invalid_arguments",
        message: `${call.name} requires a sessionId`,
      };
    }

    if (call.name === STOP_PROCESS_TOOL) {
      const stopped = await sessions.stop(sessionId);
      if (!stopped.ok) {
        return { outcome: "error", code: stopped.code, message: stopped.message };
      }
      const end = stopped.end;
      return {
        outcome: "result",
        value: { sessionId, end: end.kind, ...processEndFields(end) },
        output: `Session ${sessionId} ${end.kind === "exited" ? "stopped or already ended" : "has observed state " + end.kind} (${describeProcessEnd(end)}).`,
        truncated: false,
      };
    }

    if (call.name === WRITE_STDIN_TOOL) {
      const problem = optionalArgumentProblem(call, "chars", "string") ?? optionalArgumentProblem(call, "eof", "boolean");
      if (problem !== undefined) return problem;
      const input = readString(call, "chars") ?? "";
      const eof = readBoolean(call, "eof");
      const yieldMs = resolveYieldMs(call, input);
      if (yieldMs === undefined) {
        return {
          outcome: "error",
          code: "invalid_arguments",
          message:
            `write_stdin yieldMs must be between ${MIN_PROCESS_YIELD_MS} and ${MAX_PROCESS_YIELD_MS}; ` +
            `a poll waits at least ${MIN_PROCESS_POLL_YIELD_MS}`,
        };
      }
      const result = await sessions.write({ sessionId, input, eof, yieldMs });
      if (!result.ok) {
        return {
          outcome: "error",
          code: result.code,
          message:
            result.code === "session_finished"
              ? `${result.message}. It ended as ${result.end?.kind ?? "unknown"}${processEndSuffix(result.end)}; start a new command rather than writing to this one.`
              : result.message,
        };
      }
      const read = result.read;
      const content =
        read.output.length === 0
          ? "No new output."
          : read.output;
      const body = `Session ${sessionId} is ${read.status}${processEndSuffix(read.end)}.\n${content}`;
      return {
        outcome: "result",
        value: {
          sessionId,
          status: read.status,
          output: read.output,
          truncated: read.truncated,
          ...(read.end === undefined ? {} : { end: read.end.kind }),
          ...processEndFields(read.end),
          bufferedBytes: read.bufferedBytes,
        },
        output: read.truncated ? `${body}\n[output truncated]` : body,
        truncated: read.truncated,
      };
    }

    return {
      outcome: "error",
      code: "unknown_tool",
      message: `unknown_tool:${call.name}`,
    };
  }

  return {
    bindings: [WRITE_STDIN_BINDING, LIST_PROCESSES_BINDING, STOP_PROCESS_BINDING],
    execute,
  };
}
