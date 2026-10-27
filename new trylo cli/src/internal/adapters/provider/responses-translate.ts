import type { ProviderEvent, ProviderFinishReason } from "../../ports/provider.js";
import { isResponseRecord as isRecord, responseString as str, responseNumber as num } from "./responses-fields.js";
import { createResponsesText } from "./responses-text.js";
import { createResponsesTools } from "./responses-tools.js";
import { createResponsesSummary } from "./responses-summary.js";
import { responsesProtocolError, responsesProviderError } from "./responses-error.js";

/**
 * Responses wire event -> ProviderEvent translation (WP18.2: C68).
 *
 * Reuse: Codex is Responses-only on the wire
 * (`model-provider-info/src/lib.rs:68 WireApi::Responses`, `:61` chat
 * explicitly rejected), so this file ports the event families Codex consumes
 * (`response.output_text.delta`, `response.function_call_arguments.delta`,
 * `response.completed/failed`, usage on the completed response) into the
 * canonical port. Structure mirrors `openai-translate.ts`: one function per
 * wire family, pure apart from the open-block assembly it owns.
 *
 * Block discipline matches the chat translator on purpose: text blocks are
 * `text-{output_index}`, reasoning blocks `reasoning-{output_index}`, and tool
 * calls assemble by `item_id`. A consumer reading both wires sees one shape.
 */

type ResponsesState = {
  readonly text: ReturnType<typeof createResponsesText>;
  readonly summary: ReturnType<typeof createResponsesSummary>;
  readonly tools: ReturnType<typeof createResponsesTools>;
  finished: boolean;
};

export function createResponsesTranslator() {
  const state: ResponsesState = {
    text: createResponsesText(),
    summary: createResponsesSummary(),
    tools: createResponsesTools(),
    finished: false,
  };
  return {
    push(event: string, payload: unknown): ProviderEvent[] {
      const events = pushResponsesEvent(state, event, payload);
      const failure = events.findIndex(one => one.type === "error");
      if (failure < 0) return events;
      state.finished = true;
      return events.slice(0, failure + 1);
    },
    /**
     * The stream ended without a terminal frame: close what is open and
     * report the missing terminal frame. After a terminal frame this is silent:
     * the blocks are already closed and a second finish would be invented output.
     */
    complete(): ProviderEvent[] {
      if (state.finished) {
        return [];
      }
      state.finished = true;
      return [...closeOpenResponsesBlocks(state), responsesProtocolError("responses_incomplete_stream")];
    },
  };
}

function pushResponsesEvent(
  state: ResponsesState,
  event: string,
  payload: unknown,
): ProviderEvent[] {
  // Nothing after a terminal frame may be treated as model output — the same
  // rule `loop/stream.ts` enforces one layer up, stated here too so a
  // misbehaving endpoint cannot reopen a settled stream.
  if (state.finished) {
    return [];
  }
  if (!isRecord(payload)) {
    return [];
  }
  switch (event) {
    case "response.output_text.delta":
      return state.text.delta(payload);
    case "response.output_text.done":
      return state.text.done(payload);
    case "response.output_item.added":
      return state.tools.added(payload);
    case "response.reasoning_summary_text.delta":
      return state.summary.delta(payload);
    case "response.reasoning_summary_text.done":
      return state.summary.textDone(payload);
    case "response.reasoning_summary_part.done":
      return state.summary.partDone(payload);
    case "response.function_call_arguments.delta":
      return state.tools.delta(payload);
    case "response.output_item.done":
      return outputItemDone(state, payload);
    case "response.completed":
      return completed(state, payload);
    case "response.failed":
      state.finished = true;
      return [responsesProviderError(payload, str(payload, "message").length > 0 ? str(payload, "message") : "response_failed")];
    case "response.incomplete":
      state.finished = true;
      return completeResponsesStream(state, "length", "response_incomplete");
    case "error":
      state.finished = true;
      return [responsesProviderError(payload, str(payload, "message").length > 0 ? str(payload, "message") : "response_error")];
    default:
      // Created/progress and per-part frames carry no new output text. The
      // output item's done frame owns block closure across all its parts.
      return [];
  }
}

/** Final items also recover missing streaming fragments. Helpers settle once. */
function outputItemDone(state: ResponsesState, payload: Record<string, unknown>): ProviderEvent[] {
  const item = payload["item"];
  if (!isRecord(item)) return [];
  if (item["type"] === "reasoning") return state.summary.itemDone(num(payload, "output_index"), item);
  if (item["type"] === "message") return state.text.itemDone(num(payload, "output_index"), item);
  return state.tools.done(payload);
}

/**
 * The terminal frame: usage first (so a consumer reading to `finish` still
 * sees it), then close what is open, settle every call, then finish.
 */
function completed(state: ResponsesState, payload: Record<string, unknown>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const response = payload["response"];
  const detail: Record<string, unknown> = isRecord(response) ? response : payload;
  const usage = usageEvent(detail["usage"]);
  if (usage !== undefined) {
    events.push(usage);
  }
  const status = str(detail, "status");
  state.finished = true;
  if (status === "failed") {
    events.push(responsesProviderError(detail, "response_failed"));
    return events;
  }
  if (status === "cancelled") return [...events, { type: "cancel_ack" }];
  // Some compatible endpoints omit status, but an explicit nonterminal or
  // unknown value never means completed, regardless of the event's name.
  if (status !== "" && status !== "completed" && status !== "incomplete") {
    return [...events, responsesProtocolError("responses_terminal_status_invalid")];
  }
  const reason: ProviderFinishReason = status === "incomplete" ? "length" : "stop";
  const output = detail["output"];
  if (Array.isArray(output)) output.forEach((item: unknown, output_index: number) => {
    events.push(...outputItemDone(state, { item, output_index }));
  });
  events.push(...closeOpenResponsesBlocks(state));
  events.push(...state.tools.complete());
  events.push({
    type: "finish",
    reason,
    rawReason: status.length > 0 ? status : "completed",
    requiresFollowUp: state.tools.count() > 0,
  });
  return events;
}

/** Usage on the completed response; absent usage yields nothing. */
function usageEvent(usage: unknown): ProviderEvent | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const input = num(usage, "input_tokens");
  const output = num(usage, "output_tokens");
  const total = num(usage, "total_tokens");
  if (input === 0 && output === 0 && total === 0) {
    return undefined;
  }
  return {
    type: "usage",
    usage: {
      mode: "snapshot",
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: isRecord(usage["input_tokens_details"]) ? num(usage["input_tokens_details"], "cached_tokens") : 0,
      cacheWriteTokens: 0,
      reasoningTokens: isRecord(usage["output_tokens_details"]) ? num(usage["output_tokens_details"], "reasoning_tokens") : 0,
      totalTokens: total,
    },
  };
}

function closeOpenResponsesBlocks(state: ResponsesState): ProviderEvent[] {
  return [...state.text.closeAll(), ...state.summary.closeAll()];
}

/** Explicit incomplete endings preserve their budget verdict without tools. */
function completeResponsesStream(
  state: ResponsesState,
  reason: ProviderFinishReason,
  rawReason: string,
): ProviderEvent[] {
  const events = closeOpenResponsesBlocks(state);
  events.push({ type: "finish", reason, rawReason, requiresFollowUp: false });
  return events;
}
