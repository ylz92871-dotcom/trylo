import type { Envelope } from "../../protocol/envelope.js";
import type { CliRunResult, CliStreamEvent, CliUsage } from "../../protocol/cli-stream.js";
import type { Transcript } from "../../protocol/transcript.js";
import {
  projectRunResult,
  projectRunStart,
  type RunResultMeta,
  type RunStartFacts,
  type TerminalFacts,
} from "./projection.js";
import { createStreamTranslator } from "./stream-projection.js";
import { foldToolOutput } from "./tool-output.js";

/**
 * CLI projections.
 *
 * `stream-json` is a byte-for-byte contract: stdout carries exactly one JSON
 * event per line and nothing else, so a parent process can parse it. Every
 * human-facing byte therefore goes to stderr, including the final summary.
 */

export type CliSink = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

export type Projection = {
  readonly onEvent: (event: CliStreamEvent) => void;
};

/**
 * A failure reason, on the same line as the result it belongs to.
 *
 * One line only: a tool error's message can carry a command's entire stderr,
 * and a terminal that reprinted it would bury the next twenty lines of the
 * turn. The first non-blank line is the diagnosis; the whole thing is still in
 * the journal and in `stream-json`.
 */
function reasonSuffix(message: string | undefined): string {
  if (message === undefined) {
    return "";
  }
  const first = message.split("\n").find((part) => part.trim().length > 0) ?? "";
  return first.length === 0 ? "" : ` - ${first}`;
}

function textProjection(sink: CliSink): Projection {
  /**
   * Whether the answer's text is still on an unterminated line.
   *
   * The answer streams out in pieces with no newline of its own, and every
   * diagnostic goes to a different stream. So a diagnostic that arrives while
   * the answer is still open lands *on the same line as the answer* unless the
   * line is closed first — which is what `usage` used to do, producing
   * `The package name is @trylo/cli.usage in=32 out=12 total=44`.
   *
   * Closing is therefore done by `line` itself, for every diagnostic, rather
   * than by each branch remembering to: the bug was a branch that forgot.
   */
  let openLine = false;

  const endOpenLine = (): void => {
    if (openLine) {
      sink.stdout("\n");
      openLine = false;
    }
  };

  const line = (text: string): void => {
    endOpenLine();
    sink.stderr(`${text}\n`);
  };

  return {
    onEvent(event) {
      switch (event.type) {
        case "run_start":
          line(`session ${event.sessionId} turn ${event.turnId}`);
          break;
        case "message_start":
          break;
        case "message_delta":
          sink.stdout(event.text);
          if (event.text.length > 0) {
            openLine = true;
          }
          break;
        case "message_end":
          endOpenLine();
          break;
        case "reasoning_start":
          line(event.redacted ? "thinking (redacted)" : "thinking");
          break;
        case "reasoning_delta":
          line(`  ${event.text}`);
          break;
        case "reasoning_end":
          break;
        case "tool_use":
          line(`-> ${event.name} ${event.toolCallId}`);
          break;
        case "tool_result":
          line(
            `<- ${event.toolCallId} ${event.status}${event.truncated ? " (truncated)" : ""}${reasonSuffix(event.message)}`,
          );
          for (const row of foldToolOutput(event.output)) {
            line(`   ${row}`);
          }
          break;
        case "warning":
          line(event.message.length === 0 ? `warning ${event.code}` : `warning ${event.code}: ${event.message}`);
          break;
        case "usage":
          line(
            `usage in=${event.usage.inputTokens} out=${event.usage.outputTokens} total=${event.usage.totalTokens}`,
          );
          break;
        case "run_result":
          line(
            `result status=${event.status} reason=${event.finishReason} iterations=${event.iterations} durationMs=${event.durationMs}`,
          );
          break;
        default:
          break;
      }
    },
  };
}

function jsonProjection(sink: CliSink): Projection {
  return {
    onEvent(event) {
      sink.stdout(`${JSON.stringify(event)}\n`);
    },
  };
}

export function createProjection(format: "text" | "stream-json", sink: CliSink): Projection {
  return format === "stream-json" ? jsonProjection(sink) : textProjection(sink);
}

export function renderRunResult(result: CliRunResult): string {
  return JSON.stringify(result);
}

/**
 * A turn rendered while it is still running (WP D1/D2).
 *
 * Until this existed a run was projected once, after it had finished, so the
 * person watching saw nothing at all until the whole answer was ready. This
 * renders each envelope as the turn emits it, through the same translator the
 * end-of-run projection uses — which is the only reason the earlier output is
 * provably the same sequence, only sooner.
 *
 * What it deliberately does not do is decide anything: `run_start` goes out
 * before the turn begins, `run_result` at the end, and the events in between
 * are whatever the translator makes of the envelopes. A caller that never
 * pushes an envelope gets a `run_start` and a `run_result` and nothing else —
 * the empty-turn shape, unchanged.
 */
export type TurnRenderer = {
  /** One envelope, as the turn emitted it; already translated and rendered. */
  readonly onEnvelope: (envelope: Envelope) => void;
  /** Closes open blocks, emits `run_result`, and hands it back. */
  readonly close: (
    transcript: Transcript,
    usage: CliUsage,
    meta: RunResultMeta,
    terminal: TerminalFacts,
  ) => CliRunResult;
};

export function createTurnRenderer(
  format: "text" | "stream-json",
  sink: CliSink,
  start: RunStartFacts,
): TurnRenderer {
  const projection = createProjection(format, sink);
  const translator = createStreamTranslator();
  let closedResult: CliRunResult | undefined;

  projection.onEvent(projectRunStart(start));

  return {
    onEnvelope(envelope) {
      if (closedResult !== undefined) return;
      for (const event of translator.push(envelope)) {
        projection.onEvent(event);
      }
    },

    close(transcript, usage, meta, terminal) {
      if (closedResult !== undefined) return closedResult;

      for (const event of translator.finish()) {
        projection.onEvent(event);
      }

      const result = projectRunResult(transcript, usage, meta, terminal);

      closedResult = result;
      projection.onEvent(result);

      return result;
    },
  };
}
