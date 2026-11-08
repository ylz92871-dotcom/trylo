/**
 * Where a `web_fetch` may be sent, and when it may not be sent again.
 *
 * Both halves of this file are pure on purpose. Redirect permission is a
 * decision about two URLs, and cache admission is a decision about one URL and
 * a clock; neither needs a socket, so neither can be tested by standing up a
 * server. The socket work happens in `fetch-body.ts` and only after these have
 * said yes.
 *
 * Reuse: legacy `WebFetchTool/utils.ts:isPermittedRedirect` (same scheme, same
 * port, same host modulo a `www.` prefix) and its `MAX_REDIRECTS = 10` hop cap,
 * which exists because a server answering `/a → /b → /a` resets the per-request
 * timeout on every hop and hangs until the user interrupts. The legacy
 * `URL_CACHE` (15-minute TTL, 50 MB) becomes `FetchCache` here with the clock
 * injected, because a cache whose expiry depends on a wall clock read at the
 * call site cannot be tested at all.
 */

/** Same as the legacy client: common browser/axios defaults, and no more. */
export const MAX_REDIRECT_HOPS = 10;

/**
 * Whether following `from` → `to` stays inside what was approved.
 *
 * The rule is narrower than "same site" on purpose: the scheme and the port
 * must be unchanged, and the host may only gain or lose a `www.` prefix. A
 * redirect that changes any of those is not followed — it is *reported*, so the
 * model can decide whether to ask for the new URL explicitly and put it in
 * front of a human. Following it silently is how an approved fetch to one host
 * becomes a fetch to another.
 */
export function isPermittedRedirect(from: string, to: string): boolean {
  let source: URL;
  let target: URL;

  try {
    source = new URL(from);
    target = new URL(to);
  } catch {
    return false;
  }

  if (source.protocol !== target.protocol) {
    return false;
  }

  if (source.port !== target.port) {
    return false;
  }

  // Credentials in a redirect target are a phishing primitive, never a
  // convenience: `https://trusted.example@evil.test/` reads as trusted.example
  // in a status bar and goes to evil.test.
  if (target.username.length > 0 || target.password.length > 0) {
    return false;
  }

  return stripWww(source.hostname) === stripWww(target.hostname);
}

function stripWww(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

export type RedirectRefusal = {
  readonly from: string;
  readonly to: string;
  readonly status: number;
};

export type RedirectDecision =
  | { readonly kind: "follow"; readonly url: string }
  | { readonly kind: "report"; readonly refusal: RedirectRefusal }
  | { readonly kind: "exhausted"; readonly hops: number };

/**
 * One hop, given the URL the previous hop resolved to.
 *
 * `location` is resolved against `current` because a server is free to answer
 * with a relative `Location`, and joining it by hand is the step where a
 * `//evil.test/x` turns into an absolute cross-host URL without anybody
 * noticing.
 */
export function decideRedirect(input: {
  readonly current: string;
  readonly location: string | undefined;
  readonly status: number;
  readonly hops: number;
}): RedirectDecision {
  if (input.hops >= MAX_REDIRECT_HOPS) {
    return { kind: "exhausted", hops: input.hops };
  }

  if (input.location === undefined || input.location.length === 0) {
    // A 3xx with no Location is a broken server, not a redirect. Reporting it
    // keeps the failure attributable instead of surfacing as "too many hops".
    return {
      kind: "report",
      refusal: { from: input.current, to: input.current, status: input.status },
    };
  }

  let target: string;

  try {
    target = new URL(input.location, input.current).toString();
  } catch {
    return {
      kind: "report",
      refusal: { from: input.current, to: input.location, status: input.status },
    };
  }

  if (!isPermittedRedirect(input.current, target)) {
    return { kind: "report", refusal: { from: input.current, to: target, status: input.status } };
  }

  return { kind: "follow", url: target };
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** How long a fetched page may be re-served without touching the network. */
export const FETCH_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * The total number of body bytes one cache may hold.
 *
 * A byte budget rather than an entry count, because the entries here are web
 * pages: forty small files and four hundred large ones are the same number of
 * entries and not remotely the same memory. Eviction is least-recently-used,
 * which is the property that matters here — a model re-fetching the page it
 * asked for a moment ago is the overwhelmingly common case.
 */
export const FETCH_CACHE_MAX_BYTES = 8 * 1024 * 1024;

type CacheEntry = {
  readonly body: string;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly bytes: number;
  readonly expiresAtMs: number;
};

export type FetchCacheOptions = {
  /** Injected so expiry is a function of a test's clock, not of the machine's. */
  readonly nowMs: () => number;
  readonly ttlMs?: number;
  readonly maxBytes?: number;
};

export type FetchCache = {
  /** Absent on a miss, a hard error, or an entry past its TTL. Never stale. */
  get(url: string): CacheEntry | undefined;
  set(url: string, entry: Omit<CacheEntry, "expiresAtMs">): void;
  readonly sizeBytes: () => number;
  clear(): void;
};

export function createFetchCache(options: FetchCacheOptions): FetchCache {
  const ttlMs = options.ttlMs ?? FETCH_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? FETCH_CACHE_MAX_BYTES;
  // Insertion order *is* recency here: `get` re-inserts on hit, so the first
  // key Map yields is always the least recently used one.
  const entries = new Map<string, CacheEntry>();
  let sizeBytes = 0;
  const now = options.nowMs;

  function evict(): void {
    for (const [key, entry] of entries) {
      if (sizeBytes <= maxBytes) {
        return;
      }
      entries.delete(key);
      sizeBytes -= entry.bytes;
    }
  }

  return {
    get(url) {
      const entry = entries.get(url);
      if (entry === undefined) {
        return undefined;
      }

      if (entry.expiresAtMs <= now()) {
        entries.delete(url);
        sizeBytes -= entry.bytes;
        return undefined;
      }

      entries.delete(url);
      entries.set(url, entry);

      return entry;
    },
    set(url, entry) {
      const existing = entries.get(url);
      if (existing !== undefined) {
        sizeBytes -= existing.bytes;
      }

      entries.delete(url);

      // An entry larger than the whole budget would evict everything and then
      // still not fit. Storing it would make every later `get` a miss on a cache
      // that had just been emptied, so it is refused at the door instead.
      if (entry.bytes > maxBytes) {
        return;
      }

      entries.set(url, { ...entry, expiresAtMs: now() + ttlMs });
      sizeBytes += entry.bytes;
      evict();
    },
    sizeBytes: () => sizeBytes,
    clear() {
      entries.clear();
      sizeBytes = 0;
    },
  };
}
