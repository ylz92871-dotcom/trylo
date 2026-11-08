import type { JsonObject } from "../../../protocol/envelope.js";

/**
 * One HTTP request, start to finish, with nothing decided about its content.
 *
 * Split out of `index.ts` so the file that decides *what a fetch means* (cache
 * hit, cross-host redirect, extracted prose) is not also the file that knows how
 * to hold a socket open and count bytes. Everything here is mechanical; every
 * policy question is answered by `fetch-policy.ts` before this is called, and
 * every content question is answered after it returns.
 *
 * The response is handed back unread. Reading happens in `readCapped` below and
 * nowhere else, so there is exactly one place where a byte cap can be enforced
 * and exactly one place that can forget it.
 */

/** Per-request ceiling. A whole-fetch budget cannot police a redirect chain. */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * The largest body this tool will hold in memory.
 *
 * A refusal, not a truncation: a page cut at the cap looks to a model like a
 * complete page that happens to end mid-sentence, and it will answer from the
 * half it was given. An explicit refusal is answerable; a silent half is not.
 */
export const MAX_RESPONSE_BYTES = 1_048_576;

export type HttpOutcome =
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly finalUrl: string;
      readonly status: number;
    }
  | { readonly kind: "redirect"; readonly to: string; readonly status: number; readonly hops: number }
  | { readonly kind: "hop_limit"; readonly hops: number }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

export type FetchDeps = {
  /** Injected in tests; production passes Node's global and nothing else. */
  readonly doFetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
};

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/**
 * Follow redirects under the permission rule, one hop at a time.
 *
 * `manual` redirect handling is not a detail: the platform default would follow
 * a cross-host hop before any policy here got a say, which is precisely the case
 * the policy exists to catch. So the loop is ours and `redirect: "manual"` says
 * so to the platform.
 */
export async function fetchFollowingPolicy(
  url: string,
  decide: (input: { current: string; location: string | undefined; status: number; hops: number }) =>
    | { readonly kind: "follow"; readonly url: string }
    | { readonly kind: "report"; readonly refusal: { from: string; to: string; status: number } }
    | { readonly kind: "exhausted"; readonly hops: number },
  isRedirect: (status: number) => boolean,
  deps: FetchDeps,
): Promise<HttpOutcome> {
  let current = url;
  for (let hops = 0; ; hops += 1) {
    if (deps.signal.aborted) {
      return { kind: "failed", code: "cancelled", message: "web_fetch was cancelled" };
    }

    let response: Response;

    try {
      response = await deps.doFetch(current, {
        redirect: "manual",
        signal: withTimeout(deps.signal, deps.timeoutMs),
      });
    } catch (cause) {
      return {
        kind: "failed",
        code: "fetch_failed",
        message: `web_fetch could not reach ${hostOf(current)}: ${String(cause)}`,
      };
    }

    if (!isRedirect(response.status)) {
      // Drain the body of a refused response so the socket is released rather
      // than left half-read; the failure we report is ours, not the platform's.
      if (response.status >= 400) {
        await response.body?.cancel();
        return {
          kind: "response",
          response: new Response(null, { status: response.status }),
          finalUrl: response.url.length > 0 ? response.url : current,
          status: response.status,
        };
      }
      return {
        kind: "response",
        response,
        finalUrl: response.url.length > 0 ? response.url : current,
        status: response.status,
      };
    }

    const decision = decide({
      current,
      location: response.headers.get("location") ?? undefined,
      status: response.status,
      hops,
    });

    await response.body?.cancel();

    if (decision.kind === "exhausted") {
      return { kind: "hop_limit", hops: decision.hops };
    }

    if (decision.kind === "report") {
      return {
        kind: "redirect",
        to: decision.refusal.to,
        status: decision.refusal.status,
        hops,
      };
    }

    current = decision.url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Read the body under the byte cap. Returns `null` when the cap is exceeded.
 *
 * Reading in chunks rather than `arrayBuffer()` is what makes the cap real: the
 * whole point is that this process never allocates the oversized body, and a
 * single-shot read would allocate it and then measure it.
 */
export async function readCapped(
  response: Response,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (signal.aborted) {
      await reader.cancel();
      throw new Error("web_fetch aborted");
    }

    if (done) {
      break;
    }

    if (value === undefined) {
      continue;
    }

    total += value.byteLength;

    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/** Whether a `content-type` names something this tool can turn into prose. */
export function isTextualContentType(contentType: string): boolean {
  return (
    contentType.includes("html") ||
    contentType.includes("xml") ||
    contentType.includes("json") ||
    contentType.includes("text") ||
    // No content-type at all is the common case for a plain server and is not a
    // claim about the bytes. The body is still decoded as UTF-8 and still
    // measured by the cap, so an unlabelled binary payload is bounded — it is
    // simply not refused up front, which would break more real pages than it protects.
    contentType.trim().length === 0
  );
}

/**
 * The provenance a fetch result carries, as the `value` half of a `ToolOutcome`.
 *
 * Provenance is a separate object from the prose on purpose. `output` is what
 * the model reads and may be extracted, cached or truncated; `value` is what the
 * journal and the next turn can verify — which URL answered, with what status,
 * how many bytes, whether a cache served it, and how many hops it took. A model
 * that quotes a page must be able to say which page, and this is the only place
 * that knows.
 */
export type FetchProvenance = {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly fromCache: boolean;
  readonly redirects: number;
};

export function fetchProvenance(entry: {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly fromCache: boolean;
  readonly redirects: number;
}): FetchProvenance {
  return {
    url: entry.finalUrl,
    status: entry.status,
    contentType: entry.contentType,
    bytes: entry.bytes,
    fromCache: entry.fromCache,
    redirects: entry.redirects,
  };
}

export function provenanceValue(provenance: FetchProvenance): JsonObject {
  return {
    url: provenance.url,
    status: provenance.status,
    contentType: provenance.contentType,
    bytes: provenance.bytes,
    fromCache: provenance.fromCache,
    redirects: provenance.redirects,
  };
}
