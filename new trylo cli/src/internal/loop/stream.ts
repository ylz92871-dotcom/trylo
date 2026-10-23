import type { ReduceInput } from "../domain/input.js";
import { assertExhaustive } from "../contract/index.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import type { StreamPartials } from "../protocol/stream-partial.js";
import type {
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ProviderUsage,
} from "../ports/provider.js";
import { mergeUsage } from "../ports/provider.js";
import { classifyBudgetRejection, type BudgetRejection } from "./budget-recovery.js";
import type { MethodChannel } from "./method-channel.js";
import { providerEventToInput } from "./provider-input.js";
import { transcriptToMessages } from "./transcript-messages.js";
import {
  applyReasoningBlock,
  applyTextBlock,
  applyToolCall,
  applyToolCallInvalid,
  applyToolInput,
  createStreamAccumulator,
  openPartials,
  partialsDigest,
  type StreamAccumulator,
} from "./stream-blocks.js";
import type { ToolArgumentNormalizer } from "./tool-boundary.js";
import { rejectedStreamToolResults } from "./stream-recovery.js";

/**
 * One provider stream, consumed once.
 *
 * This module owns the *shape* of the consumption: pull, classify, stop at a
 * terminal signal. Block assembly — turning fragments into closed facts — is
 * `stream-blocks.ts`, and the reducer only ever sees what that layer finished.
 *
 * Two rules are load-bearing here and are why the loop is short rather than
 * clever:
 *
 *  - A throwing adapter is a failure and must never look like a clean end, so
 *    `iterator.next()` is the only thing wrapped in `try`.
 *  - Nothing after `finish` / `error` / `cancel_ack` may be treated as model
 *    output, so the terminal check is the last statement of the body.
 */

export type StreamObservation = {
  readonly inputs: ReadonlyArray<ReduceInput>;
  readonly transcriptItems: ReadonlyArray<TranscriptItem>;
  readonly usage: ProviderUsage;
  /** Tool input blocks opened but never closed: the stream was cut. */
  readonly unsettledToolInputCount: number;
  readonly sawFinish: boolean;
  readonly sawError: boolean;
  readonly sawUnknown: boolean;
  /**
   * The provider's own budget refusal, when this stream carried one
   * (WP09.3/L06). Absent for every other failure shape.
   */
  readonly budgetRejection?: BudgetRejection;
  /**
   * Whether the stream ever reached `stream_start` — i.e. the model accepted
   * this request. The loop reads exactly this to decide whether a method slot was
   * really fielded (ME0-2): a throw/cancel/disconnect *before* start never
   * fielded, a failure *after* start did.
   */
  readonly sawStreamStart: boolean;
};

export type StreamContext = {
  readonly port: ProviderPort;
  readonly request: ProviderRequest;
  readonly signal: AbortSignal;
  readonly startSequence: number;
  readonly nextEventId: () => string;
  /**
   * The teaching channel for this beat, present only when this beat carries a
   * learning intent.
   *
   * It sits here because this loop is the one place both text consumers share:
   * `applyTextBlock` builds the `assistant_text` transcript item (what the next
   * request replays) and `providerEventToInput` feeds the journal `text` event
   * (what the terminal shows). Stripping at either consumer would leave the
   * other dirty, and stripping twice would be two rules to keep in sync.
   *
   * Absent means every event goes through untouched — one id per event, the
   * same allocation as a beat that never carried an intent — so "learning off"
   * and "learning on but nothing to say" are indistinguishable here by
   * construction.
   */
  readonly channel?: MethodChannel;
  /**
   * The second fence's stripper — the tool-gap self-report channel.
   *
   * It is a *separate* machine rather than a parameter of the first one (P05 tool
   * learning §2): the two fences only share the idea of what a fence looks like,
   * so changing the teaching fence can never silently change when a self-report
   * is stripped. `StreamRewriter` is the minimal shape this loop needs — each
   * channel keeps its own `take()`.
   *
   * Absent means text goes through exactly as it always has, so a run that never
   * heard of tool learning allocates the same event ids as one that did.
   */
  readonly toolGapChannel?: StreamRewriter;
  /**
   * The third fence's stripper — the method help-feedback channel (ME0-3).
   *
   * A *separate* machine again, for the same reason the tool-gap one is: the three
   * fences share only the idea of what a fence looks like, so changing when a
   * proposal is stripped can never silently change when a help self-report is
   * stripped. It is installed only when this beat actually fielded method cards
   * (receipts non-empty), so a beat with nothing to give feedback on allocates the
   * same event ids as one that never heard of method learning.
   */
  readonly feedbackChannel?: StreamRewriter;
  /**
   * How a provider's tool arguments are read before they become a fact.
   *
   * Applied at the moment a call closes, so the arguments the transcript keeps
   * and the arguments the tool is handed are the same object. Absent means the
   * identity — a caller that never heard of a wrapping provider allocates the
   * same inputs, with the same arguments, as before.
   */
  readonly normalizeArguments?: ToolArgumentNormalizer;
  /**
   * Committed exactly once, at the stream-consumption boundary of the first
   * `stream_start` (ME0-2 / audit P1-1).
   *
   * The fielding must land *while the stream is still open*, not after it ends:
   * the model has already accepted the request the moment `stream_start` arrives,
   * so a crash mid-stream must not lose an exposure that really happened. Awaiting
   * it here — before pulling the next event — is what makes the write durable at
   * that boundary rather than deferred to whatever runs after consumption returns.
   *
   * The loop keeps the single-terminal-state contract: this fires at most once
   * (a stream can only start once), and it never decides how the stream ends.
   * Absent means no fielding is committed, so a beat that never carried a method
   * slot consumes the stream exactly as it always has.
   */
  readonly onStreamStart?: () => void | Promise<void>;
  /** Closed canonical items are persisted before the next provider pull. */
  readonly onTranscriptItems?: (items: ReadonlyArray<TranscriptItem>) => Promise<void>;
  /**
   * Blocks that are open right now, persisted before the next provider pull.
   *
   * Awaited like `onTranscriptItems`: the consumer is not allowed to continue
   * pulling until what has already arrived is durable. That is the whole point
   * — persisting partials at stream end would only help a stream that ended,
   * and the case that loses work is the one that never got the chance.
   */
  readonly onPartial?: (partials: StreamPartials) => Promise<void>;
  /** Observe durable input while the connection is still open. Effects stay deferred. */
  readonly onInput?: (input: ReduceInput) => Promise<void>;
  readonly onWarning?: (warning: Extract<ProviderEvent, { type: "warning" }>) => void;
};

/** The one method this loop calls on a stripper; each channel owns its own take. */
export type StreamRewriter = {
  readonly rewrite: (event: ProviderEvent) => ReadonlyArray<ProviderEvent>;
};

export async function consumeProviderStream(context: StreamContext): Promise<StreamObservation> {
  const acc = createStreamAccumulator(context.startSequence);
  const iterator = context.port.stream(context.request, context.signal)[Symbol.asyncIterator]();
  try {
    await pullStream(context, acc, iterator);
  } finally {
    await releaseStream(iterator);
  }

  // A stream that ended without finish/error/cancel is a disconnect.
  if (!acc.sawFinish && !acc.sawError) {
    acc.inputs.push({
      type: "transport_unknown",
      eventId: context.nextEventId(),
      message: "disconnect",
    });
  }

  const discarded = rejectedStreamToolResults(acc.inputs, acc.transcriptItems);
  if (discarded.length > 0) {
    acc.transcriptItems.push(...discarded);
    await context.onTranscriptItems?.(discarded);
  }

  return {
    inputs: acc.inputs,
    transcriptItems: acc.transcriptItems,
    usage: acc.usage,
    unsettledToolInputCount: acc.toolInputs.size,
    sawFinish: acc.sawFinish,
    sawError: acc.sawError,
    sawUnknown: acc.sawUnknown,
    sawStreamStart: acc.sawStreamStart,
    ...(acc.budgetRejection === undefined ? {} : { budgetRejection: acc.budgetRejection }),
  };
}

type StreamIterator = AsyncIterator<ProviderEvent, unknown>;

/** Pull and persist one observed event before asking the provider for another. */
async function pullStream(context: StreamContext, acc: StreamAccumulator, iterator: StreamIterator): Promise<void> {
  let fieldingCommitted = false;
  let savedItems = 0;
  let notifiedInputs = 0;
  let savedPartials = partialsDigest(openPartials(acc));
  for (;;) {
    let step: IteratorResult<ProviderEvent, unknown>;
    try {
      step = await iterator.next();
    } catch {
      // A throwing adapter is a failure. It must never look like a clean end.
      acc.inputs.push({
        type: "transport_fail",
        eventId: context.nextEventId(),
        message: "provider_throw",
      });
      break;
    }
    if (step.done === true) {
      break;
    }
    const event = step.value;
    if (event.type === "warning") context.onWarning?.(event);
    // One raw event may become several, or none: a channel rewrites text into
    // the part meant for a reader and holds back the part meant for the board.
    // Non-text events come back exactly as they went in.
    for (const one of rewriteThrough(context, event)) {
      const eventId = context.nextEventId();
      applyEvent(acc, one, eventId, context.normalizeArguments);
      const mapped = providerEventToInput(one, eventId);
      if (mapped !== undefined) {
        acc.inputs.push(mapped);
      }
    }
    if (event.type === "finish" && !context.signal.aborted) bindCanonicalResponse(context, acc);
    if (acc.transcriptItems.length > savedItems) {
      await context.onTranscriptItems?.(acc.transcriptItems.slice(savedItems));
      savedItems = acc.transcriptItems.length;
    }
    // Whatever is still open is written before the next pull, so a process
    // killed between two events leaves the received text on disk. Only written
    // when an open block actually changed: an unchanged block has already been
    // made durable and re-appending it would write the same bytes again.
    const open = openPartials(acc);
    const digest = partialsDigest(open);
    if (digest !== savedPartials) {
      await context.onPartial?.(open);
      savedPartials = digest;
    }
    for (const input of acc.inputs.slice(notifiedInputs)) await context.onInput?.(input);
    notifiedInputs = acc.inputs.length;
    // Commit the fielding the instant the model accepts the request, while the
    // stream is still open (audit P1-1). Awaited here so the exposure is durable
    // before the next pull: a crash mid-stream cannot lose a start that happened.
    // Guarded so it fires at most once even though a stream yields many events.
    if (!fieldingCommitted && acc.sawStreamStart) {
      fieldingCommitted = true;
      await context.onStreamStart?.();
    }
    // Nothing after a terminal signal may be treated as model output.
    if (isTerminalEvent(event) || context.signal.aborted) {
      break;
    }
  }
}

/** Only this response's trusted public projection may rebind adapter state.
 * The adapter has already captured finish; the recorder has not persisted the
 * corresponding stream_end yet. No work or allocation is added without a channel.
 */
function bindCanonicalResponse(context: StreamContext, acc: StreamAccumulator): void {
  if (context.channel === undefined && context.toolGapChannel === undefined && context.feedbackChannel === undefined) return;
  const scope = context.request.continuationScope;
  if (scope === undefined || context.port.continuation?.bindCanonicalResponse === undefined) return;
  const message = transcriptToMessages(acc.transcriptItems).find(item => item.role === "assistant");
  if (message !== undefined) context.port.continuation.bindCanonicalResponse({ scope, message });
}

/** A write failure must release the iterator too; it cannot strand a socket. */
async function releaseStream(iterator: StreamIterator): Promise<void> {
  try {
    await iterator.return?.(undefined);
  } catch {
    // A failed release cannot change what was already observed; the socket
    // is left to the runtime, and the transcript stands.
  }
}

/**
 * One event, one accumulator mutation. The `usage` / `finish` / `error` /
 * `raw_unknown` cases stay inline because each is a single assignment; the
 * block families are delegated because each is an assembly rule of its own.
 */
function applyEvent(
  acc: StreamAccumulator,
  event: ProviderEvent,
  eventId: string,
  normalize?: ToolArgumentNormalizer,
): void {
  switch (event.type) {
    case "text_start":
    case "text_delta":
    case "text_end":
      applyTextBlock(acc, event);
      return;
    case "reasoning_start":
    case "reasoning_delta":
    case "reasoning_end":
      applyReasoningBlock(acc, event);
      return;
    case "tool_input_start":
    case "tool_input_delta":
    case "tool_input_end":
      applyToolInput(acc, event, eventId, normalize);
      return;
    case "tool_call":
      applyToolCall(acc, event, eventId, normalize);
      return;
    case "tool_call_invalid":
      applyToolCallInvalid(acc, event, eventId);
      return;
    case "usage":
      acc.usage = mergeUsage(acc.usage, event.usage);
      return;
    case "finish":
      acc.sawFinish = true;
      return;
    case "error":
      acc.sawError = event.class !== "cancelled";
      // A provider that names the refusal — prompt too long, media too large —
      // gives the loop its one honest recovery option; classified here so the
      // observation carries it whether or not anything else survives the stream.
      if (acc.budgetRejection === undefined) {
        const classified = classifyBudgetRejection(event.class, event.message);
        if (classified !== undefined) {
          acc.budgetRejection = classified;
        }
      }
      return;
    case "raw_unknown":
      acc.sawUnknown = true;
      return;
    case "stream_start":
      // The model accepted this request. The loop reads this (via the returned
      // observation) to record a real method fielding — never inferred, never
      // from `finish`, so a post-start failure still counts as fielded.
      acc.sawStreamStart = true;
      return;
    case "warning":
    case "cancel_ack":
      return;
    default: {
      assertExhaustive(event);
      return;
    }
  }
}

/**
 * Every registered stripper, in order, over one raw event.
 *
 * Chaining is safe because each machine is a prefix-consistent function of the
 * text it is given and only holds back text around *its own* marker: what the
 * first one lets through, the second one sees whole. With no stripper this is
 * the identity — the same array with the same object in it.
 */
function rewriteThrough(
  context: StreamContext,
  event: ProviderEvent,
): ReadonlyArray<ProviderEvent> {
  const first = context.channel === undefined ? [event] : context.channel.rewrite(event);
  const second = context.toolGapChannel;
  const throughSecond = second === undefined ? first : first.flatMap((one) => second.rewrite(one));
  const third = context.feedbackChannel;
  return third === undefined ? throughSecond : throughSecond.flatMap((one) => third.rewrite(one));
}

const isTerminalEvent = (event: ProviderEvent): boolean =>
  event.type === "finish" || event.type === "error" || event.type === "cancel_ack";
