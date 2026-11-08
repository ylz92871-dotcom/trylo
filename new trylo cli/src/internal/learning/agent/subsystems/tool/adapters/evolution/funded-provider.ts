import { emptyUsage, mergeUsage, type ProviderPort, type ProviderForkOptions, type ProviderRequest, type ProviderEvent } from "../../../../../../ports/provider.js";
import type { createToolLearningFunding } from "../../runtime/learning-funding.js";
import { toolLearningInputTokenEstimate } from "../../domain/evolution/learning-resources.js";
import { learningUsageSettlement, type LearningUsageBoundary } from "../../../../../control/usage-settlement.js";
import { maintainToolFundingLease } from "./funded-lease.js";

type Funding = ReturnType<typeof createToolLearningFunding>;

type Options = { readonly funding: Funding; readonly newId: () => string };

function fundingBoundaryError(message: string, phase: "inspect" | "reserve" | "finish_inspect" | "settle",
  failure: { readonly code: string } | { readonly reason: string }) {
  // Keep public error strings compatible while retaining the exact refusing
  // boundary and code. Store details can contain private paths and stay local.
  return new Error(message, { cause: { phase, code: "code" in failure ? failure.code : failure.reason } });
}

/** Every isolated planning/generation fork spends from the same Board grant. */
export function withToolLearningFunding(provider: ProviderPort, options: Options): ProviderPort {
  const wrapped: ProviderPort = {
    ...(provider.responseFormats === undefined ? {} : { responseFormats: provider.responseFormats }),
    ...(provider.continuation === undefined ? {} : { continuation: provider.continuation }),
    ...(provider.fork === undefined ? {} : { fork: (messages?: Parameters<NonNullable<ProviderPort["fork"]>>[0], forkOptions?: ProviderForkOptions) => {
      const child = provider.fork!(messages, forkOptions);
      return child === provider ? wrapped : withToolLearningFunding(child, options);
    } }),
    stream: (request, signal) => fundedStream(provider, request, signal, options),
  };
  return wrapped;
}

async function* fundedStream(provider: ProviderPort, request: ProviderRequest, signal: AbortSignal, options: Options): AsyncIterable<ProviderEvent> {
  if (signal.aborted) throw new Error("tool_learning_cancelled");

  const inspected = await options.funding.inspect();
  if (!inspected.ok) throw fundingBoundaryError(`tool_learning_funding:${inspected.code}`, "inspect", inspected);

  const promptChars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (promptChars > inspected.grant.allowance.maxPromptChars) throw new Error("tool_learning_prompt_limit");

  const overhead = provider.continuation?.estimateOverheadTokens?.(request.messages) ?? 0;
  // Admission estimate only. The Board charges actual total usage (or the full
  // reservation when unknown); a provider overrun closes that grant.
  const inputEstimate = toolLearningInputTokenEstimate(request.messages.map(message => message.content), overhead);
  const availableOutput = inspected.remaining.tokens - inputEstimate;
  const maxOutputTokens = request.maxOutputTokens === undefined ? undefined : Math.min(request.maxOutputTokens, availableOutput);
  // The original grant and an explicit generation allocation own this quote.
  // Omission stays omitted; an unknown bill retains the complete reservation.
  const maxTokens = maxOutputTokens === undefined ? inspected.remaining.tokens : inputEstimate + maxOutputTokens;

  if (availableOutput < 128 || maxOutputTokens !== undefined && maxOutputTokens < 128 || inspected.remaining.calls < 1) throw new Error("tool_learning_budget_exhausted");

  const reservationId = options.newId();
  const reserved = await options.funding.reserve(reservationId, maxTokens);
  if (!reserved.ok) throw fundingBoundaryError("tool_learning_reservation_failed", "reserve", reserved);
  if (!("duplicate" in reserved) || reserved.duplicate) throw new Error("tool_learning_reservation_failed");

  let usage = emptyUsage(), reported = false;
  let boundary: LearningUsageBoundary = { kind: "pending" };
  let finish: Extract<ProviderEvent, { type: "finish" }> | undefined;
  let lease: Awaited<ReturnType<typeof maintainToolFundingLease>> | undefined;

  try {
    lease = await maintainToolFundingLease(options.funding, signal);
    if (signal.aborted) throw new Error("tool_learning_cancelled");

    for await (const event of provider.stream({ ...request, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) }, lease.signal)) {
      lease.assertActive();

      if (event.type === "usage") {
        if (![event.usage.inputTokens, event.usage.outputTokens, event.usage.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)
          || event.usage.totalTokens < event.usage.inputTokens + event.usage.outputTokens) throw new Error("tool_learning_invalid_usage");
        reported = true;
        usage = mergeUsage(usage, event.usage);
        if (usage.totalTokens > maxTokens) {
          boundary = { kind: "overrun" };
          throw new Error("tool_learning_token_overrun");
        }
      }

      if (signal.aborted || event.type === "cancel_ack") throw new Error("tool_learning_cancelled");

      // Preserve the provider's typed, redacted class/phase for the existing
      // artifact worker. Private transport messages never become pipeline codes.
      if (event.type === "error") {
        boundary = { kind: "unknown", reason: "provider_stream_failed" };
        yield event;
        return;
      }

      if (event.type === "warning" && event.code === "stream_finish_tail_timeout") {
        boundary = { kind: "unknown", reason: "provider_usage_tail_incomplete" };
      }

      if (event.type === "finish") {
        if (finish !== undefined) throw new Error("tool_learning_duplicate_finish");
        finish = event;
        if (event.reason === "error") boundary = { kind: "unknown", reason: "provider_stream_failed" };
        // Execution consumes only through finish. Retain it until the inner
        // usage tail is known so iterator.return cannot create a partial bill.
        continue;
      }

      if (finish !== undefined && event.type !== "usage" && event.type !== "warning") {
        throw new Error("tool_learning_post_finish_event");
      }

      yield event;
    }

    if (finish !== undefined) {
      lease.assertActive();
      const active = await options.funding.inspect();
      if (!active.ok) throw fundingBoundaryError("tool_learning_inactive", "finish_inspect", active);
      if (boundary.kind === "pending") boundary = { kind: "complete" };
      yield finish;
    }
  } catch (error) {
    if (boundary.kind !== "overrun") boundary = { kind: "unknown", reason: signal.aborted ? "cancelled" : "provider_stream_failed" };
    throw error;
  } finally {
    await lease?.close();
    if (signal.aborted && boundary.kind !== "overrun") boundary = { kind: "unknown", reason: "cancelled" };
    const receipt = learningUsageSettlement(boundary, reported ? { inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, model: request.model } : undefined);
    const settled = await options.funding.settle(reservationId, receipt);
    if (!settled.ok) throw fundingBoundaryError("tool_learning_settlement_failed", "settle", settled);
  }
}
