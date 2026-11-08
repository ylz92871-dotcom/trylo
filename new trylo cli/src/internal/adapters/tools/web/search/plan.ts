import type { ToolCallRequest } from "../../../../ports/tools.js";
import {
  WEB_SEARCH_MODES,
  isWebSearchMode,
  type WebSearchMode,
} from "../../../../ports/web-search.js";

/**
 * The admission plan for one `web_search` call.
 *
 * Mirrors `plan.ts` for the fetch tool and for the same reason: the argument
 * check happens before any token is spent and before any network exists, so a
 * malformed query is a refusal rather than a provider error. The interesting
 * rule is the domain one — `allowed_domains` and `blocked_domains` are mutually
 * exclusive, taken from legacy `WebSearchTool.validateInput`, which refuses the
 * combination outright.
 *
 * It refuses rather than picking a winner because the two lists answer different
 * questions and a caller who sent both has not said which one they meant. An
 * implementation that quietly honoured one of them would return results the
 * caller did not ask for and call it success.
 */

export type WebSearchPlan = {
  readonly tool: "web_search";
  readonly query: string;
  readonly mode: WebSearchMode;
  readonly allowedDomains?: ReadonlyArray<string>;
  readonly blockedDomains?: ReadonlyArray<string>;
};

export type WebSearchPlanResult =
  | { readonly ok: true; readonly plan: WebSearchPlan }
  | { readonly ok: false; readonly code: string; readonly message: string };

function domainList(value: unknown): ReadonlyArray<string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    return [];
  }

  return (value as ReadonlyArray<string>).map((item) => item.trim().toLowerCase());
}

export function planWebSearch(call: ToolCallRequest): WebSearchPlanResult {
  const query = call.arguments["query"];
  if (typeof query !== "string" || query.trim().length < 2) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: "web_search requires a query of at least two characters",
    };
  }

  const rawMode = call.arguments["mode"];
  const mode = rawMode === undefined ? "cached" : String(rawMode);
  if (!isWebSearchMode(mode)) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: `web_search mode must be one of ${WEB_SEARCH_MODES.join(", ")}`,
    };
  }

  const allowedDomains = domainList(call.arguments["allowed_domains"]);
  const blockedDomains = domainList(call.arguments["blocked_domains"]);

  if (allowedDomains !== undefined && allowedDomains.length === 0) {
    return { ok: false, code: "invalid_arguments", message: "allowed_domains must be strings" };
  }

  if (blockedDomains !== undefined && blockedDomains.length === 0) {
    return { ok: false, code: "invalid_arguments", message: "blocked_domains must be strings" };
  }

  if (allowedDomains !== undefined && blockedDomains !== undefined) {
    return {
      ok: false,
      code: "conflicting_filters",
      message:
        "web_search cannot take both allowed_domains and blocked_domains; send the allow list or the block list, not both",
    };
  }

  return {
    ok: true,
    plan: {
      tool: "web_search",
      query: query.trim(),
      mode,
      ...(allowedDomains === undefined ? {} : { allowedDomains }),
      ...(blockedDomains === undefined ? {} : { blockedDomains }),
    },
  };
}
