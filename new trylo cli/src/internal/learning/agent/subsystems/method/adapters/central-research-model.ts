import { emptyUsage, mergeUsage, type ProviderPort, type ProviderUsage } from "../../../../../ports/provider.js";
import { systemTimerScheduler, type TimerScheduler } from "../../../../../subagent/scheduler.js";
import { learningUsageSettlement } from "../../../../control/usage-settlement.js";
import { isMethodResearchFinding, rejectedMethodResearchField, type MethodResearchFinding } from "./central-research-records.js";
import { METHOD_RESEARCH_TIMING } from "./central-research-capacity.js";
import { contentHashOf } from "../../../../control/hash.js";

export const METHOD_RESEARCH_INSTRUCTION = `You are Trylo's method research worker. Pursue the original learning purpose using its supplied real material and prior public findings.
Return exactly one JSON object, without Markdown fences, commentary or additional fields:
{"kind":"finding","statement":"Interpretation of supplied evidence","conditions":"Where it applies","sourceRefs":["an exact supplied ref"],"residual":["An unresolved question"]}
kind is one of finding, candidate, waiting, stopped. statement and conditions are nonempty strings of at most 6000 and 3000 characters. sourceRefs contains 1-32 distinct exact supplied refs. residual contains 0-16 nonempty strings, each at most 2000 characters.
Only kind=candidate must additionally include:
"candidate":{"hint":"The proposed method, at most 200 characters","scope":{"description":"Applicability, at most 1500 characters","predicate":{"all":[{"feature":"feature name","value":"required value"}],"exclude":[]}}}
Use 1-6 literals total across all and exclude, without duplicate literals or conflicting values of a required feature. feature and value are nonempty strings of at most 64 and 160 characters. Other kinds omit candidate entirely; do not use null. A future real task must independently supply matching feature values.
For kind=candidate, the complete object shape is:
{"kind":"candidate","statement":"Evidence-grounded interpretation","conditions":"Applicability and limits","sourceRefs":["an exact supplied ref"],"residual":[],"candidate":{"hint":"A concise method proposal","scope":{"description":"Applicable task context","predicate":{"all":[{"feature":"artifact_type","value":"technical_documentation"}],"exclude":[]}}}}
The example's prose and feature values are illustrative, not a required proposal or observed facts. sourceRefs and residual contain strings, not objects. Do not encode the entire object as a JSON string. Return waiting or stopped when warranted, with the first five fields and no candidate field.
Findings are interpretations, never new business observations. A candidate is proposed, never verified, adopted or active. State counterexamples and unresolved questions; request external evidence only when the existing material cannot advance the purpose. Do not execute tools, grant permissions or claim goal completion.`;

/** A bounded provider call. Unknown or incomplete billing retains its full reservation. */
export async function runCentralMethodResearchModel(options: { readonly provider: ProviderPort; readonly model: string;
  readonly reservationId: string; readonly material: string; readonly maxTokens: number; readonly maxOutputTokens: number;
  readonly enabled: () => boolean; readonly scheduler?: TimerScheduler; readonly timeoutMs?: number }, signal: AbortSignal) {
  const controller = new AbortController(), abort = () => controller.abort();

  signal.addEventListener("abort", abort, { once: true });
  let reason: string | undefined;
  const timer = (options.scheduler ?? systemTimerScheduler)(options.timeoutMs ?? METHOD_RESEARCH_TIMING.timeoutMs,
    () => {
      reason = "method_research_timeout";
      controller.abort();
    });
  let usage = emptyUsage(), reported = false, complete = false, started = false, tailIncomplete = false, output = "";

  try {
    if (signal.aborted || !options.enabled()) controller.abort();

    const iterator = options.provider.stream({ attemptId: options.reservationId, model: options.model, tools: [],
      ...(options.provider.responseFormats?.includes("json_object") ? { responseFormat: { type: "json_object" as const } } : {}),
      maxOutputTokens: options.maxOutputTokens, messages: [{ role: "system", content: METHOD_RESEARCH_INSTRUCTION },
        { role: "user", content: options.material }] }, controller.signal)[Symbol.asyncIterator]();

    for (;;) {
      const next = await nextBeforeAbort(iterator, controller.signal);
      if (next.done) break;

      const event = next.value;

      if (!options.enabled() || signal.aborted) {
        reason = "method_research_cancelled";
        controller.abort();
        break;
      }

      if (event.type === "stream_start") started = true;

      if (event.type === "usage") {
        if (!validUsage(event.usage)) {
          reason = "method_research_usage_invalid";
          break;
        }
        usage = mergeUsage(usage, event.usage);
        reported = true;
        if (usage.totalTokens > options.maxTokens) {
          reason = "method_research_budget_overrun";
          break;
        }
      }

      if (event.type === "warning" && event.code === "stream_finish_tail_timeout") tailIncomplete = true;

      if (event.type === "text_delta") output += event.text;

      if (output.length > options.maxOutputTokens * 16) {
        reason = "method_research_output_capacity";
        break;
      }

      if (event.type === "finish") complete = event.reason === "stop" && !event.requiresFollowUp;

      if (event.type === "error" || event.type === "cancel_ack") {
        reason = "method_research_provider_failed";
        break;
      }

      if (["tool_call", "tool_call_invalid", "tool_input_start"].includes(event.type)) {
        reason = "method_research_tool_forbidden";
        break;
      }
    }

    if (!started || !complete || controller.signal.aborted) reason ??= "method_research_incomplete";
  } catch { reason ??= signal.aborted ? "method_research_cancelled" : "method_research_provider_failed"; }
  finally {
    timer.cancel();
    signal.removeEventListener("abort", abort);
    controller.abort();
  }

  const boundary = usage.totalTokens > options.maxTokens ? { kind: "overrun" as const }
    : reason !== undefined || tailIncomplete || !reported ? { kind: "unknown" as const,
      reason: reason ?? (tailIncomplete ? "method_research_usage_tail_incomplete" : "method_research_usage_absent") }
      : { kind: "complete" as const };
  const settlement = learningUsageSettlement(boundary, { totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: options.model });
  let finding: MethodResearchFinding | undefined, rejectedField: string | undefined;

  if (reason === undefined) {
    try { const raw: unknown = JSON.parse(output);
    if (isMethodResearchFinding(raw)) finding = raw;
      else rejectedField = rejectedMethodResearchField(raw); }
    catch {
      reason = "method_research_output_invalid";
      rejectedField = "json_syntax";
    }
    if (finding === undefined) reason ??= "method_research_output_invalid";
  }

  return { settlement, finding, reason,
    ...(reason === "method_research_output_invalid" && settlement.kind === "reported"
      ? { rejectedOutputHash: contentHashOf(output), rejectedField: rejectedField ?? "object_fields" } : {}) };
}

function validUsage(usage: ProviderUsage) {
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens, usage.totalTokens]
    .every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

async function nextBeforeAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new Error("method_research_aborted");

  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("method_research_aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });

  try { return await Promise.race([iterator.next(), stopped]); }
  finally { if (abort !== undefined) signal.removeEventListener("abort", abort); }
}
