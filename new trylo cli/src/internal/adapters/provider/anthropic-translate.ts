import type { ProviderEvent, ProviderFinishReason } from "../../ports/provider.js";
import { parseToolInput } from "./invalid-tool-input.js";

/**
 * Anthropic Messages wire event -> ProviderEvent translation (WP18.3: L68).
 *
 * Reuse: legacy `services/api/client.ts:89,213,243,337` (native vs Bedrock /
 * Vertex / Foundry branches with independent credential paths) and
 * `services/api/claude.ts:752` streaming (`message_start`, `content_block_*`,
 * `message_delta` usage/stop_reason). Only the *native* Messages wire is
 * translated here: Bedrock/Vertex/Foundry carry their own SDKs and credential
 * chains, which stay `source_missing` until their closures are audited —
 * porting their names without their auth would be the exact key-to-wrong-host
 * failure the credential ledger exists to prevent.
 *
 * Block discipline matches the other translators: text blocks are
 * `text-{index}`, reasoning blocks `reasoning-{index}`, tool calls assemble
 * by the wire's block index and settle with the wire's tool id.
 */

type AnthropicBlock = {
  readonly kind: "text" | "tool" | "reasoning";
  readonly id: string;
  readonly redacted: boolean;
};

type AnthropicToolAssembly = {
  readonly toolCallId: string;
  name: string;
  text: string;
};

type AnthropicState = {
  readonly blocks: Map<number, AnthropicBlock>;
  readonly tools: Map<number, AnthropicToolAssembly>;
  toolCallsEmitted: number;
  finished: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

export function createAnthropicTranslator() {
  const state: AnthropicState = { blocks: new Map(), tools: new Map(), toolCallsEmitted: 0, finished: false };
  return {
    push(event: string, payload: unknown): ProviderEvent[] {
      return pushAnthropicEvent(state, event, payload);
    },
    /** The stream ended without `message_delta`: close what is open. */
    complete(): ProviderEvent[] {
      if (state.finished) {
        return [];
      }
      return completeAnthropicStream(state, "other", "incomplete_stream");
    },
  };
}

function pushAnthropicEvent(state: AnthropicState, event: string, payload: unknown): ProviderEvent[] {
  // Same post-terminal rule as the other translators: a misbehaving endpoint
  // cannot reopen a settled stream.
  if (state.finished) {
    return [];
  }

  if (!isRecord(payload)) {
    return [];
  }

  switch (event) {
    case "message_start": {
      const message = payload["message"];
      if (!isRecord(message)) {
        return [];
      }

      const usage = message["usage"];
      if (!isRecord(usage)) {
        return [];
      }

      return [
        {
          type: "usage",
          usage: {
            mode: "snapshot",
            inputTokens: num(usage, "input_tokens"),
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: num(usage, "input_tokens"),
          },
        },
      ];
    }
    case "content_block_start":
      return blockStart(state, payload);
    case "content_block_delta":
      return blockDelta(state, payload);
    case "content_block_stop":
      return blockStop(state, payload);
    case "message_delta":
      return messageDelta(state, payload);
    case "message_stop":
      return [];
    case "ping":
      return [];
    case "error": {
      const inner = payload["error"];
      const message = isRecord(inner) ? str(inner, "message") : str(payload, "message");

      state.finished = true;

      return [
        {
          type: "error",
          class: "server",
          retryable: false,
          phase: "after_stream_started",
          message: message.length > 0 ? message : "anthropic_error",
        },
      ];
    }
    default:
      return [];
  }
}

/** A block opens: text, tool_use (by wire id), or thinking. */
function blockStart(state: AnthropicState, payload: Record<string, unknown>): ProviderEvent[] {
  const index = num(payload, "index");
  const block = payload["content_block"];
  if (!isRecord(block)) {
    return [];
  }

  const kind = str(block, "type");
  if (kind === "text") {
    const id = `text-${index}`;
    state.blocks.set(index, { kind: "text", id, redacted: false });
    return [{ type: "text_start", blockId: id }];
  }

  if (kind === "tool_use") {
    const id = str(block, "id").length > 0 ? str(block, "id") : `tool-${index}`;
    const name = str(block, "name");
    state.blocks.set(index, { kind: "tool", id, redacted: false });
    state.tools.set(index, { toolCallId: id, name, text: "" });
    return [{ type: "tool_input_start", toolCallId: id, name }];
  }

  if (kind === "thinking" || kind === "redacted_thinking") {
    const id = `reasoning-${index}`;
    const redacted = kind === "redacted_thinking";
    state.blocks.set(index, { kind: "reasoning", id, redacted });
    return [{ type: "reasoning_start", blockId: id, redacted }];
  }

  return [];
}

/** A fragment for the open block; unknown blocks are dropped, not invented. */
function blockDelta(state: AnthropicState, payload: Record<string, unknown>): ProviderEvent[] {
  const index = num(payload, "index");
  const open = state.blocks.get(index);
  if (open === undefined) {
    return [];
  }

  const delta = payload["delta"];
  if (!isRecord(delta)) {
    return [];
  }

  const kind = str(delta, "type");
  if (open.kind === "text" && kind === "text_delta") {
    const text = str(delta, "text");
    return text.length === 0 ? [] : [{ type: "text_delta", blockId: open.id, text }];
  }

  if (open.kind === "tool" && kind === "input_json_delta") {
    const fragment = str(delta, "partial_json");
    if (fragment.length === 0) {
      return [];
    }

    const assembly = state.tools.get(index);
    if (assembly !== undefined) {
      assembly.text += fragment;
    }

    return [{ type: "tool_input_delta", toolCallId: open.id, argumentsText: fragment }];
  }

  if (open.kind === "reasoning" && kind === "thinking_delta") {
    const text = str(delta, "thinking");
    return text.length === 0
      ? []
      : [{ type: "reasoning_delta", blockId: open.id, text, redacted: open.redacted }];
  }

  // `signature_delta` carries the opaque thinking signature, not text: the
  // client replays it verbatim when it re-sends the block, but it is never
  // rendered and therefore yields no event — same silence as any unknown
  // delta kind, stated explicitly so the drop reads as a decision.
  return [];
}

/** A block closes. Tool calls settle later, at `message_delta`, from fragments. */
function blockStop(state: AnthropicState, payload: Record<string, unknown>): ProviderEvent[] {
  const index = num(payload, "index");
  const open = state.blocks.get(index);
  if (open === undefined) {
    return [];
  }

  state.blocks.delete(index);

  if (open.kind === "text") {
    return [{ type: "text_end", blockId: open.id }];
  }

  if (open.kind === "reasoning") {
    return [{ type: "reasoning_end", blockId: open.id }];
  }

  return [{ type: "tool_input_end", toolCallId: open.id }];
}

/**
 * The terminal frame: output usage, then close what is open, settle every
 * tool call from its assembled fragments, then finish.
 *
 * Settlement lives here and in `completeAnthropicStream`, never in
 * `blockStop`: `content_block_stop` only ends the input stream, and settling
 * in both places would emit every call twice.
 */
function messageDelta(state: AnthropicState, payload: Record<string, unknown>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const delta = payload["delta"];
  const stopReason = isRecord(delta) ? str(delta, "stop_reason") : "";
  const usage = payload["usage"];

  // A zero-output usage frame carries no fact (`mergeUsage` with zeros is the
  // identity), so it is suppressed — the same all-zero rule the Responses
  // translator keeps, stated once per wire so a drift reads as a diff.
  if (isRecord(usage) && num(usage, "output_tokens") !== 0) {
    const output = num(usage, "output_tokens");
    events.push({
      type: "usage",
      usage: {
        mode: "snapshot",
        inputTokens: 0,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: output,
      },
    });
  }

  if (stopReason.length === 0) {
    return events;
  }

  state.finished = true;
  events.push(...closeOpenAnthropicBlocks(state));
  events.push(...settleAnthropicTools(state));
  const reason: ProviderFinishReason = mapStopReason(stopReason);

  events.push({
    type: "finish",
    reason,
    rawReason: stopReason,
    requiresFollowUp: stopReason === "tool_use",
  });

  return events;
}

function mapStopReason(raw: string): ProviderFinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "other";
  }
}

function closeOpenAnthropicBlocks(state: AnthropicState): ProviderEvent[] {
  const events: ProviderEvent[] = [];

  for (const [index, open] of [...state.blocks.entries()].sort((a, b) => a[0] - b[0])) {
    state.blocks.delete(index);
    if (open.kind === "text") {
      events.push({ type: "text_end", blockId: open.id });
    } else if (open.kind === "reasoning") {
      events.push({ type: "reasoning_end", blockId: open.id });
    } else {
      events.push({ type: "tool_input_end", toolCallId: open.id });
    }
  }

  return events;
}

/** Settle every assembled tool call, in wire order. Invalid JSON stays visible. */
function settleAnthropicTools(state: AnthropicState): ProviderEvent[] {
  const events: ProviderEvent[] = [];

  for (const [index, assembly] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
    state.tools.delete(index);
    state.toolCallsEmitted += 1;
    const parsed = parseToolInput(assembly.text);
    if (parsed.ok) {
      events.push({ type: "tool_call", toolCallId: assembly.toolCallId, name: assembly.name, arguments: parsed.arguments });
      continue;
    }

    events.push({
      type: "tool_call_invalid",
      toolCallId: assembly.toolCallId,
      name: assembly.name,
      rawArguments: "",
      message: parsed.message,
    });
  }

  return events;
}

/** The stream ended with no `message_delta`: close everything it left open. */
function completeAnthropicStream(
  state: AnthropicState,
  reason: ProviderFinishReason,
  rawReason: string,
): ProviderEvent[] {
  const events = closeOpenAnthropicBlocks(state);
  events.push(...settleAnthropicTools(state));
  events.push({ type: "finish", reason, rawReason, requiresFollowUp: state.toolCallsEmitted > 0 });
  return events;
}
