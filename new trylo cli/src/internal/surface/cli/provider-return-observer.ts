import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import {
  isNormalProviderReturnObservation, isProviderWaitObservation, providerWaitObservationHash,
  type NormalProviderReturnObservation, type ProviderWaitObservation,
} from "../../learning/central/runtime/provider-positive.js";
import { identity } from "../../validation/json-shape.js";

/** One normal parent turn; forked children retain their original unobserved provider. */
export function createParentProviderReturnObserver(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerWaitObservation?: ProviderWaitObservation;
}) {
  const capture = captureFor(input);
  let returned: NormalProviderReturnObservation | undefined;
  let latest: object | undefined;
  let activeSignal: AbortSignal | undefined;

  return {
    capture,
    read: (): NormalProviderReturnObservation | undefined => activeSignal?.aborted ? undefined : returned,

    wrap(provider: ProviderPort): ProviderPort {
      if (capture === undefined) return provider;
      return { ...provider, async *stream(request, signal) {
        const attempt = {};

        latest = attempt;
        activeSignal = signal;
        returned = undefined;
        let invalid = false;
        let accepted = false;
        let enabled = false;
        let observedRequest = request;

        try {
          enabled = request.model === capture.model && identity(request.attemptId);
          if (enabled) observedRequest = { ...request, observeReturn: true };
        } catch { invalid = true; }

        try {
          for await (const event of provider.stream(observedRequest, signal)) {
            try {
              if (event.type === "text_delta" && event.text.trim().length > 0) accepted = true;

              if (event.type === "tool_call") {
                if (identity(event.toolCallId) && request.tools.some(tool => tool.name === event.name)
                  && typeof event.arguments === "object" && event.arguments !== null && !Array.isArray(event.arguments)) accepted = true;
                else invalid = true;
              }

              if (isFailedObservation(event)) invalid = true;

              if (latest === attempt) {
                if (invalid || signal.aborted) returned = undefined;
                else if (enabled && accepted && event.type === "finish" && event.returnObservation?.schemaVersion === 1
                  && (event.reason === "stop" || event.reason === "tool_calls")) {
                  const candidate: NormalProviderReturnObservation = {
                    schemaVersion: 1, captureHash: providerWaitObservationHash(capture),
                    attemptId: request.attemptId, model: request.model, finishReason: event.reason,
                    reportedTotalTokens: event.returnObservation.reportedTotalTokens,
                  };
                  returned = isNormalProviderReturnObservation(candidate) ? candidate : undefined;
                }
              }
            } catch {
              invalid = true;
              if (latest === attempt) returned = undefined;
            }
            yield event;
          }
        } catch (error) {
          if (latest === attempt) returned = undefined;
          throw error;
        } finally {
          if (signal.aborted && latest === attempt) returned = undefined;
        }
      } };
    },
  };
}

function isFailedObservation(event: ProviderEvent): boolean {
  return event.type === "error" || event.type === "cancel_ack" || event.type === "raw_unknown"
    || event.type === "tool_call_invalid" || event.type === "warning" && event.code === "stream_finish_tail_timeout"
    || event.type === "finish" && event.reason !== "stop" && event.reason !== "tool_calls";
}

function captureFor(input: { readonly sessionId: string; readonly turnId: string; readonly providerWaitObservation?: ProviderWaitObservation }): ProviderWaitObservation | undefined {
  try {
    const value: unknown = input.providerWaitObservation;
    if (!isProviderWaitObservation(value) || value.sessionId !== input.sessionId || value.turnId !== input.turnId) return undefined;
    return { ...value, wait: { ...value.wait } };
  } catch { return undefined; }
}
