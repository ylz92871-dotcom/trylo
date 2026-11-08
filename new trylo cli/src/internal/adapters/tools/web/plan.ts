import type { ToolCallRequest } from "../../../ports/tools.js";

/**
 * The admission plan for one `web_fetch` call, asked by the tool immediately
 * before it touches the network. Sandbox admission for this tool is
 * mount-scoped (`--allow-web` puts the name on the composite's admit set, the
 * MCP pattern); this plan is what keeps the *target* honest even after the
 * human has approved the call.
 *
 * The constraint is the URL, not the workspace: an http(s) absolute URL and
 * nothing else. `file:`, `data:`, bare words and empty strings all fail here,
 * which is what keeps the tool from being a filesystem escape dressed up as a
 * network call.
 *
 * `prompt` is planned, not executed: it is the caller's question about the page,
 * and whether this run can answer it at all is decided by whether an extractor
 * was lent (see `extract-prompt.ts`). Planning it here means a `prompt` on a run
 * with no extractor is refused before the fetch, instead of after — a page
 * fetched, paid for, and then discarded.
 */

export type WebFetchPlan = {
  readonly tool: "web_fetch";
  readonly url: string;
  readonly host: string;
  /** Present only when the question is answerable on this run. */
  readonly prompt?: string;
};

export type WebFetchPlanResult =
  | { readonly ok: true; readonly plan: WebFetchPlan }
  | { readonly ok: false; readonly code: string; readonly message: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function planWebFetch(
  call: ToolCallRequest,
  options: { readonly canExtract: boolean },
): WebFetchPlanResult {
  const value = call.arguments["url"];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, code: "invalid_arguments", message: "web_fetch requires a non-empty url string" };
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: "invalid_arguments", message: `web_fetch url is not an absolute URL: ${value}` };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      code: "unsupported_scheme",
      message: `web_fetch only speaks http and https, not ${parsed.protocol}`,
    };
  }

  const prompt = call.arguments["prompt"];
  if (prompt !== undefined) {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "web_fetch prompt must be a non-empty string when present",
      };
    }

    if (!options.canExtract) {
      // Refused, not ignored: silently dropping the question would hand back a
      // whole page to a model that asked for an answer, which is the failure
      // this whole seam exists to prevent.
      return {
        ok: false,
        code: "extraction_unavailable",
        message:
          "web_fetch cannot answer a prompt on this run: no page extractor is configured. Fetch without `prompt` to get the page itself.",
      };
    }

    return {
      ok: true,
      plan: { tool: "web_fetch", url: parsed.toString(), host: parsed.host, prompt },
    };
  }

  return { ok: true, plan: { tool: "web_fetch", url: parsed.toString(), host: parsed.host } };
}
