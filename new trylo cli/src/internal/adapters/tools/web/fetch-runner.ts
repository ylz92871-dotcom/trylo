import type { ToolOutcome } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";
import { htmlToText } from "./extract.js";
import type { WebFetchPlan } from "./plan.js";
import {
  decideRedirect,
  isRedirectStatus,
  type FetchCache,
} from "./fetch-policy.js";
import {
  MAX_RESPONSE_BYTES,
  fetchFollowingPolicy,
  fetchProvenance,
  isTextualContentType,
  provenanceValue,
  readCapped,
  type FetchProvenance,
} from "./fetch-body.js";
import { extractWithPrompt, type PageExtractor } from "./extract-prompt.js";

/**
 * Running one planned `web_fetch` to a tool outcome.
 *
 * Separate from `index.ts` because this is a five-step pipeline — cache, socket,
 * cap, prose, extraction — and folding it into the module that also declares the
 * bindings made both harder to read than either would be alone. The split is by
 * decision, not by line count: `index.ts` answers "which tool is this and is it
 * mounted", this file answers "what happened to this URL".
 *
 * The order of the steps is the contract. Redirects are resolved before the body
 * is touched, the cap is enforced while reading rather than after, and the prose
 * is built before extraction so the extractor's input is the same text the model
 * would have read.
 */

export type FetchRunnerDeps = {
  readonly doFetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
  readonly nowMs?: () => number;
  /** Absent means this run re-fetches every URL. Slower, never wrong. */
  readonly cache?: FetchCache;
  /** Absent means the tool has no `prompt` capability and `plan` carries none. */
  readonly extractor?: PageExtractor;
};

export function refused(code: string, message: string): ToolOutcome {
  return { outcome: "error", code, message };
}

export async function runFetch(
  plan: WebFetchPlan,
  deps: FetchRunnerDeps,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const cached = deps.cache?.get(plan.url);
  if (cached !== undefined) {
    return present(cached.body, cached.contentType, {
      url: cached.finalUrl,
      status: cached.status,
      contentType: cached.contentType,
      bytes: cached.bytes,
      fromCache: true,
      redirects: 0,
    }, plan, deps, signal);
  }

  const outcome = await fetchFollowingPolicy(
    plan.url,
    decideRedirect,
    isRedirectStatus,
    { doFetch: deps.doFetch, signal, timeoutMs: deps.timeoutMs },
  );
  if (outcome.kind === "failed") {
    return refused(outcome.code, outcome.message);
  }

  if (outcome.kind === "hop_limit") {
    return refused(
      "too_many_redirects",
      `web_fetch stopped after ${outcome.hops} redirects rather than following a loop`,
    );
  }

  if (outcome.kind === "redirect") {
    return redirectReport(plan, outcome.to, outcome.status);
  }

  if (outcome.status >= 400) {
    return refused("http_status", `web_fetch got status ${outcome.status} from ${outcome.finalUrl}`);
  }

  const body = await readTextualBody(outcome.response, outcome.finalUrl, signal);
  if (body.kind === "refusal") {
    return body.outcome;
  }

  const provenance = fetchProvenance({
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: body.contentType,
    bytes: body.bytes,
    fromCache: false,
    redirects: 0,
  });

  deps.cache?.set(plan.url, {
    body: body.prose,
    contentType: body.contentType,
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    bytes: body.bytes,
  });

  return present(body.prose, body.contentType, provenance, plan, deps, signal);
}

type BodyRead =
  | { readonly kind: "body"; readonly prose: string; readonly contentType: string; readonly bytes: number }
  | { readonly kind: "refusal"; readonly outcome: ToolOutcome };

async function readTextualBody(
  response: Response,
  url: string,
  signal: AbortSignal,
): Promise<BodyRead> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!isTextualContentType(contentType)) {
    // Refused rather than half-decoded: a ZIP decoded as UTF-8 is not a
    // partially useful page, it is noise with plausible-looking bytes in it.
    await response.body?.cancel();
    return {
      kind: "refusal",
      outcome: refused(
        "unsupported_content",
        `web_fetch does not return binary content (${contentType})`,
      ),
    };
  }

  let body: Buffer | null;

  try {
    body = await readCapped(response, signal);
  } catch (cause) {
    return {
      kind: "refusal",
      outcome: refused("fetch_failed", `web_fetch stopped early reading ${url}: ${String(cause)}`),
    };
  }

  if (body === null) {
    return {
      kind: "refusal",
      outcome: refused(
        "response_too_large",
        `web_fetch refuses pages above ${MAX_RESPONSE_BYTES} bytes; it is not silently truncated at the source`,
      ),
    };
  }

  const raw = body.toString("utf8");

  return {
    kind: "body",
    prose: contentType.includes("html") ? htmlToText(raw) : raw,
    contentType,
    bytes: body.byteLength,
  };
}

/**
 * The cross-host redirect answer.
 *
 * A `result`, not an `error`: the fetch was permitted and this hop was not, and
 * the model has something useful to do next. Calling it an error would teach the
 * model that redirect targets are forbidden, which is false — they are simply
 * not covered by the approval for the original host.
 */
function redirectReport(plan: WebFetchPlan, to: string, status: number): ToolOutcome {
  return {
    outcome: "result",
    value: { redirectedFrom: plan.url, redirectUrl: to, status, followed: false },
    output:
      `web_fetch did not follow a redirect from ${plan.url} to ${to} (status ${status}): ` +
      `the target is a different host, and following it would fetch something the approval for ` +
      `${plan.host} never covered. Call web_fetch again with the redirect URL if you want that page.`,
    truncated: false,
  };
}

/** Prose (or its extraction) plus the provenance that says where it came from. */
async function present(
  prose: string,
  contentType: string,
  provenance: FetchProvenance,
  plan: WebFetchPlan,
  deps: FetchRunnerDeps,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (plan.prompt === undefined || deps.extractor === undefined) {
    return outcome(prose, provenance, { contentType });
  }

  const extracted = await extractWithPrompt({
    extractor: deps.extractor,
    page: prose,
    prompt: plan.prompt,
    signal,
  });
  if (extracted.kind === "unavailable") {
    // The page is still the answer. `extracted: false` is what tells a reader —
    // the model included — that the question went unanswered, so a whole page is
    // never mistaken for a summary of it.
    return outcome(prose, provenance, { contentType, extracted: false, extractionNote: extracted.message });
  }

  return outcome(extracted.text, provenance, {
    contentType,
    extracted: true,
    ...(extracted.truncated ? { inputTruncated: true } : {}),
  });
}

function outcome(
  text: string,
  provenance: FetchProvenance,
  extra: JsonObject,
): ToolOutcome {
  return {
    outcome: "result",
    value: { ...provenanceValue(provenance), ...extra },
    output: text,
    truncated: false,
  };
}
