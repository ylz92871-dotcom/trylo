import type { CliStreamEvent } from "../../../protocol/cli-stream.js";

export { MAX_TOOL_OUTPUT_LINES } from "../tool-output.js";

import { DEFAULT_WIDTH } from "./frame.js";
import { quotedOutput } from "./diff-view.js";
import { markdownLines } from "./markdown.js";
import { panelLinesFor, waitingAfterResult, type WaitingReason } from "./waiting.js";

/**
 * The TUI's frame state, and the one reducer that fills it.
 *
 * This module is pure: an event goes in, a new state comes out, nothing here
 * writes to a terminal. The frame renderer (`frame.ts`) is a second pure
 * function over this state, so the whole rendering half of the TUI is
 * testable without any IO — which is the shape the work package asks for
 * (contract #1: same input, same output).
 *
 * The state is fed by the existing surface event stream (`CliStreamEvent`)
 * and by nothing else. The status bar may show session facts and the tool
 * calls the events themselves opened and closed; it never predicts what the
 * loop is doing (contract #5: read the events, do not guess).
 */

export type TuiTone =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  /** What a tool printed, quoted under its call. Not the model's words. */
  | "output"
  /**
   * A line a tool printed that says what it added. Recognised from the line's
   * own `+`, so a tool that writes a unified diff gets coloured without a
   * protocol change — the data was always in the text.
   */
  | "added"
  /** The other half of a diff: what the tool took away. */
  | "removed"
  | "warning"
  | "system"
  /** A heading or other emphasis the answer itself asked for (WP23.1). */
  | "strong"
  /** A blockquote row: the model quoting, marked in the text and dimmed. */
  | "quote";

/**
 * How much thinking stays on screen once it is finished.
 *
 * Thinking streams in so a person can see it happening, but a turn that
 * reasons for two hundred lines pushes their own question off the top — and
 * the reasoning was scaffolding, not answer. It is folded at `reasoning_end`
 * rather than as it arrives: the point of showing it at all is that it is
 * visibly happening, and a block that never appears has not done that.
 *
 * The whole thing stays in the journal and in `stream-json`.
 */
export const MAX_REASONING_LINES = 4;
const KEPT_REASONING_LINES = 2;

export type TuiLine = {
  readonly tone: TuiTone;
  readonly text: string;
};

/** Facts fixed when the session opens. Rendered as-is, never invented. */
export type TuiFacts = {
  readonly workspaceRoot?: string;
  readonly permissionMode?: string;
  readonly sessionId: string;
  readonly providerId: string;
  readonly model: string;
  readonly maxIterations: number | undefined;
  /**
   * The context ceiling this run resolves to, when one is known.
   *
   * Optional because not every provider declares a window; without it a
   * context percentage would be a number invented from a number somebody
   * guessed, and the bar has a rule about that.
   */
  readonly contextTokenLimit: number | undefined;
};

export type TuiUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

/** A tool result kept for the `/details` panel. */
export type ToolResultEntry = {
  readonly toolCallId: string;
  readonly name: string;
  readonly status: string;
  readonly message: string | undefined;
  readonly output: string;
  readonly truncated: boolean;
};

/** A tool call in flight: its name and the arguments it was opened with. */
export type ToolCallFact = {
  readonly name: string;
  readonly input: import("../../../protocol/envelope.js").JsonObject | undefined;
};

/** An assistant message being streamed in, not yet closed by `message_end`. */
type PendingMessage = {
  readonly text: string;
};

export type TuiState = {
  readonly pendingInputCount?: number;
  readonly facts: TuiFacts;
  /** True between `run_start` and `run_result` of the latest turn. */
  readonly running: boolean;
  readonly lines: ReadonlyArray<TuiLine>;
  /**
   * Tool calls opened by `tool_use` and not yet closed by `tool_result`, with
   * the arguments they were opened with — the question panel is drawn from the
   * *call*, not from re-parsing a result's prose.
   */
  readonly toolsInFlight: ReadonlyMap<string, ToolCallFact>;
  /** Iteration count of the last finished turn, from its `run_result`. */
  readonly iterations: number | undefined;
  /** Wall-clock length of the last finished turn, from its `run_result`. */
  readonly durationMs: number | undefined;
  readonly usage: TuiUsage | undefined;
  readonly lastStatus: string | undefined;
  readonly pending: PendingMessage | undefined;
  /**
   * The open reasoning block: where it started and how many rows it has drawn.
   * Present only while it is open, so a folded block is folded exactly once.
   */
  readonly reasoning?: { readonly from: number; readonly rows: number } | undefined;
  /** Tool results received this session, newest last, for `/details`. */
  readonly toolResults: ReadonlyArray<ToolResultEntry>;
  /** Why the shell is waiting, when an event has said so (WP23.3). */
  readonly waiting: WaitingReason | undefined;
};

export function emptyTuiState(facts: TuiFacts): TuiState {
  return {
    facts,
    running: false,
    lines: [],
    toolsInFlight: new Map<string, ToolCallFact>(),
    iterations: undefined,
    durationMs: undefined,
    usage: undefined,
    lastStatus: undefined,
    pending: undefined,
    reasoning: undefined,
    toolResults: [],
    waiting: undefined,
  };
}

export function pushUserLine(state: TuiState, text: string): TuiState {
  return appendLines(state, [{ tone: "user", text }]);
}

export function pushSystemLine(state: TuiState, text: string): TuiState {
  return appendLines(state, [{ tone: "system", text }]);
}

function appendLines(state: TuiState, added: ReadonlyArray<TuiLine>): TuiState {
  return { ...state, lines: [...state.lines, ...added] };
}

function lineOf(tone: TuiTone, text: string): TuiLine {
  return { tone, text };
}

/** Multi-line text becomes one rendered line per source line. */
function textLines(tone: TuiTone, text: string): ReadonlyArray<TuiLine> {
  return text.split("\n").map((part) => lineOf(tone, part));
}

export function reduceTuiEvent(
  state: TuiState,
  event: CliStreamEvent,
  columns: number = DEFAULT_WIDTH,
): TuiState {
  switch (event.type) {
    case "run_start":
      return {
        ...state,
        running: true,
        toolsInFlight: new Map<string, ToolCallFact>(),
        pending: undefined,
        lastStatus: undefined,
        // A question or a plan outlives the turn that asked for it (an async
        // question is *designed* to); only a tool wait is tied to one turn.
        waiting: state.waiting?.kind === "tool" ? undefined : state.waiting,
      };
    case "message_start":
      return { ...state, pending: { text: "" } };
    case "message_delta":
      return {
        ...state,
        pending: { text: (state.pending?.text ?? "") + event.text },
      };
    case "message_end":
      return closeMessage(state, columns);
    case "reasoning_start":
      return { ...state, reasoning: { from: state.lines.length, rows: 0 } };
    case "reasoning_delta": {
      const added = textLines("reasoning", event.text);
      const open = state.reasoning ?? { from: state.lines.length, rows: 0 };
      return {
        ...appendLines(state, added),
        reasoning: { from: open.from, rows: open.rows + added.length },
      };
    }
    case "reasoning_end":
      return foldReasoning(state);
    case "tool_use":
      return withInFlight(
        appendLines(state, [lineOf("tool", `-> ${event.name}${toolTarget(event.input)}`)]),
        event.toolCallId,
        { name: event.name, input: event.input },
      );
    case "tool_result": {
      const call = state.toolsInFlight.get(event.toolCallId);
      const entry: ToolResultEntry = {
        toolCallId: event.toolCallId,
        name: call?.name ?? "?",
        status: event.status,
        message: event.message,
        output: event.output,
        truncated: event.truncated,
      };
      const closed = withoutInFlight(appendLines(state, toolResultLines(event)), event.toolCallId);
      const panelled = appendLines(closed, panelLinesFor(entry, call));

      return {
        ...panelled,
        toolResults: [...state.toolResults, entry],
        waiting: waitingAfterResult(panelled.waiting, entry, call),
      };
    }
    case "warning":
      return appendLines(state, [
        lineOf(
          "warning",
          event.message.length === 0
            ? `warning ${event.code}`
            : `warning ${event.code}: ${event.message}`,
        ),
      ]);
    case "usage":
      return { ...state, usage: event.usage };
    case "run_result":
      return {
        ...state,
        running: false,
        iterations: event.iterations,
        durationMs: event.durationMs,
        lastStatus: event.status,
        usage: event.usage,
        toolsInFlight: new Map<string, ToolCallFact>(),
        pending: undefined,
        waiting: state.waiting?.kind === "tool" ? undefined : state.waiting,
      };
    default:
      return state;
  }
}

/**
 * One tool result, as the lines a person sees.
 *
 * The three parts answer the three questions the old rendering left open:
 * did it work, why not, and what came back. The call id is deliberately not
 * shown — it is a machine handle, and on screen two adjacent lines are already
 * paired by being adjacent; the id is still in the journal and in
 * `stream-json` for anyone who needs to trace one.
 *
 * A failure's reason is quoted even though the output is empty for one:
 * `stream-projection.ts` puts the diagnosis in `message` and never in
 * `output`, so a failed call that rendered its `output` alone said "failed"
 * and nothing else, and the person watching had no way to tell whether the
 * command was refused, timed out, or really did fail on its own.
 */
function toolResultLines(event: Extract<CliStreamEvent, { type: "tool_result" }>): ReadonlyArray<TuiLine> {
  const suffix = event.truncated ? " (truncated)" : "";
  const lines = [lineOf("tool", `<- ${event.status}${suffix}`)];
  return [...lines, ...failureLines(event.message), ...quotedOutput(event.output)];
}

function toolTarget(input: import("../../../protocol/envelope.js").JsonObject | undefined): string {
  if (input === undefined) return "";
  const target = input["path"] ?? input["file_path"] ?? input["command"] ?? input["program"] ?? input["url"];
  if (typeof target !== "string") return "";
  const text = target.replace(/\s+/g, " ");
  return ` · ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
}

/**
 * How much of a failure's reason stays on screen.
 *
 * The reason is quoted in full up to a fold, not flattened to its first line:
 * a failed call's diagnosis is often "hunk 2 did not match" *followed by* the
 * mismatched context, and a person who sees only the headline cannot tell
 * whether to fix the patch, the file, or the request. Full text stays in the
 * journal and in `stream-json`; `/details` always shows all of it.
 */
const MAX_FAILURE_LINES = 4;

function failureLines(message: string | undefined): ReadonlyArray<TuiLine> {
  if (message === undefined) {
    return [];
  }

  const rows = message
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.trim().length > 0);
  const shown = rows.slice(0, MAX_FAILURE_LINES);
  const hidden = rows.length - shown.length;

  return [
    ...shown.map((row) => lineOf("warning", `   ! ${row}`)),
    ...(hidden > 0 ? [lineOf("warning", `   ! … ${hidden} more lines (/details for all)`)] : []),
  ];
}

/**
 * The tool's own text, indented under its call and folded to a few lines.
 *
 * Indented rather than quoted with a prefix character: the output is already
 * someone else's formatting, and every prefix is one more thing that has to be
 * stripped to paste it somewhere.
 */
/**
 * Close an open reasoning block, folding it if it grew past the limit.
 *
 * Called unconditionally at `reasoning_end`; when no block is open (`undefined`
 * reasoning) this is a no-op, which is the case for a turn that never reasoned
 * and for a block that was already folded.
 */
function foldReasoning(state: TuiState): TuiState {
  const open = state.reasoning;
  if (open === undefined || open.rows <= MAX_REASONING_LINES) {
    return { ...state, reasoning: undefined };
  }

  const kept = state.lines.slice(open.from, open.from + KEPT_REASONING_LINES);
  const hidden = open.rows - KEPT_REASONING_LINES;

  return {
    ...state,
    lines: [
      ...state.lines.slice(0, open.from),
      ...kept,
      lineOf("reasoning", `   … ${hidden} more lines`),
    ],
    reasoning: undefined,
  };
}

function closeMessage(state: TuiState, columns: number): TuiState {
  const text = state.pending?.text ?? "";
  const flushed =
    text.length === 0 ? [] : markdownLines(text, columns);
  return { ...appendLines(state, flushed), pending: undefined };
}

function withInFlight(state: TuiState, id: string, fact: ToolCallFact): TuiState {
  const tools = new Map(state.toolsInFlight);
  tools.set(id, fact);
  const names = [...tools.values()].map((tool) => tool.name);
  return { ...state, toolsInFlight: tools, waiting: { kind: "tool", names } };
}

function withoutInFlight(state: TuiState, id: string): TuiState {
  const tools = new Map(state.toolsInFlight);

  tools.delete(id);
  const names = [...tools.values()].map((tool) => tool.name);

  return {
    ...state,
    toolsInFlight: tools,
    waiting: names.length > 0 ? { kind: "tool", names } : undefined,
  };
}
