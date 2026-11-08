import type { JsonObject } from "../protocol/envelope.js";
import type { ReduceInput } from "../domain/input.js";
import type { ToolCallRequest, ToolPort, ToolOutcome } from "../ports/tools.js";
import { executeToolSafely } from "./tool-boundary.js";
import { emitFileWriteRecord } from "./tool-effects.js";
import { cutToBytes } from "../protocol/text-cut.js";
import type { ImageReference } from "../protocol/image-reference.js";

/**
 * Running one approved tool call.
 *
 * Kept out of `runner.ts` for the same reason `runPermissionFor` is: the runner
 * is a frozen core that must not grow new responsibilities. Everything this
 * needs from the in-flight turn arrives as a callback, so the translation below
 * can be read without knowing how the runner stores state.
 *
 * The translation itself is the point. One adapter outcome becomes exactly two
 * records — what the model sees in the transcript and what the journal files —
 * both derived from the same object. A tool therefore cannot report success to
 * the model while the durable record says something else.
 */

/**
 * The ceiling on what the model may see from one tool result.
 *
 * **The result's total size, marker included.** Not a payload allowance with
 * extra room on top: the marker is paid for out of this budget, exactly as
 * Codex's prototype does it (`split_budget(max_bytes)` hands the whole budget to
 * the two ends and puts the marker in the middle, `codex-rs/utils/string/src/
 * truncate.rs`). An earlier revision read `65_536 + 512`, reasoning that a
 * bounded positioning header from another package needed its own headroom — but
 * that header belongs to the package that adds it, and paying for it here meant a
 * result could reach 66,048B and break the ceiling
 * `adapters/mcp-runtime/approval.test.ts` pins at 65,536 + the marker. Raising
 * this constant is how you change the contract; it is not a per-consumer
 * allowance.
 */
export const MAX_TOOL_OUTPUT_BYTES = 65_536;

export type ToolResultOutcome = "succeeded" | "failed" | "cancelled" | "unknown";

export type ToolResultRecord = {
  readonly toolCallId: string;
  readonly name: string;
  readonly output: string;
  readonly truncated: boolean;
  readonly outcome: ToolResultOutcome;
  readonly images?: ReadonlyArray<ImageReference>;
};

export type ToolExecutionHost = {
  readonly emit: (kind: string, payload: JsonObject) => void;
  readonly dispatch: (input: ReduceInput) => Promise<void>;
  readonly nextEventId: () => string;
  /** Appends the model-visible tool result; the host owns the transcript. */
  readonly recordResult: (item: ToolResultRecord) => void;
  /**
   * Feeds one successful tool outcome into the turn's net-diff tracker
   * (WP11/C20). Optional so older hosts keep their shape.
   */
  readonly noteTurnDiff?: (tool: string, value: JsonObject) => void;
};

export type ToolExecutionCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
};

/**
 * The one diagnostic string for a failed call.
 *
 * The code has to be visible — an exit code or a reason nobody can act on is
 * not a diagnosis — but several adapters already write it into their message,
 * and saying it twice reads like a stutter. So: keep the message as written
 * when it already leads with its own code, otherwise put the code in front.
 */
export function failureText(code: string, message: string): string {
  return message.startsWith(`${code}:`) ? message : `${code}:${message}`;
}

export function toolResultText(outcome: ToolOutcome): string {
  switch (outcome.outcome) {
    case "result":
      return outcome.output;
    case "error":
      return failureText(outcome.code, outcome.message);
    case "unknown":
      return failureText(outcome.code, outcome.message);
    case "cancelled":
      return "";
    default: {
      const _never: never = outcome;
      return String(_never);
    }
  }
}

export function toolResultOutcome(outcome: ToolOutcome): ToolResultOutcome {
  switch (outcome.outcome) {
    case "result":
      return "succeeded";
    case "error":
      return "failed";
    case "unknown":
      return "unknown";
    case "cancelled":
      return "cancelled";
    default: {
      const _never: never = outcome;
      return _never;
    }
  }
}

/**
 * Output is bounded, never rejected as a tool failure: truncation is reported
 * through metadata so the model can see it was cut.
 *
 * Three properties are load-bearing, and the second was missing until a review
 * measured it:
 *
 * - **Code points, not code units.** The version before that shrank a prefix by
 *   10% at a time until it fit, which lands between the two halves of a
 *   surrogate pair and leaves a `U+FFFD` spliced into the middle of a token the
 *   model will quote back.
 * - **Both ends, not just the head.** A command's outcome is at the *end*:
 *   `shell-tool.ts` writes the `[stderr]` block and the failure advisory last,
 *   and the adapters' truncation module exists for the same reason ("a build log's
 *   last line is the error"). A head-only bound destroyed precisely those bytes at
 *   the loop, even when the adapter had carefully preserved them — the bound and
 *   the adapter were pulling in opposite directions.
 *
 * The byte primitive itself (`cutToBytes`) is **not** written here: it lives in
 * `protocol/text-cut.ts` so this file and `adapters/**` share one rule instead of
 * two copies that happen to agree. `loop/**` may not import `adapters/**` (the
 * boundary scan rejects `adapters` by name), and `protocol/**` is a layer both
 * sides already import. The even head/tail split below is this file's own policy
 * and stays here; only "cut without breaking a character" is shared.
 */
export function boundToolOutput(
  output: string,
  alreadyTruncated: boolean,
): { output: string; truncated: boolean } {
  return boundToolText(output, alreadyTruncated, MAX_TOOL_OUTPUT_BYTES);
}

function boundToolText(output: string, alreadyTruncated: boolean, maximumBytes: number): { output: string; truncated: boolean } {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= maximumBytes) {
    return { output, truncated: alreadyTruncated };
  }

  const marker = cutToBytes("\n[truncated]\n", maximumBytes);
  const budget = maximumBytes - Buffer.byteLength(marker, "utf8");
  // Half to each end, then whatever the head did not use goes to the tail, so the
  // result is always within the bound whatever the head's character widths were.
  const head = cutToBytes(output, Math.ceil(budget / 2));
  const tail = tailWithin(output, budget - Buffer.byteLength(head, "utf8"));

  return { output: `${head}${marker}${tail}`, truncated: true };
}

/**
 * The largest suffix of `text` fitting `maxBytes` without splitting a character.
 *
 * The mirror of `cutToBytes`, which only cuts prefixes — a truncation that
 * keeps the tail has to measure it from the end.
 */
function tailWithin(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }

  let start = buffer.length - maxBytes;

  while (start < buffer.length) {
    const byte = buffer[start];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    start += 1;
  }

  return buffer.subarray(start).toString("utf8");
}

/**
 * The two halves of `runToolFor`, split so a batch can run them apart
 * (WP22.1 / C05).
 *
 * A batch runs its calls concurrently but must settle them in a fixed order —
 * "concurrency is about *when* the work happens, never about the order it is
 * recorded in" (`domain/tool-batch.ts`). That is only possible if the half that
 * talks to the tool and the half that writes into the turn are separate calls:
 * every member executes under the gate, then each result is written in its turn.
 *
 * `runToolFor` below is exactly the two of them in sequence, so the single-call
 * path is unchanged.
 */
export async function executeToolOnly(
  tools: ToolPort,
  call: ToolExecutionCall,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const request: ToolCallRequest = {
    toolCallId: call.toolCallId,
    name: call.name,
    arguments: call.arguments,
  };
  return await executeToolSafely(tools, request, signal);
}

export async function settleToolOutcome(
  host: ToolExecutionHost,
  call: ToolExecutionCall,
  outcome: ToolOutcome,
): Promise<void> {
  const bounded = outcome.outcome === "result"
    // Text owns its existing output bound; the emitter's lossless public
    // frames own combined value/text serialization and the physical frame cap.
    ? boundToolOutput(outcome.output, outcome.truncated)
    : boundToolOutput(toolResultText(outcome), false);

  host.recordResult({
    toolCallId: call.toolCallId,
    name: call.name,
    output: bounded.output,
    truncated: bounded.truncated,
    outcome: toolResultOutcome(outcome),
    ...(outcome.outcome === "result" && outcome.images !== undefined ? { images: outcome.images } : {}),
  });

  if (outcome.outcome === "result") {
    // Only a reported success may claim bytes landed on disk.
    emitFileWriteRecord(host.emit, call.toolCallId, call.name, outcome.value);
    // The same gate feeds the turn's net diff (WP11/C20): previews only
    // exist on success values, and only success may extend the diff.
    host.noteTurnDiff?.(call.name, outcome.value);
  }

  if (outcome.outcome === "unknown") {
    // An adapter that threw is not the same claim as a tool that ran and
    // failed: the journal keeps the distinction so a later reader is not told
    // a process ran when in fact nothing was ever observed.
    host.emit("observation", {
      component: "tool_execute",
      status: "unknown",
      toolCallId: call.toolCallId,
      message: failureText(outcome.code, outcome.message),
    });
  }

  await host.dispatch(settledInput(host, call.toolCallId, outcome, bounded));
}

export async function runToolFor(
  host: ToolExecutionHost,
  tools: ToolPort,
  call: ToolExecutionCall,
  signal: AbortSignal,
): Promise<void> {
  await settleToolOutcome(host, call, await executeToolOnly(tools, call, signal));
}

function settledInput(
  host: ToolExecutionHost,
  toolCallId: string,
  outcome: ToolOutcome,
  bounded: { readonly output: string; readonly truncated: boolean },
): ReduceInput {
  const eventId = host.nextEventId();
  switch (outcome.outcome) {
    case "result":
      return { type: "tool_succeeded", eventId, toolCallId, value: outcome.value, ...bounded };
    case "error":
      return {
        type: "tool_failed",
        eventId,
        toolCallId,
        message: failureText(outcome.code, outcome.message),
      };
    case "unknown":
      return {
        type: "tool_unknown",
        eventId,
        toolCallId,
        message: failureText(outcome.code, outcome.message),
      };
    case "cancelled":
      return { type: "tool_cancelled", eventId, toolCallId };
    default: {
      const _never: never = outcome;
      return _never;
    }
  }
}
