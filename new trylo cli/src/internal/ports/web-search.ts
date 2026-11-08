/**
 * Web search, as a port the loop can be lent (WP20.1: C58 / L21).
 *
 * Why a port and not a tool that owns its own HTTP: a search is only real if
 * some named backend actually performed it, and *which* backend is a fact about
 * the run's provider, not about the tool table. The tool therefore receives a
 * `WebSearchPort` or is not mounted at all — see `adapters/tools/web/search`.
 * A `web_search` binding with no backend behind it would advertise a capability
 * the run cannot honour, which this package treats as worse than absence: the
 * model would keep asking for something every layer has already refused.
 *
 * The failure vocabulary is closed because "search did not work" has exactly
 * three honest answers — the backend cannot search (`unavailable`), the backend
 * tried and the provider said no (`auth`, `rate_limit`, `network`), or the
 * search genuinely had nothing (`empty_result`). A backend that cannot tell
 * them apart has to invent one, and an invented answer here is a fabricated
 * search result wearing a citation.
 */

export const WEB_SEARCH_MODES = ["cached", "live"] as const;

export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export function isWebSearchMode(value: string): value is WebSearchMode {
  return (WEB_SEARCH_MODES as readonly string[]).includes(value);
}

export type WebSearchRequest = {
  readonly query: string;
  /**
   * Codex's `WebSearchMode` distinction, kept because it changes what the
   * provider is allowed to reach: `cached` may be answered from an index,
   * `live` must consult the network. Both return citations; only the freshness
   * guarantee differs, so neither may be silently upgraded into the other.
   */
  readonly mode: WebSearchMode;
  readonly allowedDomains?: ReadonlyArray<string>;
  readonly blockedDomains?: ReadonlyArray<string>;
};

/** One cited source. A hit with no URL is not a source and never becomes one. */
export type WebSearchSource = {
  readonly url: string;
  readonly title: string;
};

export type WebSearchResult = {
  /** The provider's answer text, with its own inline citations left in place. */
  readonly answer: string;
  readonly sources: ReadonlyArray<WebSearchSource>;
  /**
   * The queries the provider reports it actually ran. Carried because a search
   * tool that answers a different question than the one asked is a silent
   * wrong answer, and this is the only place the truth about that is visible.
   */
  readonly searchedQueries: ReadonlyArray<string>;
};

export const WEB_SEARCH_FAILURE_CODES = [
  /** No backend for this provider. Distinct from every "tried and failed" code. */
  "unavailable",
  "invalid_arguments",
  "auth",
  "rate_limit",
  "network",
  /** The provider answered, and the answer contained no cited source. */
  "empty_result",
] as const;

export type WebSearchFailureCode = (typeof WEB_SEARCH_FAILURE_CODES)[number];

export type WebSearchFailure = {
  readonly ok: false;
  readonly code: WebSearchFailureCode;
  readonly message: string;
};

export type WebSearchOutcome =
  | { readonly ok: true; readonly result: WebSearchResult }
  | WebSearchFailure;

export type WebSearchPort = {
  /** Which provider answers for this backend; named in refusals, never guessed. */
  readonly providerId: string;
  search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchOutcome>;
};

export function webSearchFailure(
  code: WebSearchFailureCode,
  message: string,
): WebSearchFailure {
  return { ok: false, code, message };
}
