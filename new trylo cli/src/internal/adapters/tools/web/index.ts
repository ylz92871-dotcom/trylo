import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "./names.js";
import { planWebFetch } from "./plan.js";
import { createFetchCache } from "./fetch-policy.js";
import { FETCH_TIMEOUT_MS } from "./fetch-body.js";
import { refused, runFetch } from "./fetch-runner.js";
import type { PageExtractor } from "./extract-prompt.js";
import { createWebSearchTool } from "./search/index.js";
import type { WebSearchPort } from "../../../ports/web-search.js";

/** Re-exported so a caller can type the closure it lends without a second import. */
export type { PageExtractor } from "./extract-prompt.js";

/**
 * The network tools this package ships, and the story of their safety told by
 * which gate each one stands behind.
 *
 * The sandbox does not block networks — `network=restricted` only strips proxy
 * variables from children, and `run_shell` could always open a socket. The real
 * containment is *declaration*: an `external` side effect plus `needsApproval`,
 * which means a named human (or a named `--allow-tools`) lets each call through,
 * and a non-interactive run that asked for nothing gets nothing. Nothing is
 * mounted at all unless `--allow-web` was typed, so a default run never sees a
 * network tool and its catalog hash never moves.
 *
 * `web_search` adds a second absence on top of that one, and the second is not
 * redundant. Approval answers "may this call go out?"; it cannot answer "does
 * anything exist that could answer it?". A search binding with no backend would
 * pass every approval and then fail on use, so the search tool is mounted only
 * when a `WebSearchPort` was lent. Three states stay three states: flag off
 * (neither tool), flag on without a backend (`web_fetch` only), flag on with one
 * (both).
 *
 * `web_fetch`'s own promises are in `fetch-runner.ts`, which owns the five steps
 * from cache to prose. What lives here is the part that has to be true before
 * any of them run: which tools exist, whether `prompt` can be honoured at all,
 * and that a foreign name is answered rather than ignored.
 */

export type WebToolsConfig = {
  /**
   * Injected so cache expiry is a function of a clock the caller owns. Absent
   * means no cache at all: such a run re-fetches every URL, which is slower and
   * never wrong.
   */
  readonly nowMs?: () => number;
  /** Lends `web_fetch` its `prompt` capability. Absent means the tool has none. */
  readonly extractor?: PageExtractor;
  /**
   * The search backend. Absent — every provider that cannot actually search —
   * means `web_search` is not in the catalog, not that it is present and broken.
   */
  readonly search?: WebSearchPort;
  /** Overridable so a test can prove the requests it never expected are absent. */
  readonly doFetch?: typeof globalThis.fetch;
  /** So a test can lower it rather than wait out the production timeout. */
  readonly timeoutMs?: number;
};

export const WEB_FETCH_BINDING: ToolBinding = {
  name: WEB_FETCH_TOOL,
  description:
    "Fetch one absolute http(s) URL and return its text. HTML is reduced to prose (no scripts, styles, or layout); JSON and plain text come back as-is; binary responses are refused. Pass `prompt` to get just the part of the page that answers a question instead of the whole page. It is not a browser: no JavaScript execution, no forms, no login state.",
  sideEffect: "external",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Absolute http or https URL to fetch.",
      },
      prompt: {
        type: "string",
        description:
          "Optional question about the page. When present, the answer to that question is returned instead of the full text.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  needsApproval: true,
  timeoutMs: FETCH_TIMEOUT_MS,
  outputLimits: { maxBytes: 65_536, maxLines: 2_000 },
};

export function createWebTools(config: WebToolsConfig = {}): ToolPort {
  const cache =
    config.nowMs === undefined ? undefined : createFetchCache({ nowMs: config.nowMs });
  const search =
    config.search === undefined ? undefined : createWebSearchTool(config.search);
  const bindings: ReadonlyArray<ToolBinding> =
    search === undefined ? [WEB_FETCH_BINDING] : [WEB_FETCH_BINDING, ...search.snapshot()];

  return {
    snapshot: () => bindings,

    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (search !== undefined && call.name === WEB_SEARCH_TOOL) {
        return search.execute(call, signal);
      }

      if (call.name !== WEB_FETCH_TOOL) {
        return {
          outcome: "error",
          code: "unknown_tool",
          message: `web tools do not implement ${call.name}`,
        };
      }

      if (signal.aborted) {
        return { outcome: "cancelled" };
      }

      // Planned here so a malformed call is refused before the runner is built,
      // and so the `prompt` capability question is answered by the same place
      // that decides whether the argument was acceptable at all.
      const planned = planWebFetch(call, { canExtract: config.extractor !== undefined });
      if (!planned.ok) {
        return refused(planned.code, planned.message);
      }

      return runFetch(
        planned.plan,
        {
          doFetch: config.doFetch ?? globalThis.fetch,
          timeoutMs: config.timeoutMs ?? FETCH_TIMEOUT_MS,
          ...(config.nowMs === undefined ? {} : { nowMs: config.nowMs }),
          ...(cache === undefined ? {} : { cache }),
          ...(config.extractor === undefined ? {} : { extractor: config.extractor }),
        },
        signal,
      );
    },

    async cancel(): Promise<void> {
      // Nothing is tracked per call: every request stops through the abort signal
      // the loop already owns, so there is no registry here to unwind.
    },
  };
}
