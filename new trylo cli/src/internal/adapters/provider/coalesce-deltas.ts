import type { ProviderEvent } from "../../ports/provider.js";

type Delta = Extract<
  ProviderEvent,
  { type: "text_delta" | "reasoning_delta" | "tool_input_delta" }
>;

const CHUNK_CHARACTERS = 128;
const FLUSH_DELAY_MS = 40;

/** Adapter-local boundary; never leaves the adapter as a public event. */
export type CoalesceEvent = ProviderEvent | { readonly type: "flush_deltas" };

/** Wire token boundaries are transport details, not separately retained facts. */
export async function* coalesceDeltas(
  events: AsyncIterable<CoalesceEvent>,
  cancelRead?: () => Promise<void>,
): AsyncGenerator<ProviderEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let next: Promise<IteratorResult<CoalesceEvent>> | undefined;
  let deadline: ReturnType<typeof flushDeadline> | undefined;
  let pending: Delta | undefined;
  let deliveredBlock: Delta | undefined;

  try {
    for (;;) {
      // Keep exactly one outstanding pull. A deadline can flush received bytes
      // while that pull is blocked on the provider; it must not start a second read.
      next ??= iterator.next();
      const step = await (deadline
        ? Promise.race([next, deadline.ready])
        : next);
      if (step === "flush") {
        deadline?.cancel();
        deadline = undefined;

        if (pending !== undefined) {
          const delta = pending;
          pending = undefined;
          yield delta;
        }

        continue;
      }

      next = undefined;

      if (step.done === true) break;

      const event = step.value;
      if (event.type === "flush_deltas") {
        deadline?.cancel();
        deadline = undefined;

        if (pending !== undefined) {
          yield pending;
          pending = undefined;
        }

        continue;
      }

      if (
        event.type !== "text_delta" &&
        event.type !== "reasoning_delta" &&
        event.type !== "tool_input_delta"
      ) {
        deadline?.cancel();
        deadline = undefined;

        if (pending !== undefined) {
          yield pending;
          pending = undefined;
        }

        yield event;

        if (
          event.type === "text_end" ||
          event.type === "reasoning_end" ||
          event.type === "tool_input_end"
        )
          deliveredBlock = undefined;

        continue;
      }

      if (pending !== undefined && !sameBlock(pending, event)) {
        deadline?.cancel();
        deadline = undefined;
        yield pending;
        pending = undefined;
      }

      if (deliveredBlock === undefined || !sameBlock(deliveredBlock, event)) {
        // Preserve immediate first-token feedback without making every network
        // packet a retained domain event.
        deliveredBlock = event;
        yield event;
        continue;
      }

      pending = pending === undefined ? event : joinDeltas(pending, event);
      const length =
        pending.type === "tool_input_delta"
          ? pending.argumentsText.length
          : pending.text.length;
      if (length >= CHUNK_CHARACTERS) {
        deadline?.cancel();
        deadline = undefined;
        yield pending;
        pending = undefined;
      } else {
        // Measured from the first buffered delta, never reset by later tokens.
        deadline ??= flushDeadline();
      }
    }
    if (pending !== undefined) yield pending;
  } finally {
    deadline?.cancel();
    // Returning after a timer flush can leave a network read in flight.
    // Cancel it before returning the iterator, whose return queues behind it.
    if (next !== undefined) await cancelRead?.();
    await iterator.return?.();
  }
}

function flushDeadline(): {
  readonly ready: Promise<"flush">;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout>;
  const ready = new Promise<"flush">((resolve) => {
    timer = setTimeout(() => resolve("flush"), FLUSH_DELAY_MS);
  });
  return { ready, cancel: () => clearTimeout(timer) };
}

function sameBlock(left: Delta, right: Delta): boolean {
  if (left.type === "tool_input_delta")
    return right.type === left.type && left.toolCallId === right.toolCallId;

  if (left.type === "reasoning_delta")
    return (
      right.type === left.type &&
      left.blockId === right.blockId &&
      left.redacted === right.redacted
    );

  return right.type === left.type && left.blockId === right.blockId;
}

function joinDeltas(left: Delta, right: Delta): Delta {
  if (left.type === "tool_input_delta" && right.type === left.type)
    return { ...left, argumentsText: left.argumentsText + right.argumentsText };

  if (left.type === "reasoning_delta" && right.type === left.type)
    return { ...left, text: left.text + right.text };

  if (left.type === "text_delta" && right.type === left.type)
    return { ...left, text: left.text + right.text };

  throw new Error("delta blocks must agree before joining");
}
