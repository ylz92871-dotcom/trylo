import { mergeUsage, emptyUsage, type ProviderEvent, type ProviderUsage } from "../../ports/provider.js";
import type { SkillModelAllowance, SkillModelUsage, SkillTaskModelOptions } from "./task-contract.js";

export const emptySkillModelUsage = (): SkillModelUsage => ({ calls: 0, inputBytes: 0, usageStatus: "missing" });

type ModelText = { readonly kind: "text"; readonly text: string; readonly usage: SkillModelUsage }
  | { readonly kind: "waiting" | "failed" | "cancelled" | "disabled"; readonly reason: string; readonly usage: SkillModelUsage };

/** One inert, isolated provider call. The adapter never receives a production tool or writer. */
export async function runSkillModel(options: SkillTaskModelOptions, instruction: string, material: string,
  allowance: SkillModelAllowance, requestId: string, signal: AbortSignal): Promise<ModelText> {
  let usage = emptySkillModelUsage();

  if (options.collection() === "disabled") return { kind: "disabled", reason: "collection_disabled", usage };

  if (signal.aborted) return { kind: "cancelled", reason: "cancelled", usage };

  if (!validAllowance(allowance)) return { kind: "failed", reason: "invalid_model_allowance", usage };

  if (allowance.maxModelCalls === 0) return { kind: "waiting", reason: "model_allowance_exhausted", usage };

  const inputBytes = Buffer.byteLength(instruction + material, "utf8");
  if (inputBytes > allowance.maxInputBytes) return { kind: "waiting", reason: "model_input_exceeds_allowance", usage };

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return { kind: "failed", reason: "invalid_model_timeout", usage };

  const controller = new AbortController();
  let timedOut = false, reported = false, totals: ProviderUsage = emptyUsage();
  const abort = () => controller.abort();

  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let iterator: AsyncIterator<ProviderEvent> | undefined;

  try {
    const isolated = options.provider.fork?.([]);
    if (isolated === undefined || isolated === options.provider) return { kind: "failed", reason: "skill_provider_isolation_unavailable", usage };

    usage = { calls: 1, inputBytes, usageStatus: "missing" };
    let text = "", stopped = false, rejection: string | undefined;

    iterator = isolated.stream({ attemptId: requestId, model: options.model, tools: [], maxOutputTokens: allowance.maxOutputTokens,
      messages: [{ role: "system", content: instruction }, { role: "user", content: material }] }, controller.signal)[Symbol.asyncIterator]();

    while (true) {
      const next = await nextModelEvent(iterator, controller.signal);
      if (next === undefined || next.done) break;

      const event = next.value;
      if (event.type === "usage") {
        if (!validUsage(event.usage)) {
          rejection = "invalid_provider_usage";
          controller.abort();
          break;
        }
        reported = true;
        totals = mergeUsage(totals, event.usage);
        usage = { calls: 1, inputBytes, usageStatus: "reported", inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, totalTokens: totals.totalTokens };
        if (totals.outputTokens > allowance.maxOutputTokens) {
          rejection = "model_output_exceeds_allowance";
          controller.abort();
          break;
        }
      }

      if (controller.signal.aborted || options.collection() === "disabled") {
        controller.abort();
        break;
      }

      if (stopped && event.type !== "usage") {
        rejection = "model_events_after_finish";
        break;
      }

      if (event.type === "tool_call" || event.type === "tool_call_invalid" || event.type === "tool_input_start") {
        rejection = "skill_model_tool_forbidden";
        controller.abort();
        break;
      }

      if (event.type === "error") {
        rejection = "skill_model_provider_error";
        break;
      }

      if (event.type === "text_delta") {
        text += event.text;
        if (Buffer.byteLength(text, "utf8") > Math.min(65_536, allowance.maxOutputTokens * 16)) {
          rejection = "skill_model_output_limit";
          controller.abort();
          break;
        }
      }

      if (event.type === "finish") {
        if (event.reason !== "stop" || event.requiresFollowUp) rejection = "skill_model_incomplete";
        stopped = true;
      }
    }

    if (options.collection() === "disabled") return { kind: "disabled", reason: "collection_disabled", usage };

    if (signal.aborted) return { kind: "cancelled", reason: "cancelled", usage };

    if (timedOut) return { kind: "failed", reason: "skill_model_timeout", usage };

    if (rejection !== undefined) return { kind: "failed", reason: rejection, usage };

    if (!stopped || controller.signal.aborted || text.trim().length === 0) return { kind: "failed", reason: "skill_model_incomplete", usage };

    // A successful text response may have no usage report. Preserve unknown,
    // rather than claiming a free call. The runtime can stop further learning.
    return { kind: "text", text: text.trim(), usage: reported ? usage : { calls: 1, inputBytes, usageStatus: "missing" } };
  } catch {
    return options.collection() === "disabled" ? { kind: "disabled", reason: "collection_disabled", usage }
      : signal.aborted ? { kind: "cancelled", reason: "cancelled", usage }
        : { kind: "failed", reason: timedOut ? "skill_model_timeout" : "skill_model_unavailable", usage };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();

    try {
      // Transport cancellation is already signalled. An adapter's delayed
      // iterator close must not delay the learning deadline or emit experience.
      const closing = iterator?.return?.();
      if (closing !== undefined) void closing.catch(() => { /* Cleanup only; partial text has already been refused. */ });
    } catch { /* Cleanup only; the transport signal is aborted and the outcome is already explicit. */ }
  }
}

/** A transport that ignores abort cannot keep the standalone entry waiting forever. */
function nextModelEvent(iterator: AsyncIterator<ProviderEvent>, signal: AbortSignal): Promise<IteratorResult<ProviderEvent> | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    };
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(iterator.next()).then(next => {
      signal.removeEventListener("abort", abort);
      resolve(next);
    },
      error => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
  });
}

function validAllowance(value: SkillModelAllowance): boolean {
  return Number.isSafeInteger(value.maxModelCalls) && value.maxModelCalls >= 0 && value.maxModelCalls <= 2
    && Number.isSafeInteger(value.maxInputBytes) && value.maxInputBytes > 0 && value.maxInputBytes <= 262_144
    && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0 && value.maxOutputTokens <= 4096;
}

function validUsage(value: ProviderUsage): boolean {
  return [value.inputTokens, value.outputTokens, value.totalTokens, value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens]
    .every(item => Number.isFinite(item) && item >= 0) && (value.mode === "snapshot" || value.mode === "delta");
}
