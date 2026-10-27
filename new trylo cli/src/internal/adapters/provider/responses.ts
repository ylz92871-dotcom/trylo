import type {
  ProviderErrorClass,
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
  ReasoningEffort,
} from "../../ports/provider.js";
import {
  isRetryableClass,
  type TokenManagerLike,
} from "./openai-compatible.js";
import { classifyHttpFailure } from "./http-failure-message.js";
import { responsesStructuredFields } from "./structured-output.js";
import { translateResponsesBody } from "./responses-stream.js";
import { responsesContentOf, unresolvedImageReference } from "../media/image-attachments.js";

/**
 * Responses wire adapter over Node's built-in fetch (WP18.2: C68, C71).
 *
 * Reuse: Codex is Responses-only on the wire
 * (`model-provider-info/src/lib.rs:68 WireApi::Responses`), and this adapter
 * is the `/responses` half of the same retry contract the Chat Completions
 * adapter keeps: retries happen only before the response body starts
 * (`C71 before/after stream` semantics), a 401 refreshes once through the same
 * `TokenManagerLike`, and nothing here logs request bodies or credentials.
 * The classification vocabulary (`classifyHttpStatus`/`isRetryableClass`) is
 * imported, not copied — one decision in one place.
 *
 * Selected by declaration kind `openai-responses`, never by sniffing: an
 * endpoint that speaks `/chat/completions` receiving a `/responses` body
 * would fail far from the typo, so the wire is stated in `providers.json`.
 */

export type ResponsesConfig = {
  readonly reasoningEffort?: ReasoningEffort;
  readonly endpoint: string;
  readonly model: string;
  /**
   * The resolved key, when one was resolved. Same rule as the chat adapter:
   * the adapter never reads an environment or a ledger itself.
   */
  readonly apiKey?: string;
  readonly tokenManager?: TokenManagerLike;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttemptsBeforeHeaders?: number;
  readonly baseRetryDelayMs?: number;
  /** Opt in only when the selected declaration says it supports reasoning. */
  readonly reasoningSummary?: "auto";
};

export const RESPONSES_DEFAULT_MAX_ATTEMPTS = 3;
export const RESPONSES_DEFAULT_BASE_RETRY_DELAY_MS = 200;

export type ResponsesCredentialStatus =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly reason: "missing_endpoint" | "missing_api_key" };

export function readResponsesCredential(config: ResponsesConfig): ResponsesCredentialStatus {
  if (config.endpoint.length === 0) {
    return { ok: false, reason: "missing_endpoint" };
  }
  const value = config.apiKey;
  if ((value === undefined || value.length === 0) && config.tokenManager === undefined) {
    return { ok: false, reason: "missing_api_key" };
  }
  return { ok: true, apiKey: value ?? "" };
}

type ResponsesAttemptPolicy = {
  readonly doFetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts: number;
  readonly baseDelay: number;
};

function attemptPolicyOf(config: ResponsesConfig): ResponsesAttemptPolicy {
  return {
    doFetch: config.fetchImpl ?? globalThis.fetch,
    sleep: config.sleep ?? defaultSleep,
    maxAttempts: config.maxAttemptsBeforeHeaders ?? RESPONSES_DEFAULT_MAX_ATTEMPTS,
    baseDelay: config.baseRetryDelayMs ?? RESPONSES_DEFAULT_BASE_RETRY_DELAY_MS,
  };
}

type FetchOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failed"; readonly event: ProviderEvent };

/** One attempt's send: the response, or the single event the caller yields. */
async function sendOnce(
  config: ResponsesConfig,
  request: ProviderRequest,
  apiKey: string,
  policy: ResponsesAttemptPolicy,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  try {
    const response = await policy.doFetch(config.endpoint, {
      method: "POST",
      headers: buildResponsesHeaders(config, apiKey),
      body: JSON.stringify(buildResponsesBody(config, request)),
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
 * Only failures before the body starts are retried — the same boundary the
 * chat adapter keeps, so a retried Responses request never duplicates text
 * or tool calls either.
 */
async function acquireResponsesResponse(
  config: ResponsesConfig,
  request: ProviderRequest,
  apiKey: string,
  policy: ResponsesAttemptPolicy,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  let lastClass: ProviderErrorClass = "network";
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const outcome = await sendOnce(config, request, apiKey, policy, signal);
    if (outcome.kind === "failed") {
      const event = outcome.event;
      if (event.type === "error" && event.class === "cancelled") {
        return outcome;
      }
      if (attempt < policy.maxAttempts) {
        await policy.sleep(policy.baseDelay * attempt);
        continue;
      }
      return { kind: "failed", event };
    }
    if (outcome.response.ok) {
      return outcome;
    }
    if (outcome.response.status === 401 && config.tokenManager) {
      await outcome.response.body?.cancel();
      const refreshed = await config.tokenManager.handleAuthError(401);
      if (refreshed.refreshed && refreshed.token) {
        const retryOutcome = await sendOnce(config, request, refreshed.token, policy, signal);
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
    return {
      kind: "failed",
      event: {
        type: "error",
        class: lastClass,
        retryable,
        phase: "before_headers",
        message: failure.message,
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

export function createResponsesProvider(config: ResponsesConfig): ProviderPort {
  return {
    fork: () => createResponsesProvider(config),
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const unresolved = unresolvedImageReference(request);
      if (unresolved !== undefined) { yield unresolved; return; }
      const credential = readResponsesCredential(config);
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
      const policy = attemptPolicyOf(config);
      let apiKey = credential.apiKey;
      if (config.tokenManager?.getValidAccessToken) {
        try {
          apiKey = await config.tokenManager.getValidAccessToken();
        } catch {
          // fall back to the resolved key
        }
      }
      const acquired = await acquireResponsesResponse(config, request, apiKey, policy, signal);
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
        providerId: "openai-responses",
        model: config.model,
        warnings: [],
      };
      yield* translateResponsesBody(body, signal);
    },
  };
}

function buildResponsesHeaders(config: ResponsesConfig, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.headers ?? {}),
  };
  if (apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * ProviderRequest -> Responses `/responses` body.
 *
 * Tool results travel as `function_call_output` items keyed by the call id
 * the translator settled, so a multi-iteration tool loop replays answers the
 * endpoint can match. Assistant tool calls travel as `function_call` items
 * for the same reason: a history that flattened them into text would ask the
 * model to re-derive calls it already made.
 */
export function buildResponsesBody(config: ResponsesConfig, request: ProviderRequest): unknown {
  const input: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      if (message.content.length > 0) {
        input.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.toolCallId,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    // WP19.1: text-only messages keep the plain string; an attached image
    // becomes the wire's own input_image part beside the input_text.
    input.push({ role: message.role, content: responsesContentOf(message.content, message.attachments) });
  }
  return {
    model: request.model.length > 0 ? request.model : config.model,
    input,
    stream: true,
    ...(config.reasoningSummary === undefined && config.reasoningEffort === undefined ? {} : {
      reasoning: {
        ...(config.reasoningEffort === undefined ? {} : { effort: config.reasoningEffort }),
        ...(config.reasoningSummary === undefined ? {} : { summary: config.reasoningSummary }),
      },
    }),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    ...(responsesStructuredFields(request.responseSchema) ?? {}),
  };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
