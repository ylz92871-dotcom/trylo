import { emptyUsage, mergeUsage, type ProviderEvent, type ProviderPort, type ProviderForkOptions, type ProviderRequest, type ProviderUsage } from "../../ports/provider.js";
import type { LearningGrantUsage } from "../../learning/control/grant-contract.js";
import { isLearningGrantUsage } from "../../learning/control/grant-parse.js";
import { createSkillLearningGrant, SkillLearningGrantError } from "./grant-runtime.js";

export type SkillGrantProviderOptions = {
  readonly runtime: ReturnType<typeof createSkillLearningGrant>;
  readonly grantId: string;
  readonly reservationIdFactory: (request: ProviderRequest) => string;
};

/** Every fork has independent provider state and shares the same Board quota. */
export function withSkillLearningGrant(provider: ProviderPort, options: SkillGrantProviderOptions): ProviderPort {
  const wrapped: ProviderPort = {
    ...(provider.continuation === undefined ? {} : { continuation: provider.continuation }),
    ...(provider.fork === undefined ? {} : { fork: (messages?: Parameters<NonNullable<ProviderPort["fork"]>>[0], forkOptions?: ProviderForkOptions) => {
      const child = provider.fork!(messages, forkOptions);
      // Preserve the provider isolation fence used by the learning model.
      return child === provider ? wrapped : withSkillLearningGrant(child, options);
    } }),
    stream: (request, signal) => fundedStream(provider, options, request, signal),
  };
  return wrapped;
}

async function* fundedStream(provider: ProviderPort, options: SkillGrantProviderOptions, request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
  if (signal.aborted) throw new SkillLearningGrantError("learning_aborted");

  const reservationId = options.reservationIdFactory(request);
  const reserved = await options.runtime.reserve({ grantId: options.grantId, reservationId,
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }) });
  if (!reserved.ok) throw new SkillLearningGrantError(reserved.code);

  if (reserved.status !== "reserved") throw new SkillLearningGrantError("learning_grant_conflict");

  let totals = emptyUsage(), reported = false;
  let phase: "streaming" | "finished" | "failed" | "closed" = "streaming";
  let settlement: ReturnType<ReturnType<typeof createSkillLearningGrant>["settle"]> | undefined;
  const settle = (usage: LearningGrantUsage) => settlement ??= options.runtime.settle({ grantId: options.grantId, reservationId, usage });
  const observed = () => ({ inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, totalTokens: totals.totalTokens });
  const abort = () => { void settle({ kind: "unknown", reason: "cancelled", ...(reported ? { observed: observed() } : {}) }); };

  signal.addEventListener("abort", abort, { once: true });

  try {
    if (signal.aborted) {
      abort();
      throw new SkillLearningGrantError("learning_aborted");
    }

    for await (const event of provider.stream({ ...request, maxOutputTokens: reserved.reservation.maxOutputTokens }, signal)) {
      if (event.type === "usage") {
        if (!validProviderUsage(event.usage)) {
          phase = "failed";
          throw new SkillLearningGrantError("invalid_learning_grant");
        }

        reported = true;
        totals = mergeUsage(totals, event.usage);

        if (totals.outputTokens > reserved.reservation.maxOutputTokens) {
          phase = "failed";
          // The provider explicitly reported this cost. Preserve it even when
          // the overrun stops delivery before a finish event can be consumed.
          const result = await settle({ kind: "reported", ...observed() });
          if (!result.ok) throw new SkillLearningGrantError(result.code);
          throw new SkillLearningGrantError("learning_grant_exhausted");
        }
      }

      if (event.type === "error" || event.type === "cancel_ack") phase = "failed";

      if (event.type === "finish" && phase !== "failed") phase = "finished";

      yield event;
    }

    phase = phase === "finished" ? "closed" : "failed";
  } finally {
    signal.removeEventListener("abort", abort);
    // Consumers may return immediately after the terminal finish event. The
    // usage already received is still chargeable; natural iterator exhaustion
    // is not an additional provider completion signal.
    const usage: LearningGrantUsage = (phase === "closed" || phase === "finished") && !signal.aborted && reported ? { kind: "reported", ...observed() }
      : { kind: "unknown", reason: signal.aborted ? "cancelled" : "provider_stream_incomplete", ...(reported ? { observed: observed() } : {}) };
    const result = await settle(usage);
    if (!result.ok) throw new SkillLearningGrantError(result.code);
  }
}

function validProviderUsage(usage: ProviderUsage): boolean {
  return (usage.mode === "snapshot" || usage.mode === "delta") && isLearningGrantUsage({ kind: "reported",
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens })
    && [usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens].every(value => Number.isSafeInteger(value) && value >= 0);
}
