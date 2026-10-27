import type { ProviderEvent, ProviderFinishReason } from "../../ports/provider.js";
import { parseToolInput } from "./invalid-tool-input.js";
import { openAiStreamError } from "./openai-stream-error.js";

/**
 * OpenAI wire chunk -> ProviderEvent translation.
 *
 * Pure apart from the open-block assembly it owns, so the whole state machine
 * can be exercised without a socket. The adapter keeps transport, retry and
 * credential concerns; this file only knows what the wire looks like.
 *
 * One function per wire family — usage, text, reasoning, tool calls, finish —
 * because each has its own shape and its own way of being wrong. A single
 * `push` that knew all five would have to be read whole to be read at all.
 */

type OpenToolAssembly = {
  id: string;
  name: string;
  text: string;
};

/** The translation's memory: blocks still open, tool calls still assembling. */
type TranslatorState = {
  readonly tools: Map<number, OpenToolAssembly>;
  textBlock: string | undefined;
  reasoningBlock: string | undefined;
};

function mapFinishReason(raw: string): ProviderFinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "other";
  }
}

export function createOpenAiTranslator() {
  const state: TranslatorState = {
    tools: new Map<number, OpenToolAssembly>(),
    textBlock: undefined,
    reasoningBlock: undefined,
  };

  return {
    push(payload: unknown): ProviderEvent[] {
      return pushChunk(state, payload);
    },
    /** Called when the stream ends without a finish_reason chunk. */
    complete(): ProviderEvent[] {
      return completeStream(state);
    },
  };
}

/**
 * One chunk, in the wire's own order: usage, then the first choice's delta
 * (text, reasoning, tool calls), then a finish reason if this chunk carries one.
 *
 * A chunk with no choices — a usage-only or keep-alive frame — still reports
 * the usage it came with and stops there.
 */
function pushChunk(state: TranslatorState, payload: unknown): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  if (typeof payload !== "object" || payload === null) {
    return events;
  }
  const record = payload as Record<string, unknown>;
  const usage = usageEvent(record.usage);
  if (usage !== undefined) {
    events.push(usage);
  }
  const failure = openAiStreamError(record.error);
  if (failure !== undefined) return [...events, failure];
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return events;
  }
  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta;
  // Completion metadata is independent from content. Compatible gateways may
  // end with a null/omitted delta; dropping it loses finish and native state.
  const deltaRecord = typeof delta === "object" && delta !== null ? delta as Record<string, unknown> : {};
  events.push(...textEvents(state, deltaRecord.content));
  // Two spellings exist in the wild: `reasoning_content` (DeepSeek/OpenRouter
  // style) and `reasoning` on the delta. The AMD MiMo endpoint sends *both* — a
  // `reasoning_content: null` placeholder on content frames and the text under
  // `reasoning` — so reading only the first field made the model's thinking
  // silently invisible: no error, just nothing. `??` keeps providers that fill
  // `reasoning_content` byte-for-byte unchanged, and a null placeholder can no
  // longer mask the field that actually carries text.
  events.push(...reasoningEvents(state, deltaRecord.reasoning_content ?? deltaRecord.reasoning));
  events.push(...toolCallEvents(state, deltaRecord.tool_calls));
  events.push(...finishEvents(state, choice.finish_reason));
  return events;
}

/** The usage frame, when the chunk carried one. Absent usage yields nothing. */
function usageEvent(usage: unknown): ProviderEvent | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const num = (key: string): number =>
    typeof record[key] === "number" ? (record[key] as number) : 0;
  const details = (key: string): number => {
    const nested = record[key];
    if (typeof nested === "object" && nested !== null) {
      const value = (nested as Record<string, unknown>).cached_tokens;
      return typeof value === "number" ? value : 0;
    }
    return 0;
  };
  return {
    type: "usage",
    usage: {
      mode: "snapshot",
      inputTokens: num("prompt_tokens"),
      outputTokens: num("completion_tokens"),
      cacheReadTokens: details("prompt_tokens_details"),
      cacheWriteTokens: 0,
      // Reasoning is a subset of completion tokens, never an extra output charge.
      reasoningTokens: reasoningTokenCount(record),
      totalTokens: num("total_tokens"),
    },
  };
}

function reasoningTokenCount(record: Record<string, unknown>): number {
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (valid(record.reasoning_tokens)) return record.reasoning_tokens;
  const details = record.completion_tokens_details;
  if (typeof details !== "object" || details === null) return 0;
  const value = (details as Record<string, unknown>).reasoning_tokens;
  return valid(value) ? value : 0;
}

/** Text deltas; the block opens the first time content appears. */
function textEvents(state: TranslatorState, content: unknown): ProviderEvent[] {
  if (typeof content !== "string" || content.length === 0) {
    return [];
  }
  const events: ProviderEvent[] = [];
  if (state.textBlock === undefined) {
    state.textBlock = "text-0";
    events.push({ type: "text_start", blockId: state.textBlock });
  }
  events.push({ type: "text_delta", blockId: state.textBlock, text: content });
  return events;
}

/**
 * Reasoning deltas, same block discipline as text.
 *
 * `redacted: false` is the wire's own answer: a separate summary field would
 * have to arrive on the wire before this could claim otherwise.
 */
function reasoningEvents(state: TranslatorState, content: unknown): ProviderEvent[] {
  if (typeof content !== "string" || content.length === 0) {
    return [];
  }
  const events: ProviderEvent[] = [];
  if (state.reasoningBlock === undefined) {
    state.reasoningBlock = "reasoning-0";
    events.push({ type: "reasoning_start", blockId: state.reasoningBlock, redacted: false });
  }
  events.push({
    type: "reasoning_delta",
    blockId: state.reasoningBlock,
    text: content,
    redacted: false,
  });
  return events;
}

/**
 * Tool call deltas, keyed by the wire's `index`.
 *
 * A call announces itself once (`id`/`name`) and then streams its arguments in
 * fragments across later chunks; the first mention opens the assembly, every
 * later one appends. A fragment that arrives before any name is kept as text —
 * the name may still follow, and losing the fragment would lose the call.
 */
function toolCallEvents(state: TranslatorState, toolCalls: unknown): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  if (!Array.isArray(toolCalls)) {
    return events;
  }
  for (const raw of toolCalls) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const call = raw as Record<string, unknown>;
    const index = typeof call.index === "number" ? call.index : 0;
    const id = typeof call.id === "string" ? call.id : `call-${index}`;
    const fn = call.function;
    const fnRecord = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : {};
    const name = typeof fnRecord.name === "string" ? fnRecord.name : "";
    const argsText = typeof fnRecord.arguments === "string" ? fnRecord.arguments : "";
    const existing = state.tools.get(index);
    if (existing === undefined) {
      state.tools.set(index, { id, name, text: argsText });
      events.push({ type: "tool_input_start", toolCallId: id, name });
      if (argsText.length > 0) {
        events.push({ type: "tool_input_delta", toolCallId: id, argumentsText: argsText });
      }
      continue;
    }
    existing.text += argsText;
    if (name.length > 0 && existing.name.length === 0) {
      existing.name = name;
    }
    if (argsText.length > 0) {
      // The *open* call's id, not this fragment's: later fragments carry only
      // `index` and `arguments`, and re-deriving an id here (`call-0`) would
      // point the delta at a call that was never opened — where the stream
      // accumulator drops it silently, losing every argument after the first.
      events.push({ type: "tool_input_delta", toolCallId: existing.id, argumentsText: argsText });
    }
  }
  return events;
}

/**
 * The terminal chunk: close what is open, settle every tool call, then finish.
 *
 * The finish reason arrives *after* the deltas it concludes, so the blocks are
 * closed here rather than when their last delta was seen — a stream that ends
 * without one closes them in `completeStream` instead.
 */
function finishEvents(state: TranslatorState, finishReason: unknown): ProviderEvent[] {
  if (typeof finishReason !== "string" || finishReason.length === 0) {
    return [];
  }
  const events = closeOpenBlocks(state);
  const tools = closeAllTools(state);
  events.push(...tools);
  events.push({
    type: "finish",
    reason: mapFinishReason(finishReason),
    rawReason: finishReason,
    requiresFollowUp: finishReason === "tool_calls" || (finishReason === "stop" && tools.length > 0),
  });
  return events;
}

/** Ends the open text and reasoning blocks, if any. */
function closeOpenBlocks(state: TranslatorState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  if (state.textBlock !== undefined) {
    events.push({ type: "text_end", blockId: state.textBlock });
    state.textBlock = undefined;
  }
  if (state.reasoningBlock !== undefined) {
    events.push({ type: "reasoning_end", blockId: state.reasoningBlock });
    state.reasoningBlock = undefined;
  }
  return events;
}

/** Settles every open tool call, in wire order. Invalid arguments stay visible. */
function closeAllTools(state: TranslatorState): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const [index, assembly] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
    state.tools.delete(index);
    const parsed = parseToolInput(assembly.text);
    if (parsed.ok) {
      events.push({ type: "tool_call", toolCallId: assembly.id, name: assembly.name, arguments: parsed.arguments });
      continue;
    }
    events.push({
      type: "tool_call_invalid",
      toolCallId: assembly.id,
      name: assembly.name,
      rawArguments: "",
      message: parsed.message,
    });
  }
  return events;
}

/** The stream ended with no finish reason: close everything it left open. */
function completeStream(state: TranslatorState): ProviderEvent[] {
  const events = closeOpenBlocks(state);
  events.push(...closeAllTools(state));
  return events;
}
