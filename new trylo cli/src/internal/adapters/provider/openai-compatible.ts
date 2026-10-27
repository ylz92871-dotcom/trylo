import type {
  NativeContinuationDiagnostic,
  ProviderErrorClass,
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ReasoningEffort,
} from "../../ports/provider.js";
import { translateBody } from "./openai-stream.js";
import { chatStructuredFields } from "./structured-output.js";
import { chatContentOf, unresolvedImageReference } from "../media/image-attachments.js";
import { chatSystemMessages } from "./chat-system-messages.js";
import { createGlmToolContinuation, type GlmToolContinuation } from "./glm-tool-continuation.js";
import { classifyHttpFailure } from "./http-failure-message.js";
export { classifyHttpStatus } from "./http-status.js";
import type { NativeCheckpointState } from "./glm-continuation-checkpoint.js";

/**
 * OpenAI-compatible streaming adapter over Node's built-in fetch.
 *
 * Two rules dominate this file:
 *  - retries happen only before the response body starts; once bytes are out,
 *    retrying would duplicate text and tool calls;
 *  - nothing here logs or persists request bodies, Authorization headers or raw
 *    unknown frames.
 */

export type TokenManagerLike = {
  readonly getValidAccessToken?: () => Promise<string>;
  readonly handleAuthError: (status: number) => Promise<{
    readonly refreshed: boolean;
    readonly token?: string;
    readonly reason?: string;
    readonly hint?: string;
  }>;
};

export type OpenAiCompatibleConfig = {
  readonly reasoningEffort?: ReasoningEffort;
  readonly endpoint: string;
  readonly model: string;
  /**
   * The resolved key, when one was resolved. The adapter never reads an
   * environment or a ledger itself: credential resolution is the composition
   * root's job (`CredentialPort`), so there is exactly one reader of any
   * credential source. The value is never logged.
   */
  readonly apiKey?: string;
  readonly tokenManager?: TokenManagerLike;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttemptsBeforeHeaders?: number;
  readonly baseRetryDelayMs?: number;
};

export const DEFAULT_MAX_ATTEMPTS_BEFORE_HEADERS = 3;
export const DEFAULT_BASE_RETRY_DELAY_MS = 200;

export type CredentialStatus =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly reason: "missing_endpoint" | "missing_api_key" };

export function readCredential(config: OpenAiCompatibleConfig): CredentialStatus {
  if (config.endpoint.length === 0) {
    return { ok: false, reason: "missing_endpoint" };
  }
  const value = config.apiKey;
  if ((value === undefined || value.length === 0) && config.tokenManager === undefined) {
    return { ok: false, reason: "missing_api_key" };
  }
  return { ok: true, apiKey: value ?? "" };
}

export function isRetryableClass(consumer: ProviderErrorClass): boolean {
  return consumer === "rate_limit" || consumer === "server" || consumer === "network" || consumer === "timeout";
}

/**
 * The shipping retry policy for one request, resolved once per stream so the
 * attempt loop below reads as plain numbers.
 */
type AttemptPolicy = {
  readonly body: string;
  readonly doFetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts: number;
  readonly baseDelay: number;
};

function attemptPolicyOf(config: OpenAiCompatibleConfig, body: unknown): AttemptPolicy {
  return {
    body: JSON.stringify(body),
    doFetch: config.fetchImpl ?? globalThis.fetch,
    sleep: config.sleep ?? defaultSleep,
    maxAttempts: config.maxAttemptsBeforeHeaders ?? DEFAULT_MAX_ATTEMPTS_BEFORE_HEADERS,
    baseDelay: config.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
  };
}

/** Either a response to stream, or the event that ends the attempt loop. */
type FetchOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failed"; readonly event: ProviderEvent };

/**
 * One attempt's send. Returns the response on success, or the single event the
 * caller must yield. Retries are decided by the caller: this only reports what
 * happened, so "retryable" stays one decision in one place.
 */
async function sendOnce(
  config: OpenAiCompatibleConfig,
  apiKey: string,
  policy: AttemptPolicy,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  try {
    const response = await policy.doFetch(config.endpoint, {
      method: "POST",
      headers: buildHeaders(config, apiKey),
      body: policy.body,
      signal,
    });
    return { kind: "response", response };
  } catch {
    return {
      kind: "failed",
      event: {
        type: "error",
        class: signal.aborted ? "cancelled" : "network",
        retryable: true,
        phase: "before_headers",
        message: signal.aborted ? "cancelled" : "network",
      },
    };
  }
}

/**
 * The attempt loop, stopping at the first response that may be streamed.
 *
 * Only failures before the body starts are retried — once bytes are out,
 * re-sending would duplicate text and tool calls. A non-2xx status is a failure
 * with a classified, replayable event, unless the class is not retryable or the
 * attempts are spent, in which case the loop still stops.
 */
async function acquireResponse(
  config: OpenAiCompatibleConfig,
  apiKey: string,
  policy: AttemptPolicy,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  let lastClass: ProviderErrorClass = "network";
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const outcome = await sendOnce(config, apiKey, policy, signal);
    if (outcome.kind === "failed") {
      const event = outcome.event;
      if (event.type === "error" && event.class === "cancelled") {
        return outcome;
      }
      if (attempt < policy.maxAttempts) {
        await policy.sleep(policy.baseDelay * attempt);
        continue;
      }
      // Out of attempts: the last failure is the turn's, and it is retryable so
      // an outer caller may try the whole turn again.
      return { kind: "failed", event };
    }
    if (outcome.response.ok) {
      return outcome;
    }
    if (outcome.response.status === 401 && config.tokenManager) {
      await outcome.response.body?.cancel();
      const refreshed = await config.tokenManager.handleAuthError(401);
      if (refreshed.refreshed && refreshed.token) {
        // Bounded retry with the renewed token (max 1 retry for 401)
        const retryOutcome = await sendOnce(config, refreshed.token, policy, signal);
        if (retryOutcome.kind === "response" && retryOutcome.response.ok) {
          return retryOutcome;
        }
        if (retryOutcome.kind === "response") await retryOutcome.response.body?.cancel();
        const retryStatus = retryOutcome.kind === "response" ? retryOutcome.response.status : 0;
        return {
          kind: "failed",
          event: {
            type: "error",
            class: "auth",
            retryable: false,
            phase: "before_headers",
            message: `http_${retryStatus || 401}`,
          },
        };
      }
      return {
        kind: "failed",
        event: {
          type: "error",
          class: "auth",
          retryable: false,
          phase: "before_headers",
          message: `token_refresh_failed: ${refreshed.reason}`,
        },
      };
    }
    const failure = await classifyHttpFailure(outcome.response, signal);
    lastClass = failure.class;
    const retryable = isRetryableClass(lastClass);
    if (retryable && attempt < policy.maxAttempts) {
      await policy.sleep(policy.baseDelay * attempt);
      continue;
    }
    const message = failure.message;
    // HTTP diagnostics are not model output; recovery remains before headers.
    return {
      kind: "failed",
      event: {
        type: "error",
        class: signal.aborted ? "cancelled" : lastClass,
        retryable: !signal.aborted && retryable,
        phase: "before_headers",
        message: signal.aborted ? "cancelled" : message,
      },
    };
  }
  return {
    kind: "failed",
    event: {
      type: "error",
      class: lastClass,
      retryable: isRetryableClass(lastClass),
      phase: "before_headers",
      message: "no_response_body",
    },
  };
}

/**
 * The one Chinese sentence a user sees when native continuation degraded.
 *
 * It states what the run does next, not what was lost in "messages": the count
 * is occurrences of missing native state, and calling those "chats" or
 * "context lost" would overstate a technical degradation. When the count is not
 * evidence-backed the sentence carries no number at all.
 */
export function nativeContinuationNotice(diagnostic: NativeContinuationDiagnostic): string {
  const headline = diagnostic.basis === "native_expected_occurrences" && diagnostic.affected > 0
    ? `部分历史的模型续接数据无法恢复（${diagnostic.affected} 条），本轮将使用可见对话继续。`
    : "部分历史缺少模型续接来源，本轮将使用可见对话继续。";
  return headline;
}

export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig, inherited: ReadonlyArray<NativeCheckpointState> = []): ProviderPort {
  const continuations = createGlmToolContinuation(config.endpoint, config.model, inherited);
  return {
    fork: messages => createOpenAiCompatibleProvider(config, continuations.copyMatching(messages ?? [])),
    ...(continuations.persistence === undefined ? {} : { continuation: continuations.persistence }),
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const unresolved = unresolvedImageReference(request);
      if (unresolved !== undefined) { yield unresolved; return; }
      const credential = readCredential(config);
      if (!credential.ok) {
        yield {
          type: "error",
          class: credential.reason === "missing_api_key" ? "auth" : "invalid_request",
          retryable: false,
          phase: "before_headers",
          message: credential.reason,
        };
        return;
      }
      const continuation = continuations.begin(request);
      const policy = attemptPolicyOf(config, buildBody(config, request, continuation));
      let apiKey = credential.apiKey;
      if (config.tokenManager?.getValidAccessToken) {
        try {
          apiKey = await config.tokenManager.getValidAccessToken();
        } catch {
          // fallback to credential.apiKey
        }
      }
      const acquired = await acquireResponse(config, apiKey, policy, signal);
      if (acquired.kind === "failed") {
        yield acquired.event;
        return;
      }
      const body = acquired.response.body;
      if (body === null) {
        yield {
          type: "error",
          class: "network",
          retryable: false,
          phase: "before_headers",
          message: "no_response_body",
        };
        return;
      }
      yield {
        type: "stream_start",
        providerId: "openai-compatible",
        model: config.model,
        warnings: [],
      };
      if (continuation?.diagnostic !== undefined) {
        yield {
          type: "warning", code: "native_continuation_unavailable",
          message: nativeContinuationNotice(continuation.diagnostic),
          diagnostic: continuation.diagnostic,
        };
      }
      for await (const event of translateBody(body, signal)) {
        continuation?.observe(event);
        // The loop stops pulling at finish. Retain a complete native response
        // before handing over that terminal event, not after the next pull.
        if (event.type === "finish" && !signal.aborted) continuation?.commit();
        yield event;
      }
    },
  };
}

function buildHeaders(config: OpenAiCompatibleConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.headers ?? {}),
  };
  if (apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildBody(config: OpenAiCompatibleConfig, request: ProviderRequest, continuation?: GlmToolContinuation): unknown {
  const model = request.model.length > 0 ? request.model : config.model;
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    messages: chatSystemMessages(config.endpoint, model, request.messages).map((message) => ({
      role: message.role,
      // WP19.1: text-only messages return the same string as before; an
      // attached image becomes the wire's own image_url part beside the text.
      content: chatContentOf(message.content, message.attachments),
      ...continuation?.fieldsFor(message),
      ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls !== undefined
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.toolCallId,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(
                continuation === undefined ? call.arguments : call.originalArguments ?? call.arguments,
              ) },
            })),
          }
        : {}),
    })),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }
      : {}),
    // `--max-tokens`: sent as the provider's own `max_tokens` (opencode does
    // the same rename to `max_completion_tokens` where the family needs it).
    // Absent means no key at all — never a default that would cap a run nobody
    // asked to cap.
    ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    ...(config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort }),
    // `--output-schema`: sent as the provider's own `response_format`. Absent
    // means no key at all — a run that never asked for structure sends byte
    // for byte what it always sent, and an endpoint that cannot honour it
    // refuses with 400 (`invalid_request`), never with silent plain text.
    ...(chatStructuredFields(request.responseSchema) ?? {}),
  };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
