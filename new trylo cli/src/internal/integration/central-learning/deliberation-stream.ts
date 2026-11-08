import { emptyUsage, mergeUsage, PROVIDER_ERROR_CLASSES, type ProviderEvent, type ProviderPort, type ProviderRequest, type ProviderUsage } from "../../ports/provider.js";
import { isProviderRecoveryHint } from "../../domain/provider-recovery.js";
import type { LearningUsageBoundary } from "../../learning/control/usage-settlement.js";
import { systemTimerScheduler, type TimerHandle, type TimerScheduler } from "../../subagent/scheduler.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { CENTRAL_DECISION_TOOL, CentralDeliberationError, type CentralDeliberationProviderFailure } from "./deliberation-contract.js";
import { classifyCentralToolArguments, type CentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";

export interface CentralDeliberationStreamResult {
  readonly output: unknown;
  readonly usage: ProviderUsage;
  readonly reported: boolean;
  readonly boundary: LearningUsageBoundary;
  readonly reason?: string;
  readonly providerFailure?: CentralDeliberationProviderFailure;
  readonly diagnostics?: CentralDeliberationOutputDiagnostics;
}

const validUsage = (usage: ProviderUsage) => (usage.mode === "snapshot" || usage.mode === "delta")
  && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, usage.totalTokens]
    .every(value => Number.isSafeInteger(value) && value >= 0) && usage.totalTokens >= usage.inputTokens + usage.outputTokens;

function safeProviderFailure(event: Extract<ProviderEvent, { readonly type: "error" }>): CentralDeliberationProviderFailure | undefined {
  if (!PROVIDER_ERROR_CLASSES.some(value => value === event.class) || typeof event.retryable !== "boolean") return undefined;
  return { class: event.class, retryable: event.retryable,
    ...(isProviderRecoveryHint(event.recovery) ? { recovery: { ...event.recovery } } : {}) };
}

async function nextBeforeAbort(iterator: AsyncIterator<ProviderEvent>, signal: AbortSignal): Promise<IteratorResult<ProviderEvent>> {
  if (signal.aborted) throw new CentralDeliberationError("central_deliberation_cancelled", "unknown");

  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new CentralDeliberationError("central_deliberation_cancelled", "unknown"));
    signal.addEventListener("abort", stop, { once: true });
  });

  try { return await Promise.race([iterator.next(), aborted]); }
  finally { if (stop !== undefined) signal.removeEventListener("abort", stop); }
}

function deliberationWatchdog(timeoutMs: number | undefined, schedule: TimerScheduler, timeout: () => void) {
  let total: TimerHandle | undefined, idle: TimerHandle | undefined, stopped = false, generation = 0;
  const expire = () => { if (!stopped) {
    stopped = true;
    timeout();
  } };
  const progress = () => {
    if (stopped || timeoutMs !== undefined) return;
    const current = ++generation;
    idle?.cancel();
    idle = schedule(120000, () => { if (current === generation) expire(); });
  };

  return {
    start() {
      // Explicit legacy limits remain total deadlines. The default bounds
      // first progress/stalls independently from the entire transport draw.
      total = schedule(timeoutMs ?? 600000, expire);
      progress();
    },

    progress,

    cancel() {
      stopped = true;
      generation += 1;
      try { total?.cancel(); } finally { idle?.cancel(); }
    },
  };
}

/** One transport draw; the public decision envelope executes no tool or side effect. */
export async function readCentralDeliberationStream(input: { readonly provider: ProviderPort; readonly request: ProviderRequest;
  readonly signal: AbortSignal; readonly enabled: () => boolean; readonly maxTokens: number;
  readonly timeoutMs?: number; readonly scheduler?: TimerScheduler }): Promise<CentralDeliberationStreamResult> {
  const jsonObject = input.request.responseFormat?.type === "json_object";
  if (jsonObject && (input.request.tools.length !== 0 || input.request.responseSchema !== undefined)) {
    throw new CentralDeliberationError("central_deliberation_output_mode_invalid", "not_sent");
  }

  const controller = new AbortController(), abort = () => controller.abort(input.signal.reason);
  const decisionToolName = input.request.tools.length === 1 ? input.request.tools[0]!.name : CENTRAL_DECISION_TOOL;

  input.signal.addEventListener("abort", abort, { once: true });
  let usage = emptyUsage(), reported = false, assistantText = "", argumentsText = "", output: unknown, toolId: string | undefined;
  let generatedOutput = 0, generatedReasoning = 0;
  let finish: Extract<ProviderEvent, { type: "finish" }> | undefined;
  let reason: string | undefined, exhausted = false, timedOut = false, tailIncomplete = false, overrun = false;
  let rejectionReason: CentralDeliberationOutputDiagnostics["rejectionReason"] | undefined;
  let rejectionCause: CentralDeliberationOutputDiagnostics["cause"] = "unknown";
  let argumentChars = 0, outputChars = 0, toolStarts = 0, invalidTools = 0, unparseableSseFrames = 0;
  const argumentChunks = new Set<string>();
  const reject = (code: CentralDeliberationOutputDiagnostics["rejectionReason"], cause: CentralDeliberationOutputDiagnostics["cause"]) => {
    if (rejectionReason === undefined) {
      rejectionReason = code;
      rejectionCause = cause;
    }
    // Once rejected, only bounded accounting/terminal metadata survives.
    assistantText = "";
    argumentsText = "";
    output = undefined;
  };
  let providerFailure: CentralDeliberationProviderFailure | undefined;
  let iterator: AsyncIterator<ProviderEvent> | undefined;
  const watchdog = deliberationWatchdog(input.timeoutMs, input.scheduler ?? systemTimerScheduler,
    () => {
      timedOut = true;
      controller.abort();
    });

  try {
    watchdog.start();

    if (input.signal.aborted || !input.enabled()) controller.abort();

    iterator = input.provider.stream(input.request, controller.signal)[Symbol.asyncIterator]();

    for (;;) {
      const next = await nextBeforeAbort(iterator, controller.signal);
      if (next.done) {
        exhausted = true;
        break;
      }

      const event = next.value;
      if (!input.enabled() || event.type === "cancel_ack") {
        reason = "central_deliberation_cancelled";
        break;
      }

      if (event.type === "raw_unknown" && event.wire === "sse.unparseable") {
        unparseableSseFrames += 1;
        reject("central_deliberation_stream_protocol_gap", "wire_frame_invalid");
        continue;
      }

      if (event.type === "usage") {
        if (!validUsage(event.usage)) {
          reason = "central_deliberation_usage_invalid";
          break;
        }

        usage = mergeUsage(usage, event.usage);
        reported = true;

        if (!validUsage(usage)) {
          reason = "central_deliberation_usage_invalid";
          break;
        }

        if (usage.totalTokens > input.maxTokens) {
          overrun = true;
          reason = "central_deliberation_token_overrun";
          break;
        }

        // Accounting-only prompt/cache changes and repeated snapshots do not
        // establish new generation. Keep all valid usage for settlement.
        if (usage.outputTokens > generatedOutput || usage.reasoningTokens > generatedReasoning) watchdog.progress();

        generatedOutput = Math.max(generatedOutput, usage.outputTokens);
        generatedReasoning = Math.max(generatedReasoning, usage.reasoningTokens);
        continue;
      }

      if (event.type === "warning") {
        if (event.code === "stream_finish_tail_timeout") tailIncomplete = true;
        continue;
      }

      if (event.type === "error") {
        providerFailure = safeProviderFailure(event);
        reason = `central_deliberation_provider_${providerFailure?.class ?? "unknown"}`;
        break;
      }

      if (event.type === "finish") {
        if (finish !== undefined) {
          reason = "central_deliberation_duplicate_finish";
          break;
        }
        finish = event;
        continue;
      }

      if (event.type === "tool_input_start") toolStarts += 1;

      if (event.type === "tool_call_invalid") invalidTools += 1;

      if (event.type === "tool_input_delta") {
        argumentChunks.add(event.toolCallId);
        argumentChars += event.argumentsText.length;
        outputChars += event.argumentsText.length;
        if (event.argumentsText.length > 0) watchdog.progress();
      }

      if (event.type === "text_delta") {
        outputChars += event.text.length;
        if (event.text.length > 0) watchdog.progress();
      }

      if (event.type === "tool_call") {
        const chars = canonicalJson(event.arguments).length;
        if (!argumentChunks.has(event.toolCallId)) {
          argumentChars += chars;
          outputChars += chars;
          argumentChunks.add(event.toolCallId);
        }
        if (chars > 131072) {
          reason = "central_deliberation_output_limit";
          break;
        }
        if (Object.keys(event.arguments).length > 0) watchdog.progress();
      }

      if (outputChars > 131072) {
        reason = "central_deliberation_output_limit";
        break;
      }

      if (jsonObject && (event.type === "tool_input_start" || event.type === "tool_input_delta" || event.type === "tool_input_end"
        || event.type === "tool_call" || event.type === "tool_call_invalid")) {
        // No tool is advertised on this actual request. Even a historical
        // decision-tool name cannot grant a different output channel.
        reject("central_deliberation_tool_forbidden", "unexpected_tool");
        continue;
      }

      // Reasoning proves liveness only; its body is never retained as output.
      if (event.type === "reasoning_delta" && event.text.length > 0) watchdog.progress();

      if (rejectionReason !== undefined) continue;

      if (finish !== undefined) {
        reason = "central_deliberation_post_finish_event";
        break;
      }

      if (event.type === "tool_input_start") {
        if (event.name !== decisionToolName || toolStarts > 1 || toolId !== undefined) {
          reject("central_deliberation_tool_forbidden", event.name !== decisionToolName ? "unexpected_tool"
            : "tool_id_mismatch");
          continue;
        }
        toolId = event.toolCallId;
        assistantText = "";
      }

      if (event.type === "tool_input_delta") {
        if (event.toolCallId !== toolId || output !== undefined) {
          reject("central_deliberation_tool_invalid", "tool_id_mismatch");
          continue;
        }
        argumentsText += event.argumentsText;
      }

      if (event.type === "tool_input_end" && event.toolCallId !== toolId) {
        reject("central_deliberation_tool_invalid", "tool_id_mismatch");
        continue;
      }

      if (event.type === "tool_call_invalid") {
        reject("central_deliberation_tool_invalid", argumentsText.length === 0 ? "unknown" : classifyCentralToolArguments(argumentsText));
        continue;
      }

      if (event.type === "tool_call") {
        if (event.name !== decisionToolName || output !== undefined || toolId !== undefined && event.toolCallId !== toolId) {
          reject("central_deliberation_tool_forbidden", event.name !== decisionToolName ? "unexpected_tool"
            : "tool_id_mismatch");
          continue;
        }
        toolId = event.toolCallId;
        assistantText = "";
        output = event.arguments;
      }

      if (event.type === "text_delta") {
        // Prose is not a decision when a tool channel is present. It still
        // counts toward the output limit and never mixes with arguments.
        if (toolId === undefined) assistantText += event.text;
      }
    }

    if (reason === undefined && rejectionReason === undefined) {
      const terminal = jsonObject ? finish?.reason === "stop" && !finish.requiresFollowUp
        : toolId !== undefined ? output !== undefined && finish?.reason === "tool_calls" : finish?.reason === "stop";
      if (!exhausted || finish === undefined) reason = "central_deliberation_incomplete";
      else if (!terminal || finish.requiresFollowUp && output === undefined) reject("central_deliberation_incomplete",
        finish.reason === "length" ? "length_termination" : output === undefined && (toolId !== undefined || assistantText.trim().length === 0) ? "missing_output" : "unknown");
    }

    if (reason === undefined && rejectionReason === undefined && output === undefined) {
      try {
        // Legacy text JSON is a fallback only when no tool channel opened;
        // tool submissions require their completed canonical tool_call above.
        const parsed: unknown = JSON.parse(assistantText);
        if (jsonObject && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
          reject("central_deliberation_json_invalid", "non_object_json");
        } else output = parsed;
      }
      catch { reject("central_deliberation_json_invalid", assistantText.trim().length === 0 ? "missing_output" : classifyCentralToolArguments(assistantText)); }
    }
  } catch {
    reason ??= input.signal.aborted || !input.enabled() ? "central_deliberation_cancelled"
      : timedOut ? "central_deliberation_timeout" : "central_deliberation_transport_failed";
  } finally {
    try { watchdog.cancel(); }
    catch { reason ??= "central_deliberation_cleanup_failed"; }

    input.signal.removeEventListener("abort", abort);
    controller.abort();

    if (!exhausted && iterator?.return !== undefined) {
      // A remote transport may ignore return/abort; cleanup must not block conservative settlement.
      try { void iterator.return().catch(() => undefined); }
      catch { reason ??= "central_deliberation_cleanup_failed"; }
    }
  }

  const completeTerminal = finish !== undefined && ["stop", "tool_calls", "length"].includes(finish.reason);
  const usageTailComplete = exhausted && completeTerminal && reported && !tailIncomplete && reason === undefined;
  // A missing protocol frame disqualifies the decision and never grants a
  // paid recovery route. Cancellation and hard accounting failures retain
  // their original ownership even when a gap was also observed.
  const gap = unparseableSseFrames > 0;
  const hardFailure = reason === "central_deliberation_cancelled" || reason === "central_deliberation_token_overrun"
    || reason === "central_deliberation_usage_invalid";
  const primaryReason = hardFailure ? reason : gap ? "central_deliberation_stream_protocol_gap" : reason ?? rejectionReason;
  const boundary: LearningUsageBoundary = overrun ? { kind: "overrun" }
    : !exhausted || !completeTerminal || tailIncomplete ? { kind: "unknown", reason: primaryReason ?? "central_deliberation_usage_tail_incomplete" }
      : !reported ? { kind: "unknown", reason: "central_deliberation_usage_absent" }
        : reason !== undefined ? { kind: "unknown", reason } : { kind: "complete" };
  const diagnosticFields = {
    argumentChars, toolStarts, invalidTools,
    requestedOutputTokens: input.request.maxOutputTokens ?? null,
    finishReason: finish?.reason ?? null, usageObserved: reported, streamExhausted: exhausted, usageTailComplete,
  };
  let diagnostics: CentralDeliberationOutputDiagnostics | undefined;

  if (rejectionReason !== undefined) {
    if (jsonObject || gap || rejectionReason === "central_deliberation_stream_protocol_gap") {
      diagnostics = { schemaVersion: 2, ...diagnosticFields,
        rejectionReason: gap ? "central_deliberation_stream_protocol_gap" : rejectionReason,
        cause: gap ? "wire_frame_invalid" : rejectionCause, mode: jsonObject ? "json_object" : "tool", unparseableSseFrames };
    } else diagnostics = { schemaVersion: 1, ...diagnosticFields, rejectionReason, cause: rejectionCause };
  }

  return { output, usage, reported, boundary, ...(primaryReason === undefined ? {} : { reason: primaryReason }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(providerFailure === undefined ? {} : { providerFailure }) };
}
