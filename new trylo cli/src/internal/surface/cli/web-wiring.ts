import { createHostedSearchBackend } from "../../adapters/tools/web/search/hosted-backend.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { PageExtractor } from "../../adapters/tools/web/index.js";
import { EXTRACTOR_INSTRUCTION } from "../../adapters/tools/web/extract-prompt.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { WebToolsConfig } from "../../adapters/tools/web/index.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import type { ToolPort } from "../../ports/tools.js";
import { WEB_TOOL_NAMES } from "../../adapters/tools/web/names.js";

/** Only mounted names are admitted. An optional search backend must never be
 * admitted by a static list when the catalog does not actually offer it.
 */
export function mountedWebToolNames(tools: ToolPort): readonly string[] {
  return tools.snapshot().map(binding => binding.name).filter(name => WEB_TOOL_NAMES.has(name));
}

/**
 * Building the network tools' backends at the CLI composition root (WP20).
 *
 * This file exists because both backends need facts only this layer has — which
 * provider was selected, what endpoint it declared, which credential resolved —
 * and because both answers are *conditional*:
 *
 *  - a **search backend** exists only for a provider family that actually offers
 *    hosted search. An OpenAI-compatible chat endpoint does not, so
 *    `createHostedSearchBackend` is not called for it and `web_search` is never
 *    mounted. That is the whole reason the search tool can be trusted to be
 *    absent rather than present-and-broken;
 *  - a **page extractor** exists only when there is a provider to ask. Without
 *    one, `web_fetch` does not offer `prompt` at all, which the plan refuses up
 *    front — so a model is never told it can ask a question the run cannot answer.
 *    The provider is threaded in from the composition root (`run-command.ts`),
 *    the same way `wiring.ts:296` builds the compaction summarizer from the
 *    provider it already holds;
 *
 * Neither backend is built speculatively. Construction is pure (no socket, no
 * file, no directory), and anything that would open one is behind the check that
 * would otherwise have made the tool unmountable.
 */

/** Only Responses speaks hosted search today; a chat endpoint has no such tool. */
const HOSTED_SEARCH_KINDS: ReadonlySet<ProviderKind> = new Set<ProviderKind>(["openai-responses"]);

/** Tokens for one extraction call. A page answer is a paragraph, not an essay. */
const EXTRACTOR_MAX_OUTPUT_TOKENS = 1024;

export type WebBackendInput = {
  readonly providerKind: ProviderKind;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string | undefined;
  /**
   * The account's token manager, when the run authenticated as an account rather
   * than with a bare key. Forwarded so `web_search` refreshes exactly as the
   * main conversation does; absent means a plain key, which needs no refresh.
   */
  readonly tokenManager?: TokenManagerLike;
  /**
   * The cache clock. Absent means the real one (`Date.now`), which is the only
   * correct answer for a run that is about to fetch from the network; it is a
   * parameter so a test can hold time still without patching a global.
   */
  readonly nowMs?: () => number;
};

export function webBackendsFor(input: WebBackendInput): WebToolsConfig {
  const search = searchFor(input);
  // The cache clock is injected here rather than defaulted inside the tool, so
  // that "cache exists" is a fact about a run and not about a test: a run that
  // reached this line has one, and a run that never did has neither. The `??`
  // is the documented injection-default form (`static-scans.mjs` admits a clock
  // only as a same-line `??` default), so this file needs no allowlist entry.
  //
  // `extractor` is deliberately not built here: this layer knows which provider
  // was selected, not one that exists. The extractor is attached in `wiring.ts`,
  // which holds the live port — see the note at that call site.
  return { nowMs: input.nowMs ?? Date.now, ...(search === undefined ? {} : { search }) };
}

function searchFor(input: WebBackendInput): ReturnType<typeof createHostedSearchBackend> {
  if (!HOSTED_SEARCH_KINDS.has(input.providerKind)) {
    return undefined;
  }
  return createHostedSearchBackend({
    endpoint: input.endpoint,
    model: input.model,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.tokenManager === undefined ? {} : { tokenManager: input.tokenManager }),
    // Live search reaches the network and costs money, so it is off until a run
    // says otherwise. Cached search — the default — needs no permission beyond
    // the approval gate the tool already stands behind.
    allowExternalWeb: false,
  });
}

/**
 * The `prompt` capability of `web_fetch`: one tool-free provider call.
 *
 * The call carries no tools on purpose. An extractor that could call a tool would
 * be a second agent running inside a tool, and a page that made it do that would
 * be a page deciding what this run does next. It is also the same shape as the
 * compaction summarizer (`compact-model-summarizer.ts`) — one request, text out —
 * because it is the same job: turn a large input into a short answer.
 */
export function createPageExtractor(input: {
  readonly provider: ProviderPort;
  readonly model: string;
}): PageExtractor {
  return async (page: string, prompt: string, signal: AbortSignal): Promise<string> => {
    if (signal.aborted) {
      throw new Error("cancelled before the extraction request");
    }

    const request = {
      attemptId: "web-fetch-extract",
      model: input.model,
      messages: [
        { role: "system" as const, content: EXTRACTOR_INSTRUCTION },
        {
          role: "user" as const,
          content: `Question: ${prompt}\n\nPage:\n${page}`,
        },
      ],
      tools: [],
      maxOutputTokens: EXTRACTOR_MAX_OUTPUT_TOKENS,
    };
    let text = "";

    for await (const event of input.provider.stream(request, signal)) {
      if (event.type === "text_delta") {
        text += event.text;
        continue;
      }
      if (event.type === "error" || event.type === "finish") {
        break;
      }
    }

    return text;
  };
}
