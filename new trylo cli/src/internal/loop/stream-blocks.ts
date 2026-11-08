import type { ReduceInput } from "../domain/input.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import type { CompleteInputTokenObservation, ProviderEvent, ProviderUsage } from "../ports/provider.js";
import type { StreamPartial, StreamPartials } from "../protocol/stream-partial.js";
import { emptyUsage } from "../ports/provider.js";
import type { BudgetRejection } from "./budget-recovery.js";
import type { ToolArgumentNormalizer } from "./tool-boundary.js";

/**
 * Block assembly for one provider stream.
 *
 * The reducer only ever receives *closed* facts, so everything that can be
 * half-finished on the wire is finished here: a text block becomes a transcript
 * item at `text_end`, a reasoning block at `reasoning_end`, and a tool call at
 * the moment its arguments are complete. Argument JSON is parsed exactly once,
 * at that close point, and a parse failure becomes an explicit event instead of
 * an exception — a model that emits `{` and stops is a fact about the turn, not
 * a crash in the loop.
 *
 * One accumulator per stream, mutated only by the functions in this file. They
 * are split by block family rather than by event type so each family's invariant
 * is readable in one place:
 *
 *  - text and reasoning are *append until end*, and an empty block produces
 *    nothing (a provider that opens and closes a block without content is not
 *    owed a transcript item);
 *  - tool input is *append until end, then parse once*, with a hard character
 *    ceiling so a runaway argument stream cannot grow memory without bound;
 *  - `tool_call` is the adapter's own parsed result and therefore authoritative:
 *    it discards any fragments for the same id, because an adapter may close a
 *    call via `tool_input_end`, via `tool_call`, or via both, and the reducer
 *    must see the call exactly once.
 *
 * The optional `normalize` is applied at these two close points and nowhere
 * else, so the arguments the transcript records and the arguments the tool is
 * handed are the *same object* — a provider whose wrapper is unwrapped for
 * execution but left in the history would keep showing the model its own
 * wrapped call and keep reproducing it. Absent means identity, byte for byte.
 */

/**
 * Ceiling on one tool call's raw argument text. Fragments past it are dropped
 * rather than buffered; the call still closes, with whatever was kept.
 */
export const TOOL_ARGUMENT_CHAR_LIMIT = 1 << 20;

export type OpenToolInput = {
  readonly name: string;
  text: string;
};

export type OpenReasoningBlock = {
  text: string;
  redacted: boolean;
};

export type StreamAccumulator = {
  readonly inputs: ReduceInput[];
  readonly transcriptItems: TranscriptItem[];
  readonly toolInputs: Map<string, OpenToolInput>;
  /** Tool calls already handed to the reducer, by id. Guarantees exactly once. */
  readonly emittedToolCalls: Set<string>;
  readonly textBlocks: Map<string, string>;
  readonly reasoningBlocks: Map<string, OpenReasoningBlock>;
  usage: ProviderUsage;
  /** Request-local provenance; never merged into financial usage. */
  inputTokenObservation?: CompleteInputTokenObservation;
  sequence: number;
  sawFinish: boolean;
  sawError: boolean;
  sawUnknown: boolean;
  /**
   * Whether this stream ever emitted `stream_start`.
   *
   * It is the one fact that separates "the model accepted this request" from
   * "we tried to reach it": a provider that throws, is cancelled, or disconnects
   * *before* `stream_start` never fielded the slot, so the loop must not record a
   * method exposure (ME0-2). Tracked here rather than inferred from `sawFinish`
   * because a post-start failure (F03) still fielded — it saw a start and then an
   * error, and that is a real send that failed mid-flight.
   */
  sawStreamStart: boolean;
  /**
   * The provider's own budget refusal, when this stream carried one
   * (WP09.3/L06). Classified from the first matching `error` event; the loop
   * reads it to decide between one compaction retry and a reported failure.
   * Undefined for every other failure shape.
   */
  budgetRejection?: BudgetRejection;
};

export function createStreamAccumulator(startSequence: number): StreamAccumulator {
  return {
    inputs: [],
    transcriptItems: [],
    toolInputs: new Map(),
    emittedToolCalls: new Set(),
    textBlocks: new Map(),
    reasoningBlocks: new Map(),
    usage: emptyUsage("snapshot"),
    sequence: startSequence,
    sawFinish: false,
    sawError: false,
    sawUnknown: false,
    sawStreamStart: false,
  };
}

type TextBlockEvent = Extract<ProviderEvent, { readonly type: "text_start" | "text_delta" | "text_end" }>;

type ReasoningBlockEvent = Extract<
  ProviderEvent,
  { readonly type: "reasoning_start" | "reasoning_delta" | "reasoning_end" }
>;

type ToolInputEvent = Extract<
  ProviderEvent,
  { readonly type: "tool_input_start" | "tool_input_delta" | "tool_input_end" }
>;

type ToolCallEvent = Extract<ProviderEvent, { readonly type: "tool_call" }>;

type ToolCallInvalidEvent = Extract<ProviderEvent, { readonly type: "tool_call_invalid" }>;

export function applyTextBlock(acc: StreamAccumulator, event: TextBlockEvent): void {
  switch (event.type) {
    case "text_start":
      acc.textBlocks.set(event.blockId, "");
      return;
    case "text_delta": {
      const current = acc.textBlocks.get(event.blockId) ?? "";
      acc.textBlocks.set(event.blockId, current + event.text);
      return;
    }
    case "text_end": {
      const text = acc.textBlocks.get(event.blockId);

      acc.textBlocks.delete(event.blockId);

      if (text !== undefined && text.length > 0) {
        acc.transcriptItems.push({
          kind: "assistant_text",
          sequence: acc.sequence++,
          blockId: event.blockId,
          text,
        });
      }

      return;
    }
  }
}

export function applyReasoningBlock(acc: StreamAccumulator, event: ReasoningBlockEvent): void {
  switch (event.type) {
    case "reasoning_start":
      acc.reasoningBlocks.set(event.blockId, { text: "", redacted: event.redacted });
      return;
    case "reasoning_delta": {
      const block = acc.reasoningBlocks.get(event.blockId) ?? { text: "", redacted: event.redacted };
      acc.reasoningBlocks.set(event.blockId, {
        text: block.text + event.text,
        redacted: block.redacted || event.redacted,
      });
      return;
    }
    case "reasoning_end": {
      const block = acc.reasoningBlocks.get(event.blockId);

      acc.reasoningBlocks.delete(event.blockId);

      if (block !== undefined && block.text.length > 0) {
        acc.transcriptItems.push({
          kind: "assistant_reasoning",
          sequence: acc.sequence++,
          blockId: event.blockId,
          text: block.text,
          redacted: block.redacted,
        });
      }

      return;
    }
  }
}

export function applyToolInput(
  acc: StreamAccumulator,
  event: ToolInputEvent,
  eventId: string,
  normalize?: ToolArgumentNormalizer,
): void {
  switch (event.type) {
    case "tool_input_start":
      acc.toolInputs.set(event.toolCallId, { name: event.name, text: "" });
      return;
    case "tool_input_delta": {
      const open = acc.toolInputs.get(event.toolCallId);
      if (open !== undefined && open.text.length < TOOL_ARGUMENT_CHAR_LIMIT) {
        open.text += event.argumentsText;
      }
      return;
    }
    case "tool_input_end":
      closeToolInput(acc, event.toolCallId, eventId, normalize);
      return;
  }
}

/**
 * Closes one tool call whose arguments arrived as fragments.
 *
 * Three outcomes, all explicit: the arguments parse into an object (a
 * `tool_request`), they parse into something else or fail to parse (a
 * `tool_arguments_invalid` input, so the turn can report it), or the call was
 * already emitted (nothing — exactly once wins over completeness).
 *
 * An empty argument stream is read as `{}`: a tool with no parameters is the
 * common case and a provider that sends no deltas is not sending a parse error.
 */
function closeToolInput(
  acc: StreamAccumulator,
  toolCallId: string,
  eventId: string,
  normalize?: ToolArgumentNormalizer,
): void {
  const open = acc.toolInputs.get(toolCallId);
  if (open === undefined || acc.emittedToolCalls.has(toolCallId)) {
    return;
  }

  acc.toolInputs.delete(toolCallId);
  const raw = open.text.trim().length === 0 ? "{}" : open.text;
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    applyToolCallInvalid(acc, { type: "tool_call_invalid", toolCallId, name: open.name, rawArguments: "", message: "invalid_arguments" }, eventId);
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    applyToolCallInvalid(acc, { type: "tool_call_invalid", toolCallId, name: open.name, rawArguments: "", message: "invalid_arguments:not_object" }, eventId);
    return;
  }

  const args = parsed as JsonObject;

  applyToolCall(acc, { type: "tool_call", toolCallId, name: open.name, arguments: args }, eventId, normalize);
}

export function applyToolCall(
  acc: StreamAccumulator,
  event: ToolCallEvent,
  eventId: string,
  normalize?: ToolArgumentNormalizer,
): void {
  // Adapter already parsed: its result is authoritative, drop fragments.
  acc.toolInputs.delete(event.toolCallId);

  if (acc.emittedToolCalls.has(event.toolCallId)) {
    return;
  }

  acc.emittedToolCalls.add(event.toolCallId);
  const args = normalize === undefined ? event.arguments : normalize(event.name, event.arguments);

  acc.inputs.push({
    type: "tool_request",
    eventId,
    toolCallId: event.toolCallId,
    name: event.name,
    arguments: args,
    needsApproval: false,
  });
  acc.transcriptItems.push({
    kind: "tool_call",
    sequence: acc.sequence++,
    toolCallId: event.toolCallId,
    name: event.name,
    arguments: args,
    ...(args === event.arguments ? {} : { originalArguments: event.arguments }),
  });
}

export function applyToolCallInvalid(
  acc: StreamAccumulator,
  event: ToolCallInvalidEvent,
  eventId: string,
): void {
  acc.toolInputs.delete(event.toolCallId);

  if (acc.emittedToolCalls.has(event.toolCallId)) return;

  acc.emittedToolCalls.add(event.toolCallId);
  acc.inputs.push({
    type: "tool_arguments_invalid",
    eventId,
    toolCallId: event.toolCallId,
    name: event.name,
    message: event.message,
  });
  // The reducer emits the failed journal event; this assembler owns the
  // closed conversation feedback. Both parsed and fragment paths use it once.
  const output = event.message.startsWith("invalid_arguments") ? event.message : `invalid_arguments:${event.message}`;

  acc.transcriptItems.push({ kind: "tool_result", sequence: acc.sequence++, toolCallId: event.toolCallId, name: event.name, output, truncated: false, outcome: "failed" });
}

/**
 * Every block this stream has opened and not yet closed, as partials.
 *
 * Read after each event by the consumer that persists them, which is what makes
 * a killed process leave the received text on disk rather than losing it. A
 * block that closed is no longer here — it became a transcript item — so this
 * is precisely the set of blocks that would otherwise vanish.
 *
 * Tool inputs are included, and that is the point: their fragments are the one
 * kind of partial that looks most like an action. Preserving them records that
 * a call was *being* made; it deliberately does not make it one.
 */
export function openPartials(acc: StreamAccumulator): StreamPartials {
  const partials: StreamPartial[] = [];

  for (const [blockId, text] of acc.textBlocks) {
    partials.push({ kind: "assistant_text", blockId, text });
  }

  for (const [blockId, block] of acc.reasoningBlocks) {
    partials.push({ kind: "assistant_reasoning", blockId, text: block.text, redacted: block.redacted });
  }

  for (const [blockId, open] of acc.toolInputs) {
    partials.push({ kind: "tool_input", blockId, text: open.text, name: open.name });
  }

  return partials;
}

/** A cheap identity for "did the open blocks change since the last write?" */
export function partialsDigest(partials: StreamPartials): string {
  // JSON rather than a hand-rolled delimiter: a partial can contain any
  // byte the model produced, so a separator chosen from the printable range
  // is a separator a chunk can forge.
  return JSON.stringify(partials);
}
