import { emptyUsage, mergeUsage, type ProviderEvent, type ProviderPort, type ProviderRequest, type ProviderUsage } from "../../ports/provider.js";
import type { LearningUsageBoundary } from "../../learning/control/usage-settlement.js";
import { systemTimerScheduler, type TimerHandle, type TimerScheduler } from "../../subagent/scheduler.js";
import { ContentModelError } from "./model-contract.js";

export interface ContentModelStreamResult {
  readonly text: string;
  readonly usage: ProviderUsage;
  readonly reported: boolean;
  readonly boundary: LearningUsageBoundary;
  readonly reason?: string;
}

interface StreamInput {
  readonly provider: ProviderPort;
  readonly request: ProviderRequest;
  readonly maxTokens: number;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
  readonly enabled: () => boolean;
  readonly scheduler?: TimerScheduler;
}

function validUsage(value: ProviderUsage): boolean {
  return (value.mode === "snapshot" || value.mode === "delta")
    && [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens, value.totalTokens]
      .every(item => Number.isSafeInteger(item) && item >= 0)
    && value.totalTokens >= value.inputTokens + value.outputTokens;
}

async function nextBeforeAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new ContentModelError("content_model_cancelled");

  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new ContentModelError("content_model_cancelled"));
    signal.addEventListener("abort", stop, { once: true });
  });

  try { return await Promise.race([iterator.next(), stopped]); }
  finally { if (stop !== undefined) signal.removeEventListener("abort", stop); }
}

/** Drain the real usage tail before success. Only an explicit caller deadline
 * arms a timer; local abort never proves that remote work stopped. */
export async function readContentModelStream(input: StreamInput): Promise<ContentModelStreamResult> {
  const controller = new AbortController(), abort = () => controller.abort(input.signal.reason);

  input.signal.addEventListener("abort", abort, { once: true });
  let usage = emptyUsage(), reported = false, text = "", finish: Extract<ProviderEvent, { type: "finish" }> | undefined;
  let reason: string | undefined, tailIncomplete = false, overrun = false, timedOut = false, exhausted = false;
  let iterator: AsyncIterator<ProviderEvent> | undefined;
  let timer: TimerHandle | undefined;

  try {
    if (input.timeoutMs !== undefined) timer = (input.scheduler ?? systemTimerScheduler)(input.timeoutMs, () => {
      timedOut = true;
      controller.abort("content_model_timeout");
    });

    if (input.signal.aborted || !input.enabled()) controller.abort();

    iterator = input.provider.stream(input.request, controller.signal)[Symbol.asyncIterator]();

    for (;;) {
      const next = await nextBeforeAbort(iterator, controller.signal);
      if (next.done) {
        exhausted = true;
        break;
      }

      const event = next.value;
      if (controller.signal.aborted || !input.enabled() || event.type === "cancel_ack") {
        reason = "content_model_cancelled";
        controller.abort();
        break;
      }

      if (event.type === "usage") {
        if (!validUsage(event.usage)) {
          reason = "content_model_usage_invalid";
          break;
        }
        usage = mergeUsage(usage, event.usage);
        reported = true;
        if (!validUsage(usage)) {
          reason = "content_model_usage_invalid";
          break;
        }
        if (usage.totalTokens > input.maxTokens) {
          overrun = true;
          reason = "content_model_token_overrun";
          break;
        }
        continue;
      }

      if (event.type === "warning") {
        if (event.code === "stream_finish_tail_timeout") tailIncomplete = true;
        continue;
      }

      if (event.type === "error") {
        reason = `content_model_provider_${event.class}`;
        break;
      }

      if (event.type === "finish") {
        if (finish !== undefined) {
          reason = "content_model_duplicate_finish";
          break;
        }
        finish = event;
        continue;
      }

      if (finish !== undefined) {
        reason = "content_model_post_finish_event";
        break;
      }

      if (["tool_input_start", "tool_input_delta", "tool_input_end", "tool_call", "tool_call_invalid"].includes(event.type)) {
        reason = "content_model_tool_forbidden";
        break;
      }

      if (event.type === "text_delta") text += event.text;

      if (text.length > 65536) {
        reason = "content_model_output_limit";
        break;
      }
    }

    if (!exhausted || finish?.reason !== "stop" || finish.requiresFollowUp) reason ??= "content_model_incomplete";
  } catch {
    reason ??= input.signal.aborted || !input.enabled() ? "content_model_cancelled"
      : timedOut ? "content_model_timeout" : "content_model_transport_failed";
  } finally {
    try { timer?.cancel(); }
    catch { reason ??= "content_model_cleanup_failed"; }

    input.signal.removeEventListener("abort", abort);
    controller.abort();

    // A transport ignoring abort may also ignore return(). Cleanup is best-effort and
    // must not delay conservative settlement or turn an unknown request into success.
    if (!exhausted && iterator?.return !== undefined) {
      try { void iterator.return().catch(() => undefined); }
      catch { reason ??= "content_model_cleanup_failed"; }
    }
  }

  const boundary: LearningUsageBoundary = overrun ? { kind: "overrun" }
    : reason !== undefined ? { kind: "unknown", reason }
      : tailIncomplete ? { kind: "unknown", reason: "provider_usage_tail_incomplete" }
        : !reported ? { kind: "unknown", reason: "content_model_usage_absent" } : { kind: "complete" };

  return { text, usage, reported, boundary, ...(reason === undefined ? {} : { reason }) };
}
