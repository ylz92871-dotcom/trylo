import type { CollaborationAnalysisPortV2, CollaborationAnalysisWindowV2, CollaborationUsageV2 } from "../domain/v2-contracts.js";
import { parseCollaborationAnalysisResponseV2 } from "../domain/v2-parse.js";
import { emptyUsage, mergeUsage, type ProviderPort, type ProviderUsage } from "../../../../../ports/provider.js";
import { COLLABORATION_ANALYSIS_INSTRUCTION, collaborationAnalysisMaterial } from "./analysis-prompt-v2.js";

type Request = Parameters<CollaborationAnalysisPortV2["analyze"]>[0];

type Result = Awaited<ReturnType<CollaborationAnalysisPortV2["analyze"]>>;

export type CollaborationModelOptionsV2 = {
  readonly provider: ProviderPort;
  readonly model: string;
  readonly providerId?: string;
  readonly enabled?: () => boolean;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
};

/** No production tool, writer or permission capability enters this isolated model call. */
export function createCollaborationModelAnalyzerV2(options: CollaborationModelOptionsV2): CollaborationAnalysisPortV2 {
  const now = options.nowMs ?? Date.now;
  const enabled = options.enabled ?? (() => true);
  return { analyze: request => analyze(options, request, now, enabled), estimateInputTokens: estimateCollaborationInputV2 };
}

export function estimateCollaborationInputV2(window: CollaborationAnalysisWindowV2): number {
  const input = inputOf(window);
  return input.inputBytes > 65536 ? Number.POSITIVE_INFINITY : input.reservedTokens;
}

async function analyze(options: CollaborationModelOptionsV2, request: Request,
  now: () => number, enabled: () => boolean): Promise<Result> {
  const startedAt = now();
  let attempted = false, reported = false, totals = emptyUsage();
  const measurement = (): CollaborationUsageV2 => ({ status: reported ? "reported" : "reserved_unknown",
    elapsedMs: Math.max(0, now() - startedAt), model: options.model,
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }), ...(reported ? {
      inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, totalTokens: totals.totalTokens } : {}) });
  // Missing usage after a call is charged conservatively; it must never look like a free attempt.
  const accounting = () => ({ tokenCost: reported ? totals.totalTokens : attempted ? request.maxTokens : 0,
    ...(attempted ? { usage: measurement() } : {}) });
  const failed = (reason: string): Result => ({ status: "failed", reason, ...accounting() });
  const timeoutMs = options.timeoutMs ?? 45000;

  if (!enabled()) return failed("collect_disabled");

  if (request.signal.aborted) return failed("learning_aborted");

  if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 1000000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return failed("collaboration_model_allowance_invalid");

  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();

  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const { material, inputBytes, reservedTokens } = inputOf(request.window);
    const maxOutputTokens = Math.min(4096, request.maxTokens - reservedTokens);
    if (inputBytes > 65536 || maxOutputTokens < 1024) return failed("collaboration_model_input_exceeds_allowance");

    const isolated = options.provider.fork?.([]);
    if (isolated === undefined || isolated === options.provider) return failed("collaboration_provider_isolation_unavailable");

    if (!enabled() || controller.signal.aborted) return failed(request.signal.aborted ? "learning_aborted" : "collect_disabled");

    attempted = true;
    let text = "", finished = false, rejection: string | undefined;

    for await (const event of isolated.stream({ attemptId: `collaboration-analysis:${request.cycleId}:${request.step}`,
      continuationScope: `collaboration-learning:${request.cycleId}`, model: options.model, tools: [], maxOutputTokens,
      messages: [{ role: "system", content: COLLABORATION_ANALYSIS_INSTRUCTION }, { role: "user", content: material }] }, controller.signal)) {
      if (event.type === "usage") {
        if (!validUsage(event.usage)) {
          rejection = "collaboration_provider_usage_invalid";
          controller.abort();
          break;
        }
        totals = mergeUsage(totals, event.usage);
        reported = totals.totalTokens > 0;
        if (totals.totalTokens > request.maxTokens) {
          rejection = "collaboration_model_budget_exceeded";
          controller.abort();
          break;
        }
      }

      if (!enabled() || controller.signal.aborted) {
        controller.abort();
        break;
      }

      if (finished && event.type !== "usage") {
        rejection = "collaboration_model_events_after_finish";
        break;
      }

      if (event.type === "tool_call" || event.type === "tool_call_invalid" || event.type === "tool_input_start") {
        rejection = "collaboration_analysis_tool_forbidden";
        controller.abort();
        break;
      }

      if (event.type === "error") {
        rejection = `collaboration_provider_${event.class}`;
        break;
      }

      if (event.type === "text_delta") {
        text += event.text;
        if (Buffer.byteLength(text, "utf8") > Math.min(65536, maxOutputTokens * 16)) {
          rejection = "collaboration_model_output_limit";
          controller.abort();
          break;
        }
      }

      if (event.type === "finish") {
        finished = true;
        if (event.reason !== "stop" || event.requiresFollowUp) rejection = "collaboration_model_incomplete";
      }
    }

    if (!enabled()) return failed("collect_disabled");

    if (request.signal.aborted) return failed("learning_aborted");

    if (timedOut) return failed("collaboration_model_timeout");

    if (rejection !== undefined) return failed(rejection);

    if (!finished || controller.signal.aborted) return failed("collaboration_model_incomplete");

    const parsed = parseResponse(text);

    return parsed.ok ? { ...parsed.value, ...accounting() } : failed(parsed.reason);
  } catch {
    return failed(!enabled() ? "collect_disabled" : request.signal.aborted ? "learning_aborted"
      : timedOut ? "collaboration_model_timeout" : "collaboration_model_unavailable");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    controller.abort();
  }
}

function parseResponse(text: string): ReturnType<typeof parseCollaborationAnalysisResponseV2> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1");
  try { return parseCollaborationAnalysisResponseV2(JSON.parse(trimmed)); }
  catch { return { ok: false, reason: "collaboration_analysis_json_invalid" }; }
}

function validUsage(value: ProviderUsage): boolean {
  return (value.mode === "snapshot" || value.mode === "delta") && [value.inputTokens, value.outputTokens, value.totalTokens,
    value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens].every(item => Number.isSafeInteger(item) && item >= 0)
    && value.totalTokens >= Math.max(value.inputTokens, value.outputTokens);
}

/** One conservative estimate serves both unpaid domain planning and final adapter admission. */
function inputOf(window: CollaborationAnalysisWindowV2) {
  const material = collaborationAnalysisMaterial(window);
  const inputBytes = Buffer.byteLength(COLLABORATION_ANALYSIS_INSTRUCTION + material, "utf8");
  return { material, inputBytes, reservedTokens: Math.ceil(inputBytes / 2) + 256 };
}
