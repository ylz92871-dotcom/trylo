import type { ProviderPort, ReasoningEffort } from "../../ports/provider.js";
import type { ProviderKind } from "./providers-file.js";

/**
 * The resident warm layer (WP PW-3, design decision D2).
 *
 * A REPL or a TUI runs many turns against the same provider. Without this file
 * every turn builds a fresh adapter object, re-reads its resolved endpoint and
 * model and starts from nothing; with it, a turn that asks for the provider it
 * already has gets the one it has.
 *
 * What "warm" means here is deliberately narrow, and the narrowness is copied
 * from what the mature CLIs actually do rather than from the word:
 *
 *  - **codex** warms the *connection*: `codex-rs/core/src/client.rs` performs a
 *    best-effort prewarm before the first stream request, and a failed prewarm
 *    does not fail the turn — the turn simply opens its own connection;
 *  - **cline** warms *data*: `prewarmWorkspaceMetadata` caches a promise under a
 *    TTL (`WORKSPACE_METADATA_PREWARM_TTL_MS = 60_000`), refreshes it when it is
 *    older than the window, and deletes the entry when the promise rejects.
 *
 * So this is a **cache with a TTL and a failure eviction**, not a connection
 * pool and not a daemon. Two things it specifically does not do:
 *
 *  - **no heartbeat.** Nothing here sends a request to an endpoint in order to
 *    keep it warm. A keep-alive ping against a metered API spends the user's
 *    money to save a handshake, and "we touched their endpoint first" is not a
 *    decision this package gets to make;
 *  - **no sharing across identities.** A warm entry is keyed by the account the
 *    credential came from, so a second account cannot be handed a session built
 *    for the first one. Reuse is within one process, one REPL, one identity.
 *
 * The counters exist because "it is warm" is otherwise an unfalsifiable claim:
 * `builds` is how many adapters were actually constructed, and a REPL that ran
 * five turns with `builds === 1` has proved the reuse rather than asserted it.
 */

export const WARM_TTL_MS = 60_000;

export type WarmSpec = {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly endpoint: string;
  /**
   * Which credential the session was built for — an account id or the empty
   * string when there is none. Never the credential itself: the key is printed
   * in diagnostics, and a key that carried a secret would leak it there.
   */
  readonly accountId: string;
  /** Summary configuration belongs to the adapter identity, never the credential. */
  readonly reasoningSummary?: "auto";
  readonly reasoningEffort?: ReasoningEffort;
  /** A provider carrying a workspace image reader cannot cross that boundary. */
  readonly workspaceId?: string;
  /** Cache raw transport, never a turn's external-image authority. */
  readonly imageReferenceScope?: "transport";
};

export type WarmStats = {
  /** Adapters actually constructed. One per distinct, long-lived session. */
  readonly builds: number;
  /** Acquisitions served from a warm entry — the point of the layer. */
  readonly hits: number;
  /** Acquisitions that found an entry but could not use it. */
  readonly rebuilds: number;
  /** Entries dropped because a turn reported the provider broken. */
  readonly evictions: number;
};

export type WarmAcquisition = {
  readonly provider: ProviderPort;
  /** False on a build or a rebuild; true only when the warm entry was used. */
  readonly reused: boolean;
  readonly key: string;
};

export type WarmRegistry = {
  acquire(spec: WarmSpec, build: () => ProviderPort): WarmAcquisition;
  /** Drop one session: its next acquisition rebuilds. */
  invalidate(spec: WarmSpec): void;
  /** Drop everything — a cancelled turn, a switched provider, a REPL exit. */
  invalidateAll(): void;
  stats(): WarmStats;
  /** Diagnostics: how many entries are live right now. */
  readonly size: () => number;
};

export type WarmOptions = {
  readonly ttlMs?: number;
  /** Injected clock, so a test can age an entry without waiting a minute. */
  readonly now?: () => number;
};

type WarmEntry = {
  readonly provider: ProviderPort;
  readonly builtAtMs: number;
};

/** The identity a session is cached under. Printable, and secret-free. */
export function warmKeyOf(spec: WarmSpec): string {
  const base = [spec.kind, spec.providerId, spec.model, spec.endpoint, spec.accountId].join("|");
  const key = spec.reasoningSummary === undefined ? base : `${base}|summary:${spec.reasoningSummary}`;
  const configured = spec.reasoningEffort === undefined ? key : `${key}|effort:${spec.reasoningEffort}`;
  const scoped = spec.workspaceId === undefined ? configured : `${configured}|workspace:${spec.workspaceId}`;
  return spec.imageReferenceScope === undefined ? scoped : `${scoped}|images:${spec.imageReferenceScope}`;
}

export function createWarmRegistry(options: WarmOptions = {}): WarmRegistry {
  const ttlMs = options.ttlMs ?? WARM_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, WarmEntry>();
  const counters = { builds: 0, hits: 0, rebuilds: 0, evictions: 0 };

  /**
   * Why an entry is not usable, because the two reasons are counted
   * differently: a cold miss is a build, an aged entry is a rebuild, and
   * collapsing them would hide the difference between "never had one" and
   * "had one and it went stale".
   */
  function usable(key: string): { readonly kind: "fresh"; readonly entry: WarmEntry } | { readonly kind: "expired" } | { readonly kind: "missing" } {
    const entry = entries.get(key);
    if (entry === undefined) {
      return { kind: "missing" };
    }
    if (now() - entry.builtAtMs > ttlMs) {
      // Expired: dropped rather than refreshed in place, because "still there"
      // and "still good" are different claims and only the second one is worth
      // keeping.
      entries.delete(key);
      return { kind: "expired" };
    }
    return { kind: "fresh", entry };
  }

  return {
    acquire(spec, build) {
      const key = warmKeyOf(spec);
      const found = usable(key);
      if (found.kind === "fresh") {
        counters.hits += 1;
        return { provider: found.entry.provider, reused: true, key };
      }
      if (found.kind === "expired") {
        // There was one and it went stale. Counted apart from a cold build so
        // "never had a session" and "had one, it aged out" stay distinguishable
        // in the numbers — the second one is the interesting failure.
        counters.rebuilds += 1;
      }
      counters.builds += 1;
      const provider = build();
      entries.set(key, { provider, builtAtMs: now() });
      return { provider, reused: false, key };
    },
    invalidate(spec) {
      if (entries.delete(warmKeyOf(spec))) {
        counters.evictions += 1;
      }
    },
    invalidateAll() {
      counters.evictions += entries.size;
      entries.clear();
    },
    stats() {
      return { ...counters };
    },
    size() {
      return entries.size;
    },
  };
}
