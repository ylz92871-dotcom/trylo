import {
  webSearchFailure,
  type WebSearchOutcome,
  type WebSearchPort,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from "../../../../ports/web-search.js";
import { classifyHttpStatus, type TokenManagerLike } from "../../../provider/openai-compatible.js";

/**
 * Web search over a provider's **hosted** search tool (WP20.1: C58 / L21).
 *
 * Reuse, and what was deliberately not reused:
 *
 *  - Codex `codex-rs/ext/web-search/src/tool.rs` + `codex-api/src/endpoint/search.rs`
 *    give the shape: a POST of a typed request to a provider search endpoint,
 *    answered with an output plus a list of results. That endpoint is
 *    `alpha/search`, and it is **not** reused — not for want of a credential
 *    (it takes a generic `SharedAuthProvider`, and Codex's own integration test
 *    drives it with a plain `Bearer test-api-key`), but because its answers are
 *    deliberately untyped: `codex-api/src/search.rs:298-305` declares
 *    `results: Option<Vec<JsonValue>>` and comments that it stays opaque there
 *    so newer variants remain forward-compatible. Reading it would mean
 *    guessing a structure, and this package's whole rule is that a source is
 *    either read off the wire or refused;
 *  - what is reused is the decision that search is a *hosted provider
 *    capability* rather than something a client should implement, and the
 *    distinction Codex draws between a cached and a live search (`WebSearchMode`)
 *    — cached may be answered from an index, live must reach the network;
 *  - the Responses hosted-tool name (`web_search`) and its citation shape come
 *    from OpenAI's documented wire, verified against the Responses guide rather
 *    than inferred from Codex's ChatGPT-only path.
 *
 * What makes this honest rather than a search that always answers:
 *
 *  - **no endpoint, no search.** `createHostedSearchBackend` returns `undefined`
 *    without an endpoint, and the tool is then not mounted. There is no code
 *    path in which a `web_search` binding exists with nothing behind it;
 *  - **sources are extracted from the wire, never composed.** A citation is a
 *    `url_citation` annotation with a URL. Text without annotations yields
 *    `empty_result`, not a result with an invented source;
 *  - **the answer is the provider's.** This tool does not paraphrase, does not
 *    summarise, and does not add a sentence of its own to the model's output.
 *    Anything it added would be a claim with no citation behind it;
 *  - **`live` is not silently downgraded.** A caller who asked for live search
 *    and got a cached answer has been told something false about the freshness
 *    of what they are reading, so the mode travels on the wire as the provider's
 *    own `external_web_access` flag.
 */

export type HostedSearchConfig = {
  /** The Responses endpoint. Absent means no backend exists at all. */
  readonly endpoint?: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly tokenManager?: TokenManagerLike;
  readonly providerId?: string;
  readonly doFetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Off by default: a hosted search costs money and reaches the network. */
  readonly allowExternalWeb?: boolean;
};

export const HOSTED_SEARCH_TIMEOUT_MS = 30_000;

type CitationAnnotation = {
  readonly type: string;
  readonly url?: string;
  readonly title?: string;
};

type HostedSearchResponse = {
  readonly output?: unknown;
  readonly output_text?: unknown;
  readonly citations?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the cited URLs out of a Responses body.
 *
 * Two places carry them and both are read: `citations` at the top level, and
 * `url_citation` annotations inside output content. Reading only one would lose
 * sources on whichever shape the endpoint happens to answer with, and a lost
 * source is a result the model cannot check.
 */
function collectSources(body: HostedSearchResponse): ReadonlyArray<WebSearchSource> {
  const found = new Map<string, WebSearchSource>();
  const take = (value: unknown): void => {
    if (!isRecord(value)) {
      return;
    }

    const url = value["url"];
    if (typeof url !== "string" || url.length === 0) {
      return;
    }

    const title = value["title"];

    found.set(url, { url, title: typeof title === "string" && title.length > 0 ? title : url });
  };

  if (Array.isArray(body.citations)) {
    for (const item of body.citations) {
      take(item);
    }
  }

  const output = body.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }

      const content = item["content"];
      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        if (!isRecord(block)) {
          continue;
        }

        const annotations = block["annotations"];
        if (!Array.isArray(annotations)) {
          continue;
        }

        for (const annotation of annotations) {
          if (isRecord(annotation) && annotation["type"] === "url_citation") {
            take(annotation as CitationAnnotation);
          }
        }
      }
    }
  }

  return [...found.values()];
}

function answerText(body: HostedSearchResponse): string {
  if (typeof body.output_text === "string" && body.output_text.length > 0) {
    return body.output_text;
  }

  const chunks: string[] = [];
  const output = body.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) {
        continue;
      }

      const content = item["content"];
      if (!Array.isArray(content)) {
        continue;
      }

      for (const block of content) {
        if (isRecord(block) && typeof block["text"] === "string") {
          chunks.push(block["text"]);
        }
      }
    }
  }

  return chunks.join("");
}

/**
 * The hosted tool object the provider is asked for.
 *
 * `external_web_access` is the whole `cached`/`live` distinction on this wire: a
 * cached search may be answered from the provider's index, and a live one must
 * consult the web. Sending neither leaves the choice to the provider, which is
 * not the same as having made it.
 */
function hostedTool(request: WebSearchRequest): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: request.mode === "live",
  };

  if (request.allowedDomains !== undefined) {
    tool["filters"] = { allowed_domains: request.allowedDomains };
  }

  if (request.blockedDomains !== undefined) {
    tool["filters"] = { blocked_domains: request.blockedDomains };
  }

  return tool;
}

export function createHostedSearchBackend(
  config: HostedSearchConfig,
): WebSearchPort | undefined {
  if (config.endpoint === undefined || config.endpoint.length === 0) {
    // The one thing this adapter must never do is answer without an endpoint.
    // Returning undefined makes "no search" a fact the tool table can see.
    return undefined;
  }

  const endpoint = config.endpoint;
  const providerId = config.providerId ?? "openai-responses";
  const doFetch = config.doFetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? HOSTED_SEARCH_TIMEOUT_MS;

  return {
    providerId,
    async search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchOutcome> {
      if (signal.aborted) {
        return webSearchFailure("network", "web_search was cancelled before the request");
      }

      if (request.mode === "live" && config.allowExternalWeb !== true) {
        // Refused by configuration rather than downgraded: a caller who asked
        // for live search and silently received an index answer is being told
        // something false about how fresh their answer is.
        return webSearchFailure(
          "unavailable",
          `${providerId} has not enabled live web access; run a cached search instead`,
        );
      }

      // The credential is resolved per call, not read once at construction: an
      // account whose access token has expired gets the same refresh the main
      // conversation path performs (`responses.ts`), instead of a 401 that only
      // `web_search` would produce. A resolver that throws falls back to the
      // stored key, which is the same order the Responses path uses.
      const apiKey = await resolveApiKey(config);
      let response: Response;

      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: headersFor(apiKey),
          body: JSON.stringify({
            model: config.model,
            input: searchInstruction(request),
            tools: [hostedTool(request)],
            stream: false,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (cause) {
        return webSearchFailure(
          "network",
          `web_search could not reach ${providerId}: ${String(cause)}`,
        );
      }

      if (!response.ok) {
        await response.body?.cancel();
        return failureForStatus(providerId, response.status);
      }

      let parsed: unknown;

      try {
        parsed = await response.json();
      } catch (cause) {
        return webSearchFailure(
          "network",
          `web_search got a response from ${providerId} that is not JSON: ${String(cause)}`,
        );
      }

      if (!isRecord(parsed)) {
        return webSearchFailure("network", `web_search got a malformed body from ${providerId}`);
      }

      const body = parsed as HostedSearchResponse;
      const sources = collectSources(body);
      if (sources.length === 0) {
        // An uncited answer is not a search result. This is the single most
        // important refusal in the file: without it, a provider that ignores the
        // hosted tool would produce a fluent, confident, source-free answer that
        // this tool would present as a search.
        return webSearchFailure(
          "empty_result",
          `${providerId} answered without citing a source; there is nothing here to verify`,
        );
      }

      const answer = answerText(body);
      if (answer.length === 0) {
        return webSearchFailure("empty_result", `${providerId} returned sources but no answer text`);
      }

      const result: WebSearchResult = { answer, sources, searchedQueries: [request.query] };

      return { ok: true, result };
    },
  };
}

function failureForStatus(providerId: string, status: number): WebSearchOutcome {
  // The shared classifier, imported rather than re-derived: this is the same
  // decision the chat and Responses adapters make, and a second copy of it here
  // would be free to drift into calling a 401 a retryable server error.
  const wireClass = classifyHttpStatus(status);
  switch (wireClass) {
    case "auth":
      return webSearchFailure("auth", `${providerId} rejected the credential (status ${status})`);
    case "rate_limit":
      return webSearchFailure("rate_limit", `${providerId} rate-limited the search (status ${status})`);
    case "invalid_request":
      return webSearchFailure(
        "network",
        `${providerId} rejected the search request (status ${status}); this endpoint may not offer hosted search`,
      );
    default:
      return webSearchFailure("network", `${providerId} failed the search (status ${status})`);
  }
}

function headersFor(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * The freshest credential this run can offer, or the stored one.
 *
 * A token manager is asked first because within one run the main conversation
 * and `web_search` must not disagree about how fresh the credential is: if the
 * conversation refreshed a token and the search request sent the stale copy, the
 * user would see a 401 from one tool and success from the other, in the same
 * breath, with nothing to tell them why.
 */
async function resolveApiKey(config: HostedSearchConfig): Promise<string | undefined> {
  const refresh = config.tokenManager?.getValidAccessToken;
  if (refresh === undefined) {
    return config.apiKey;
  }

  try {
    return await refresh.call(config.tokenManager);
  } catch {
    return config.apiKey;
  }
}

/**
 * The instruction the search turn carries.
 *
 * It asks for the answer *with* its citations rather than instructing the model
 * to go and look things up: the lookup is the hosted tool's job, and a prompt
 * that also tells the model to search produces two search behaviours racing. It
 * also states the citation requirement, because a provider that silently drops
 * the annotations should produce our `empty_result` refusal rather than an
 * uncited answer the model then treats as its own knowledge.
 */
function searchInstruction(request: WebSearchRequest): string {
  const freshness =
    request.mode === "live"
      ? "Use the web search tool and report only what you find there."
      : "Use the web search tool; a cached result is acceptable.";
  return [
    `Answer this question using the web search tool: ${request.query}`,
    freshness,
    "Cite every claim with a link from the tool's results.",
    "If the results do not contain the answer, say so instead of answering from memory.",
  ].join("\n");
}
