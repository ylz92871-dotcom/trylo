import type { JsonObject } from "../protocol/envelope.js";
import type { ProviderImageAttachment } from "./media.js";
import type { SessionRecord } from "./session.js";
import type { ImageReference } from "../protocol/image-reference.js";

/**
 * Provider-neutral streaming contract.
 *
 * Translation from any wire format lives in a per-provider pure state machine
 * (see `adapters/provider/**`). Nothing here knows about OpenAI, Anthropic or
 * any SDK type, and nothing here may leak into the domain reducer or the CLI.
 */

/** Stable within one provider stream; lets blocks interleave without ambiguity. */
export type ProviderBlockId = string;

export type ProviderRole = "system" | "user" | "assistant" | "tool";

/** Per-run reasoning control. Unsupported providers must refuse rather than
 * silently downgrade it; absence preserves the provider's existing default.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export type ProviderOutboundToolCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  /** Immutable original call identity; execution arguments may be normalized. */
  readonly originalArguments?: JsonObject;
};

export type ProviderMessage = {
  readonly role: ProviderRole;
  readonly content: string;
  /**
   * Validated images travelling with this message (WP19.1: C25, C26, L10).
   *
   * Absent or empty means text-only: every adapter serializes exactly what it
   * always sent. Present means the adapter emits the wire's own image part
   * beside the text — a path string is never a substitute for the bytes.
   * Carried, not applied, and not yet gated: refusing a run whose model
   * cannot see images belongs to the run layer (`demandModel` … modality
   * `image` at `prepareRun`), which is a named remaining seam (WP19 F3), not
   * a check this port performs. An `original` detail travels as stated; no
   * catalog narrows it today.
   */
  readonly attachments?: ReadonlyArray<ProviderImageAttachment>;
  /** Byte-free references resolved at the composition boundary before send. */
  readonly imageReferences?: ReadonlyArray<ImageReference>;
  /** Required when role is "tool": which call this result answers. */
  readonly toolCallId?: string;
  /** Assistant messages that requested tools carry them here. */
  readonly toolCalls?: ReadonlyArray<ProviderOutboundToolCall>;
};

export type ProviderToolSpec = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object describing `arguments`. */
  readonly parameters: JsonObject;
};

export type ProviderRequest = {
  readonly attemptId: string;
  /** Opaque execution-turn identity for adapter-owned native continuations.
   * Never a permission, transcript item or provider wire field. Absent disables
   * continuation caching; adapters must not reuse it across scopes/identities.
   */
  readonly continuationScope?: string;
  readonly model: string;
  readonly messages: ReadonlyArray<ProviderMessage>;
  readonly tools: ReadonlyArray<ProviderToolSpec>;
  readonly maxOutputTokens?: number;
  /**
   * JSON Schema the final answer must satisfy (WP18.3, C74/L67).
   *
   * Carried, not applied: the runner states it, the adapter sends it as the
   * wire's own `response_format`/`text.format`. Absent means the provider
   * decides its own shape, exactly as before this field existed.
   */
  readonly responseSchema?: JsonObject;
  /**
   * A caller-supplied system prompt (`--system-prompt` replace or
   * `--append-system-prompt` append, legacy L67). Applied once in
   * `loop/request.ts`; adapters send messages as-is.
   */
  readonly systemPrompt?: SystemPromptDirective;
  /**
   * Text appended as a system message after the seeds (`--append-system-prompt`
   * used together with `--system-prompt`). Kept separate from `systemPrompt`
   * because replace and append compose in order, and one field cannot state
   * both. Absent means nothing is appended.
   */
  readonly systemPromptAppend?: string;
};

/** How a caller-supplied system prompt combines with the assembled seeds. */
export const SYSTEM_PROMPT_MODES = ["replace", "append"] as const;
export type SystemPromptMode = (typeof SYSTEM_PROMPT_MODES)[number];

export type SystemPromptDirective = {
  readonly mode: SystemPromptMode;
  readonly text: string;
};

export function isSystemPromptMode(value: string): value is SystemPromptMode {
  return (SYSTEM_PROMPT_MODES as readonly string[]).includes(value);
}

export const PROVIDER_FINISH_REASONS = [
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "error",
  "other",
] as const;
export type ProviderFinishReason = (typeof PROVIDER_FINISH_REASONS)[number];

export const PROVIDER_ERROR_CLASSES = [
  "auth",
  "rate_limit",
  "quota",
  "invalid_request",
  "server",
  "network",
  "timeout",
  "cancelled",
  "protocol",
  "unknown",
] as const;
export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

/**
 * Where the error happened. This is the retry boundary: only `before_headers`
 * may be retried automatically. Once bytes are out, retrying would duplicate
 * text and tool calls.
 */
export const PROVIDER_STREAM_PHASES = ["before_headers", "after_stream_started"] as const;
export type ProviderStreamPhase = (typeof PROVIDER_STREAM_PHASES)[number];

/**
 * `snapshot` replaces the running total; `delta` adds to it. Aggregation must
 * respect this or usage will be double-counted.
 */
export type ProviderUsage = {
  readonly mode: "snapshot" | "delta";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
};

export type ProviderWarning = {
  readonly code: string;
  readonly message: string;
};

/**
 * Why a historical assistant occurrence has no usable native continuation.
 *
 * This is a closed set on purpose: a free-form string would let two adapters
 * name the same failure differently, and the presentation layer could not tell
 * "the provider never sends native fields" from "we lost them". Every member
 * requires positive evidence; when the evidence is missing the answer is
 * `unknown_source`, never a guess.
 *
 * `checkpoint_missing` is declared but not produced yet: proving one specific
 * message lost its checkpoint needs a per-occurrence key that the journal does
 * not carry. Reporting it today would be an inference, so an unclassifiable
 * message is reported as `unknown_source` with no count.
 */
export const NATIVE_CONTINUATION_CAUSES = [
  "checkpoint_missing",
  "checkpoint_invalid",
  "binding_mismatch",
  "cache_evicted",
  "history_mismatch",
  "capture_rejected",
] as const;
export type NativeContinuationCause = (typeof NATIVE_CONTINUATION_CAUSES)[number];
export type NativeContinuationUnknownCause = "unknown_source";

/**
 * The one observable shape of a native-continuation degradation.
 *
 * It deliberately carries no reasoning body, credential, endpoint or session
 * id: `noticeId` is a stable hash, so the same degradation is recognised across
 * processes and journal replays without exposing what was degraded.
 */
export type NativeContinuationDiagnostic = {
  readonly schemaVersion: 1;
  readonly cause: NativeContinuationCause | NativeContinuationUnknownCause;
  /** Affected occurrences; always 0 when `basis` is `unknown`. */
  readonly affected: number;
  readonly basis: "native_expected_occurrences" | "unknown";
  readonly severity: "degraded" | "info";
  /** Stable across processes/replays for the same reason + history set. */
  readonly noticeId: string;
};

/**
 * Runtime guard for the diagnostic arriving from a journal replay or another
 * process. A closed-set check, not a cast: an unknown cause from a newer writer
 * must be refused rather than rendered as if this build understood it.
 */
export function isNativeContinuationDiagnostic(value: unknown): value is NativeContinuationDiagnostic {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const causes: ReadonlyArray<string> = NATIVE_CONTINUATION_CAUSES;
  return fields["schemaVersion"] === 1
    && (fields["cause"] === "unknown_source" || causes.includes(String(fields["cause"])))
    && typeof fields["affected"] === "number" && Number.isInteger(fields["affected"]) && fields["affected"] >= 0
    && (fields["basis"] === "native_expected_occurrences" || fields["basis"] === "unknown")
    && (fields["severity"] === "degraded" || fields["severity"] === "info")
    && typeof fields["noticeId"] === "string" && fields["noticeId"].length > 0;
}

export type ProviderEvent =
  | {
      readonly type: "stream_start";
      readonly providerId: string;
      readonly model: string;
      readonly warnings: ReadonlyArray<ProviderWarning>;
    }
  | {
      readonly type: "warning";
      readonly code: string;
      readonly message: string;
      /**
       * Present only for degradations this build can classify. Consumers that
       * predate it keep rendering `code` + `message`, which stay unchanged in
       * meaning; the diagnostic is additive.
       */
      readonly diagnostic?: NativeContinuationDiagnostic;
    }
  | { readonly type: "text_start"; readonly blockId: ProviderBlockId }
  | { readonly type: "text_delta"; readonly blockId: ProviderBlockId; readonly text: string }
  | { readonly type: "text_end"; readonly blockId: ProviderBlockId }
  | { readonly type: "reasoning_start"; readonly blockId: ProviderBlockId; readonly redacted: boolean }
  | {
      readonly type: "reasoning_delta";
      readonly blockId: ProviderBlockId;
      readonly text: string;
      /** Repeated on every delta so consumers need no block table to honour it. */
      readonly redacted: boolean;
    }
  | { readonly type: "reasoning_end"; readonly blockId: ProviderBlockId }
  | { readonly type: "tool_input_start"; readonly toolCallId: string; readonly name: string }
  | {
      readonly type: "tool_input_delta";
      readonly toolCallId: string;
      /** Raw argument fragment; parsed once at `tool_call` time. */
      readonly argumentsText: string;
    }
  | { readonly type: "tool_input_end"; readonly toolCallId: string }
  | {
      readonly type: "tool_call";
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: "tool_call_invalid";
      readonly toolCallId: string;
      readonly name: string;
      /** Kept only long enough to report; never persisted as a fact. */
      readonly rawArguments: string;
      readonly message: string;
    }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | {
      readonly type: "finish";
      readonly reason: ProviderFinishReason;
      /** Provider's own reason string, for diagnostics only. */
      readonly rawReason: string;
      /** Provider contract requires another request even without tool results. */
      readonly requiresFollowUp: boolean;
    }
  | {
      readonly type: "error";
      readonly class: ProviderErrorClass;
      readonly retryable: boolean;
      readonly phase: ProviderStreamPhase;
      readonly message: string;
    }
  | {
      readonly type: "raw_unknown";
      /** Minimal, already-redacted identifier of the unrecognised wire event. */
      readonly wire: string;
      readonly metadata: JsonObject;
    }
  | { readonly type: "cancel_ack" };

export const PROVIDER_EVENT_TYPES = [
  "stream_start",
  "warning",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
  "tool_call_invalid",
  "usage",
  "finish",
  "error",
  "raw_unknown",
  "cancel_ack",
] as const;

export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

/** Opaque native wire state, persisted beside its completed stream envelope.
 * Only the adapter interprets it; it is never a display event or permission.
 */
export type ProviderContinuationPort = {
  /** Bind this completed response's trusted, post-rewrite assistant identity.
   * Called before stream_end is persisted; never accepts native reasoning from
   * the caller. An adapter must reject other scopes or different tool calls.
   * Optional: providers without native state keep their existing behavior.
   */
  readonly bindCanonicalResponse?: (input: { readonly scope: string; readonly message: ProviderMessage }) => void;
  /** Called by a durable recorder only after the notice envelope was appended. */
  readonly acknowledgeNotice?: (noticeId: string) => void;
  capture(scope: string): JsonObject | undefined;
  /** Pure estimate of native fields added to these exact outgoing messages. */
  readonly estimateOverheadTokens?: (messages: ReadonlyArray<ProviderMessage>) => number;
  restore(input: { readonly sessionId: string; readonly turnId: string; readonly records: ReadonlyArray<SessionRecord> }): void;
};

export function providerContinuationScope(sessionId: string | undefined, turnId: string | undefined): string {
  return JSON.stringify([sessionId, turnId]);
}

export type ProviderPort = {
    /** Same transport configuration with independent mutable continuation state.
     * Optional frozen history selects only matching adapter-owned native states;
     * caller/display reasoning is never a seed. A logical child owns this instance. */
  readonly fork?: (messages?: ReadonlyArray<ProviderMessage>) => ProviderPort;
  readonly continuation?: ProviderContinuationPort;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
};

export function emptyUsage(mode: ProviderUsage["mode"] = "snapshot"): ProviderUsage {
  return {
    mode,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

/**
 * Add one *stream's* usage to a turn running total.
 *
 * `mergeUsage` collapses usage within a single stream, where a snapshot is the
 * authoritative total for that one provider call. Across a turn's iterations
 * each stream is a separate call, so those per-stream totals add up. Using
 * `mergeUsage` here instead would report only the last iteration's tokens.
 */
export function accumulateUsage(current: ProviderUsage, stream: ProviderUsage): ProviderUsage {
  return {
    mode: "snapshot",
    inputTokens: current.inputTokens + stream.inputTokens,
    outputTokens: current.outputTokens + stream.outputTokens,
    cacheReadTokens: current.cacheReadTokens + stream.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + stream.cacheWriteTokens,
    reasoningTokens: current.reasoningTokens + stream.reasoningTokens,
    totalTokens: current.totalTokens + stream.totalTokens,
  };
}
/**
 * Merge usage *within one stream* according to its declared mode. Snapshots
 * replace; deltas add. The result is always a snapshot so callers cannot
 * double-count by accident.
 */
export function mergeUsage(current: ProviderUsage, incoming: ProviderUsage): ProviderUsage {
  if (incoming.mode === "snapshot") {
    return { ...incoming, mode: "snapshot" };
  }
  return {
    mode: "snapshot",
    inputTokens: current.inputTokens + incoming.inputTokens,
    outputTokens: current.outputTokens + incoming.outputTokens,
    cacheReadTokens: current.cacheReadTokens + incoming.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + incoming.cacheWriteTokens,
    reasoningTokens: current.reasoningTokens + incoming.reasoningTokens,
    totalTokens: current.totalTokens + incoming.totalTokens,
  };
}
