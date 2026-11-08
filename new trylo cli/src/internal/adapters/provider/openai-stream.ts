import type { ProviderEvent } from "../../ports/provider.js";
import { coalesceDeltas, type CoalesceEvent } from "./coalesce-deltas.js";
import { createOpenAiTranslator } from "./openai-translate.js";
import { isDoneFrame, parseSseFrames, type SseFrame } from "./sse.js";
import { createOpenAiReturnObservation } from "./openai-return-observation.js";

/** Coalesce wire fragments without changing text, arguments, or block ordering. */
export async function* translateBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  observeReturn?: true,
): AsyncGenerator<ProviderEvent> {
  const reader = body.getReader();
  yield* coalesceDeltas(decodeBody(reader, signal, observeReturn), async () => {
    try {
      await reader.cancel();
    } catch {
      /* A just-completed read may already have released the lock. */
    }
  });
}

/** Hold finish for trailing usage, stop at [DONE], and release the HTTP reader. */
async function* decodeBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  observeReturn?: true,
): AsyncGenerator<CoalesceEvent> {
  const translator = createOpenAiTranslator();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawAny = false;
  let heldFinish: Extract<ProviderEvent, { type: "finish" }> | undefined;
  const observation = observeReturn === true ? createOpenAiReturnObservation() : undefined;
  let doneFrame = false;
  let finishDeadline: AbortSignal | undefined;
  let finishTailTimedOut = false;
  let bodyClosed = false;

  try {
    stream: for (;;) {
      const step = await readBeforeFinishDeadline(reader, finishDeadline);
      if (step === undefined) {
        finishTailTimedOut = true;
        break;
      }

      if (step.done === true) {
        bodyClosed = true;
        break;
      }

      const text = decoder.decode(step.value, { stream: true });
      const parsed = parseSseFrames(text, buffer);

      buffer = parsed.buffer;

      for (const frame of parsed.frames) {
        if (isDoneFrame(frame)) {
          doneFrame = true;
          break stream;
        }
        for (const event of translateFrame(translator, frame, observation)) {
          if (event.type === "finish" && heldFinish === undefined) {
            heldFinish = event;
            // Usage may trail finish, but an endpoint that keeps HTTP alive
            // must not leave the completed model turn looking like thinking.
            // This deadline never applies while the model is still generating.
            finishDeadline = AbortSignal.timeout(1_000);
            sawAny = true;
            continue;
          }

          // A malformed outer frame remains a safe protocol-gap marker even
          // in the accounting tail. Never deliver its original payload.
          if (heldFinish !== undefined && event.type !== "usage"
            && !(event.type === "raw_unknown" && event.wire === "sse.unparseable")) {
            continue;
          }

          sawAny = true;
          yield event;

          // Do not complete buffered tool fragments or accept later finish
          // frames after the endpoint has explicitly failed this response.
          if (event.type === "error") return;
        }
      }
      // The coalescer bounds later fragments by both content and time.
    }
  } catch (error) {
    bodyClosed = true;

    // Past headers: an interrupted body is unknown-state, not retryable.
    // A finish that already arrived still counts — the provider did conclude.
    if (heldFinish !== undefined) {
      yield heldFinish;
    }

    yield {
      type: "error",
      class: signal.aborted ? "cancelled" : "network",
      retryable: false,
      phase: "after_stream_started",
      message: signal.aborted ? "cancelled" : streamInterruptionMessage(error),
    };

    return;
  } finally {
    try {
      if (!bodyClosed) {
        try {
          await reader.cancel();
        } catch (error) {
          // Fetch may already have errored its body with this cancellation.
          // Still release the lock; unrelated cleanup failures must propagate.
          const abortedRead = signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
          if (!abortedRead) throw error;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  if (finishTailTimedOut) yield { type: "warning", code: "stream_finish_tail_timeout",
    message: "Provider finished but did not close its stream; usage includes only received frames." };

  if (heldFinish === undefined) {
    for (const event of translator.complete()) {
      sawAny = true;
      yield event;
    }
  } else {
    // The finish already closed everything the translator tracks, so there
    // is nothing left for complete() to settle — emitting it would only
    // invent block closures the loop never saw open.
    yield observation?.finish(heldFinish, !signal.aborted && !finishTailTimedOut
      && (doneFrame || bodyClosed) && buffer.trim().length === 0) ?? heldFinish;
  }

  if (!sawAny) {
    yield {
      type: "error",
      class: "protocol",
      retryable: false,
      phase: "after_stream_started",
      message: "empty_stream",
    };
  }
}

/** Retain a fixed transport code, never a raw exception, endpoint or header. */
function streamInterruptionMessage(error: unknown): string {
  const allowed = new Set(["UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
    "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE"]);
  let cause: unknown = error;

  for (let depth = 0; depth < 4 && typeof cause === "object" && cause !== null; depth++) {
    if ("code" in cause && typeof cause.code === "string" && allowed.has(cause.code)) return `stream_interrupted:${cause.code}`;
    cause = "cause" in cause ? cause.cause : undefined;
  }

  return "stream_interrupted";
}

async function readBeforeFinishDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> | undefined> {
  if (deadline === undefined) return reader.read();

  if (deadline.aborted) return undefined;

  let expire = () => {};
  const expired = new Promise<undefined>(resolve => { expire = () => resolve(undefined); });

  deadline.addEventListener("abort", expire, { once: true });

  try {
    return await Promise.race([reader.read(), expired]);
  } finally {
    deadline.removeEventListener("abort", expire);
    // On expiry the caller cancels the sole outstanding read before releasing
    // its lock. No second pull and no replay of a completed request.
  }
}

function translateFrame(
  translator: ReturnType<typeof createOpenAiTranslator>,
  frame: SseFrame,
  observation?: ReturnType<typeof createOpenAiReturnObservation>,
): ProviderEvent[] {
  try {
    const payload: unknown = JSON.parse(frame.data);
    const events = translator.push(payload);
    observation?.frame(payload, events);
    return events;
  } catch {
    observation?.frame(undefined, []);
    return [
      {
        type: "raw_unknown",
        wire: "sse.unparseable",
        metadata: { bytes: frame.data.length },
      },
    ];
  }
}
