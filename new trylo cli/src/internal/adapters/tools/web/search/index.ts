import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../../ports/tools.js";
import { WEB_SEARCH_MODES, type WebSearchPort } from "../../../../ports/web-search.js";
import { WEB_SEARCH_TOOL } from "../names.js";
import { planWebSearch } from "./plan.js";

/**
 * `web_search`: a tool whose entire value is that it does not lie.
 *
 * The binding is `external` and needs approval for the same reason `web_fetch`
 * is — a search reaches the network and can cost money. But the approval gate is
 * not what makes this tool trustworthy. What makes it trustworthy is that it has
 * exactly three possible answers, and two of them are refusals:
 *
 *  - a real answer, carrying the URLs it is based on, in `output` **and** in
 *    `value.sources` so a later turn can check them without re-reading prose;
 *  - `unavailable`, when this provider cannot search at all;
 *  - the backend's own typed refusal (`auth`, `rate_limit`, `network`,
 *    `empty_result`), passed through rather than flattened.
 *
 * There is no fourth path. In particular this module never composes a result
 * from an error, never retries with a different query to make a failure go away,
 * and never returns text without the sources that text came from. A search tool
 * that answers when it cannot search is worse than no search tool, because the
 * model cannot tell the difference between a citation and a recollection.
 *
 * The `sources` list is rendered into the model-facing text as markdown links
 * rather than left implicit, matching the legacy tool's closing reminder that the
 * sources must actually be cited — an unrendered citation is a citation the model
 * never sees.
 */

export type WebSearchToolDeps = {
  /** Present only so a caller can stamp a retrieval time; never invented here. */
  readonly nowMs?: () => number;
};

export const WEB_SEARCH_BINDING: ToolBinding = {
  name: WEB_SEARCH_TOOL,
  description:
    "Search the web and return an answer with the sources it came from. Use it for facts that change over time or that you cannot look up in the repository. Every claim must come back with a link; if the results do not contain the answer, the tool says so instead of guessing.",
  sideEffect: "external",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question to search the web for.",
      },
      mode: {
        type: "string",
        enum: [...WEB_SEARCH_MODES],
        description:
          "`cached` (default) may be answered from the provider's index. `live` must consult the web, and is refused when this provider has not enabled live access.",
      },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only use results from these domains. Cannot be combined with blocked_domains.",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Never use results from these domains. Cannot be combined with allowed_domains.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: 30_000,
  outputLimits: { maxBytes: 65_536, maxLines: 2_000 },
};

export function createWebSearchTool(
  backend: WebSearchPort,
  deps: WebSearchToolDeps = {},
): ToolPort {
  void deps;
  return {
    snapshot: () => [WEB_SEARCH_BINDING],

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name !== WEB_SEARCH_TOOL) {
        return {
          outcome: "unknown",
          code: "unknown_tool",
          message: `web_search does not implement ${call.name}`,
        };
      }

      const planned = planWebSearch(call);
      if (!planned.ok) {
        return { outcome: "error", code: planned.code, message: planned.message };
      }

      const outcome = await backend.search(planned.plan, signal);
      if (!outcome.ok) {
        return {
          outcome: "error",
          code: outcome.code,
          message: `web_search via ${backend.providerId}: ${outcome.message}`,
        };
      }

      return render(outcome.result, backend.providerId);
    },

    async cancel(): Promise<void> {
      // The backend stops through the signal the loop already owns.
    },
  };
}

type SearchResultShape = {
  readonly answer: string;
  readonly sources: ReadonlyArray<{ readonly url: string; readonly title: string }>;
  readonly searchedQueries: ReadonlyArray<string>;
};

function render(result: SearchResultShape, providerId: string): ToolOutcome {
  const links = result.sources.map((source) => `- [${source.title}](${source.url})`).join("\n");
  const output = [
    result.answer.trim(),
    "",
    "Sources:",
    links,
    "",
    "Include these links in your answer to the user. If they do not support what you wrote above, say so.",
  ].join("\n");

  return {
    outcome: "result",
    value: {
      provider: providerId,
      queries: [...result.searchedQueries],
      sources: result.sources.map((source) => ({ url: source.url, title: source.title })),
      sourceCount: result.sources.length,
    },
    output,
    truncated: false,
  };
}
