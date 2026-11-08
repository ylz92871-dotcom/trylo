import { emptyUsage, mergeUsage, type ProviderEvent, type ProviderPort, type ProviderForkOptions, type ProviderRequest, type ProviderUsage } from "../../../../../ports/provider.js";
import type { SkillCentralFunding } from "../control/contracts.js";
import { learningUsageSettlement, type LearningUsageBoundary } from "../../../../control/usage-settlement.js";

type Options = { readonly funding: SkillCentralFunding; readonly newId: () => string;
  /** Explicit selected host generation allowance, independent of lifetime funding. */
  readonly maxOutputTokens?: number };

export class SkillFundingError extends Error {
  constructor(readonly reason: string, readonly admission?: Readonly<Record<string, number>>) { super(reason); }
}

/** Existing execution forks spend one central grant; this path never opens a v1 grant. */
export function withSkillCentralFunding(provider: ProviderPort, options: Options): ProviderPort {
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1)) {
    throw new SkillFundingError("skill_learning_generation_allowance_invalid");
  }
  const wrapped: ProviderPort = {
    ...(provider.continuation === undefined ? {} : { continuation: provider.continuation }),
    ...(provider.fork === undefined ? {} : { fork: (messages?: Parameters<NonNullable<ProviderPort["fork"]>>[0], forkOptions?: ProviderForkOptions) => {
      const child = provider.fork!(messages, forkOptions);
      return child === provider ? wrapped : withSkillCentralFunding(child, options);
    } }),
    stream: (request, signal) => fundedStream(provider, request, signal, options),
  };
  return wrapped;
}

async function* fundedStream(provider: ProviderPort, request: ProviderRequest, signal: AbortSignal, options: Options): AsyncIterable<ProviderEvent> {
  let admission: Awaited<ReturnType<typeof reserveSkillCall>>;
  try { admission = await reserveSkillCall(provider, request, signal, options); }
  catch (error) {
    // Safe typed/numeric diagnostics reach the existing canonical journal;
    // neither raw provider text nor the request body is exposed.
    yield { type: "warning", code: "skill_learning_admission_failed", message: JSON.stringify(error instanceof SkillFundingError
      ? { reason: error.reason, ...error.admission } : { reason: "skill_learning_admission_exception" }) };
    throw error;
  }
  const { reservationId, maxTokens, maxOutputTokens } = admission;
  let usage = emptyUsage(), reported = false;
  let boundary: LearningUsageBoundary = { kind: "pending" };
  let finish: Extract<ProviderEvent, { type: "finish" }> | undefined;
  let settlementAttempt: Promise<void> | undefined;
  // The first attempt seals its receipt and outcome. Finally shares it, including an unconfirmed failure.
  const settle = () => settlementAttempt ??= settleUsage(options.funding, { reservationId,
    usage: learningUsageSettlement(boundary, reported ? { inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, model: request.model } : undefined) });

  try {
    if (signal.aborted) throw new SkillFundingError("learning_aborted");

    for await (const event of provider.stream({ ...request, maxOutputTokens }, signal)) {
      if (event.type === "usage") {
        if (!validUsage(event.usage)) throw new SkillFundingError("skill_learning_invalid_usage");
        usage = mergeUsage(usage, event.usage);
        reported = true;
        if (usage.totalTokens > maxTokens) {
          boundary = { kind: "overrun" };
          throw new SkillFundingError("learning_grant_exhausted");
        }
      }

      if (signal.aborted || event.type === "cancel_ack") throw new SkillFundingError("learning_aborted");

      if (event.type === "error") {
        boundary = { kind: "unknown", reason: "provider_stream_failed" };
        yield event;
        return;
      }

      if (event.type === "warning" && event.code === "stream_finish_tail_timeout") {
        boundary = { kind: "unknown", reason: "provider_usage_tail_incomplete" };
      }

      if (event.type === "finish") {
        if (finish !== undefined) throw new SkillFundingError("skill_learning_duplicate_finish");
        finish = event;
        if (event.reason === "error") boundary = { kind: "unknown", reason: "provider_stream_failed" };
        // Execution consumers stop at finish. Drain the inner usage tail before exposing that terminal.
        continue;
      }

      if (finish !== undefined && event.type !== "usage" && event.type !== "warning") throw new SkillFundingError("skill_learning_post_finish_event");

      yield event;
    }

    if (finish !== undefined) {
      const current = await options.funding.inspect();

      // Our own reservation makes inspect.active false; grant closure or a failed read still blocks the terminal.
      if (!current.ok || current.grant.status !== "open") throw new SkillFundingError("skill_learning_inactive");

      if (signal.aborted) throw new SkillFundingError("learning_aborted");

      if (boundary.kind === "pending") boundary = { kind: "complete" };

      // The Loop treats iterator.return failures as cleanup. Confirm accounting before it observes success.
      await settle();

      if (signal.aborted) throw new SkillFundingError("learning_aborted");

      yield finish;
    }
  } catch (error) {
    if (boundary.kind !== "overrun") boundary = { kind: "unknown", reason: signal.aborted ? "cancelled" : "provider_stream_failed" };
    throw error;
  } finally {
    if (settlementAttempt === undefined && signal.aborted && boundary.kind !== "overrun") boundary = { kind: "unknown", reason: "cancelled" };
    await settle();
  }
}

async function settleUsage(funding: SkillCentralFunding, input: Parameters<SkillCentralFunding["settle"]>[0]): Promise<void> {
  const settled = await funding.settle(input);
  if (!settled.ok) throw new SkillFundingError(settled.reason);
}

async function reserveSkillCall(provider: ProviderPort, request: ProviderRequest, signal: AbortSignal, options: Options) {
  if (signal.aborted) throw new SkillFundingError("learning_aborted");

  const current = await options.funding.inspect();
  if (!current.ok) throw new SkillFundingError(current.reason);

  if (!current.active) throw new SkillFundingError("skill_learning_inactive");

  // Include tool schemas and prompt directives, which are part of the bill even
  // though they are not plain conversation text. This is admission, not a bill.
  const prompt = JSON.stringify({ messages: request.messages, tools: request.tools,
    systemPrompt: request.systemPrompt, systemPromptAppend: request.systemPromptAppend, responseSchema: request.responseSchema });
  const promptLimit = Math.min(current.maxPromptChars ?? current.grant.allowance.maxPromptChars, current.grant.allowance.maxPromptChars);
  const admission = { promptChars: prompt.length, promptLimit, remainingTokens: current.remaining.tokens };
  if (prompt.length > promptLimit) throw new SkillFundingError("skill_learning_prompt_limit", admission);

  const overhead = provider.continuation?.estimateOverheadTokens?.(request.messages) ?? 0;
  if (!Number.isSafeInteger(overhead) || overhead < 0) throw new SkillFundingError("skill_learning_invalid_usage");

  const inputReserve = new TextEncoder().encode(prompt).length + 512 + overhead;
  const selectedOutput = options.maxOutputTokens === undefined ? request.maxOutputTokens ?? 4096
    : Math.min(request.maxOutputTokens ?? options.maxOutputTokens, options.maxOutputTokens);
  const maxOutputTokens = Math.min(selectedOutput, current.remaining.tokens - inputReserve);
  if (maxOutputTokens < 128 || current.remaining.calls < 1 || current.remaining.steps < 1) {
    throw new SkillFundingError("learning_grant_exhausted", { ...admission, inputReserve, selectedOutput });
  }

  const reservationId = options.newId(), maxTokens = inputReserve + maxOutputTokens;
  const reserved = await options.funding.reserve({ reservationId, maxTokens });
  if (!reserved.ok) throw new SkillFundingError(reserved.reason);

  if (reserved.status === "duplicate") throw new SkillFundingError("learning_call_already_reserved");

  return { reservationId, maxTokens, maxOutputTokens };
}

function validUsage(usage: ProviderUsage): boolean {
  return (usage.mode === "snapshot" || usage.mode === "delta") && [usage.inputTokens, usage.outputTokens, usage.totalTokens,
    usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens].every(value => Number.isSafeInteger(value) && value >= 0)
    && usage.totalTokens >= usage.inputTokens + usage.outputTokens;
}
