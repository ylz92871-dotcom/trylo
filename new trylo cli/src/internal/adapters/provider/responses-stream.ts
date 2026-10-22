import type { ProviderEvent } from "../../ports/provider.js";
import { createResponsesTranslator } from "./responses-translate.js";
import { coalesceDeltas, type CoalesceEvent } from "./coalesce-deltas.js";
import { isDoneFrame, parseSseFrames, type SseFrame } from "./sse.js";

/**
 * Responses SSE body -> ProviderEvent (WP18.2: C68 transport half).
 *
 * The loop mirrors `openai-stream.ts` with one deliberate difference: no
 * finish is held back for trailing usage, because on this wire the usage
 * arrives *inside* `response.completed`, ahead of the finish the translator
 * emits for it. Everything else — `[DONE]` stops, an interrupted body is
 * `after_stream_started` unknown-state, an empty stream is a protocol error —
 * is the same contract, stated once per wire so a drift is a visible diff.
 */
export async function* translateResponsesBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const reader = body.getReader();
  yield* coalesceDeltas(decodeResponsesBody(reader, signal), async () => {
    try {
      await reader.cancel();
    } catch {
      /* A just-completed read may already have released the lock. */
    }
  });
}

async function* decodeResponsesBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<CoalesceEvent> {
  const translator = createResponsesTranslator();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawAny = false;
  let bodyClosed = false;
  try {
    stream: for (;;) {
      const step = await reader.read();
      if (step.done === true) {
        bodyClosed = true;
        break;
      }
      const text = decoder.decode(step.value, { stream: true });
      const parsed = parseSseFrames(text, buffer);
      buffer = parsed.buffer;
      for (const frame of parsed.frames) {
        if (isDoneFrame(frame)) {
          break stream;
        }
        for (const event of translateResponsesFrame(translator, frame)) {
          sawAny = true;
          yield event;
          if (event.type === "finish" || event.type === "error" || event.type === "cancel_ack") return;
        }
      }
    }
  } catch {
    bodyClosed = true;
    // Past headers: an interrupted body is unknown-state, not retryable.
    yield {
      type: "error",
      class: signal.aborted ? "cancelled" : "network",
      retryable: false,
      phase: "after_stream_started",
      message: signal.aborted ? "cancelled" : "stream_interrupted",
    };
    return;
  } finally {
    try {
      if (!bodyClosed) {
        try {
          await reader.cancel();
        } catch (error) {
          const abortedRead = signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
          if (!abortedRead) throw error;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!sawAny) {
    yield {
      type: "error",
      class: "protocol",
      retryable: false,
      phase: "after_stream_started",
      message: "empty_stream",
    };
    return;
  }
  yield* translator.complete();
}

function translateResponsesFrame(
  translator: ReturnType<typeof createResponsesTranslator>,
  frame: SseFrame,
): ProviderEvent[] {
  try {
    const payload: unknown = JSON.parse(frame.data);
    return translator.push(frame.event, payload);
  } catch {
    return [
      {
        type: "raw_unknown",
        wire: "sse.unparseable",
        metadata: { bytes: frame.data.length },
      },
    ];
  }
}
