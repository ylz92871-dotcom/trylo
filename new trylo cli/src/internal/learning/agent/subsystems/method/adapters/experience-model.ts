import { EXPERIENCE_REVIEW_INSTRUCTION } from "./review-instruction.js";
import { emptyUsage, mergeUsage, type ProviderPort, type ProviderUsage } from "../../../../../ports/provider.js";
import { systemTimerScheduler, type TimerScheduler } from "../../../../../subagent/scheduler.js";
import type { CentralLearningUsage } from "../../../../control/coordination-contract.js";
import type { ExperienceModelPort, ExperienceReview, ExperienceReviewRequest } from "../experience-port.js";
import { isExperienceReview } from "../domain/experience-facts.js";
import { procedureEvidenceError } from "../domain/procedure.js";
import { compilationRevisionError } from "../domain/recompile-policy.js";
import { compilationDeliveryError } from "../domain/experience-render.js";
import { ExperienceModelError } from "../domain/model-error.js";

export { ExperienceModelError } from "../domain/model-error.js";

import { EXPERIENCE_MODEL_LIMITS as LIMITS } from "./experience-budget.js";
import { prepareExperienceReviewEnvelope } from "./review-envelope.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { METHOD_INFERENCE_POLICY } from "../domain/inference.js";
import { newReviewError } from "../domain/review-admission.js";
import { learningUsageSettlement, type LearningUsageBoundary } from "../../../../control/usage-settlement.js";

type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

/** A capability for an already funded central claim. This adapter cannot create or enlarge it. */
export type ExperienceFundingPort = {
  inspect(): Promise<Result<{ readonly active: boolean; readonly remaining: { readonly tokens: number; readonly calls: number; readonly steps: number };
    readonly maxPromptChars: number }>>;
  reserve(input: { readonly reservationId: string; readonly maxTokens: number }): Promise<Result<{ readonly status: "reserved" | "duplicate" }>>;
  settle(input: { readonly reservationId: string; readonly usage: CentralLearningUsage }): Promise<Result<Record<never, never>>>;
};

export type ExperienceModelOptions = {
  readonly provider: ProviderPort; readonly model: string; readonly turnId: string;
  readonly funding?: ExperienceFundingPort; readonly enabled?: () => boolean; readonly scheduler?: TimerScheduler;
  readonly fundingFor?: (request: ExperienceReviewRequest) => ExperienceFundingPort;
};

export { EXPERIENCE_REVIEW_INSTRUCTION };

/** One review stream per host turn; unchanged evidence cannot buy another review.
 * Transport retries remain provider-owned, not extra compiler decisions. */
export function createExperienceModel(options: ExperienceModelOptions): ExperienceModelPort {
  let state: "idle" | "preparing" | "attempted" = "idle";
  return { async review(request, signal) {
    if (signal.aborted || options.enabled?.() === false) throw new ExperienceModelError("method_review_cancelled", "cancelled");

    if (state !== "idle") throw new ExperienceModelError("method_review_turn_limit");

    state = "preparing";
    const prepared = await prepareCall(options, request);
    if (!prepared.ok) {
      state = "idle";
      throw new ExperienceModelError(prepared.reason, "unavailable");
    }

    if (signal.aborted || options.enabled?.() === false) {
      state = "idle";
      throw new ExperienceModelError("method_review_cancelled", "cancelled");
    }

    state = "attempted";
    const reserved = await prepared.funding.reserve({ reservationId: prepared.reservationId, maxTokens: prepared.maxTokens });
    if (!reserved.ok || reserved.status === "duplicate") {
      // No provider has been invoked. Another eligible scope may use this
      // turn's single review stream; the existing reservation remains intact.
      state = "idle";
      throw new ExperienceModelError(reserved.ok ? "method_review_already_reserved" : reserved.reason, "unavailable");
    }

    const response = await readResponse(options, prepared, signal);
    const settled = await prepared.funding.settle({ reservationId: prepared.reservationId,
      usage: learningUsageSettlement(response.boundary, { totalTokens: response.usage.totalTokens,
        inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, model: options.model }) });
    if (!settled.ok) throw new ExperienceModelError(settled.reason);

    if (response.reason !== undefined) throw new ExperienceModelError(response.reason);

    return decodeReview(response.text, prepared.supplied);
  } };
}

type Prepared = { readonly ok: true; readonly funding: ExperienceFundingPort; readonly provider: ProviderPort;
  readonly reservationId: string; readonly material: string; readonly supplied: ExperienceReviewRequest;
  readonly maxOutputTokens: number; readonly maxTokens: number };

async function prepareCall(options: ExperienceModelOptions, request: ExperienceReviewRequest): Promise<Prepared | { readonly ok: false; readonly reason: string }> {
  const funding = options.fundingFor?.(request) ?? options.funding;
  if (funding === undefined) return { ok: false, reason: "method_review_unfunded" };

  const current = await funding.inspect();
  if (!current.ok) return current;

  if (!current.active) return { ok: false, reason: "method_review_inactive" };

  const envelope = prepareExperienceReviewEnvelope(request, current.remaining, current.maxPromptChars);
  if (!envelope.ok) return envelope;

  const provider = options.provider.fork?.([]);
  if (provider === undefined || provider === options.provider) return { ok: false, reason: "method_review_provider_isolation" };

  return { ...envelope, funding, provider,
    // A failed/incomplete response cannot silently buy another draw on the
    // next turn. An explicitly selected different model has its own identity.
    reservationId: shortId("method-review", [request.snapshotId, options.model]) };
}

type Response = { readonly text: string; readonly usage: ProviderUsage; readonly boundary: LearningUsageBoundary; readonly reason?: string };

async function readResponse(options: ExperienceModelOptions, call: Prepared, signal: AbortSignal): Promise<Response> {
  const controller = new AbortController(), abort = () => controller.abort();

  signal.addEventListener("abort", abort, { once: true });
  let usage = emptyUsage(), reported = false, text = "", completed = false, started = false, usageTailIncomplete = false, reason: string | undefined;
  const timer = (options.scheduler ?? systemTimerScheduler)(LIMITS.timeoutMs, () => {
    reason = "method_review_timeout";
    controller.abort();
  });

  try {
    if (signal.aborted) controller.abort();

    const iterator = call.provider.stream({ attemptId: call.reservationId, model: options.model, tools: [],
      maxOutputTokens: call.maxOutputTokens, messages: [{ role: "system", content: EXPERIENCE_REVIEW_INSTRUCTION }, { role: "user", content: call.material }] }, controller.signal)[Symbol.asyncIterator]();

    for (;;) {
      const next = await nextBeforeAbort(iterator, controller.signal);
      if (next.done) break;

      const event = next.value;

      if (signal.aborted || options.enabled?.() === false) {
        reason = "method_review_cancelled";
        controller.abort();
        break;
      }

      if (event.type === "stream_start") started = true;

      if (event.type === "usage") {
        if (!validUsage(event.usage)) {
          reason = "method_review_usage_invalid";
          controller.abort();
          break;
        }
        usage = mergeUsage(usage, event.usage);
        reported = true;
        if (usage.totalTokens > call.maxTokens) {
          reason = "method_review_budget_overrun";
          controller.abort();
          break;
        }
      }

      if (event.type === "warning" && event.code === "stream_finish_tail_timeout") usageTailIncomplete = true;

      if (event.type === "text_delta") text += event.text;

      if (text.length > 16000) {
        reason = "method_review_output_limit";
        controller.abort();
        break;
      }

      if (event.type === "error" || event.type === "cancel_ack") {
        reason ??= "method_review_provider_failed";
        break;
      }

      if (["tool_call", "tool_call_invalid", "tool_input_start"].includes(event.type)) {
        reason = "method_review_tool_forbidden";
        controller.abort();
        break;
      }

      if (event.type === "finish") completed = event.reason === "stop" && !event.requiresFollowUp;
    }

    if (controller.signal.aborted || !completed || !started) reason ??= "method_review_incomplete";
  } catch { reason ??= signal.aborted ? "method_review_cancelled" : "method_review_provider_failed"; }
  finally {
    timer.cancel();
    signal.removeEventListener("abort", abort);
    controller.abort();
  }

  // Ordinary partial usage retains the whole reservation. A proven overrun
  // forwards its observed lower bound so the central owner closes the grant;
  // this does not claim a final bill for the interrupted provider stream.
  // Billing finality is independent of an otherwise admissible business response.
  const boundary: LearningUsageBoundary = usage.totalTokens > call.maxTokens ? { kind: "overrun" }
    : reason !== undefined ? { kind: "unknown", reason }
      : usageTailIncomplete ? { kind: "unknown", reason: "provider_usage_tail_incomplete" }
        : reported ? { kind: "complete" } : { kind: "unknown", reason: "method_review_usage_absent" };

  return { text, usage, boundary, ...(reason === undefined ? {} : { reason }) };
}

/** Bound the local wait even if a broken transport ignores abort. Unknown usage remains fully reserved. */
async function nextBeforeAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new ExperienceModelError("method_review_cancelled");

  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ExperienceModelError("method_review_stopped"));
    signal.addEventListener("abort", abort, { once: true });
  });

  try { return await Promise.race([iterator.next(), stopped]); }
  finally { if (abort !== undefined) signal.removeEventListener("abort", abort); }
}

function validUsage(value: ProviderUsage): boolean {
  return [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens, value.totalTokens]
    .every(item => Number.isSafeInteger(item) && item >= 0);
}

function decodeReview(text: string, request: ExperienceReviewRequest): ExperienceReview {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1"));
    if (!isExperienceReview(value)) throw new ExperienceModelError("method_review_shape_invalid");

    const admissionError = newReviewError(value, request.method);
    if (admissionError !== undefined) throw new ExperienceModelError(admissionError);

    const suppliedSources = new Set([request.versionId, ...(request.relatedSources ?? []).map(item => item.versionId)]);
    if (!value.sources.includes(request.versionId) || value.sources.some(id => !suppliedSources.has(id))) {
      throw new ExperienceModelError("method_review_source_not_supplied");
    }

    if (value.decision === "promote" || value.decision === "expression" ||
      (value.decision === "narrow" && (value.compact !== undefined || value.procedure !== undefined))) {
      if (value.procedure === undefined || value.compact === undefined) throw new ExperienceModelError("method_review_procedure_required");

      const error = procedureEvidenceError(value.procedure, request.observations);
      if (error !== undefined) throw new ExperienceModelError(error);

      const deliveryError = compilationDeliveryError({ compact: value.compact, procedure: value.procedure });
      if (deliveryError !== undefined) throw new ExperienceModelError(deliveryError);

      if (request.currentCompilation !== undefined) {
        const mode = (request.currentCompilation.reentry?.confidence ?? 0) >= METHOD_INFERENCE_POLICY.algorithmThreshold ? "requalified" :
          request.currentCompilation.withdrawn || request.currentCompilation.repairRequired === true || request.repair !== undefined ||
            request.currentCompilation.repairRequired === undefined && request.reconsideration !== undefined &&
            (request.reconsideration.reason !== "evidence_change" || request.reconsideration.observations.some(item => item.outcome === "unhelpful"))
            ? "repair" : "ordinary";
        const revisionError = compilationRevisionError(request.currentCompilation, value, mode);
        if (revisionError !== undefined) throw new ExperienceModelError(revisionError);
      }
    }

    return value;
  } catch (error) { throw error instanceof ExperienceModelError ? error : new ExperienceModelError("method_review_json_invalid"); }
}
