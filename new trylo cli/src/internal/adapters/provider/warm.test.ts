import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { createWarmRegistry, warmKeyOf, WARM_TTL_MS, type WarmSpec } from "./warm.js";

/**
 * The warm layer's four promises: reuse what is still good, rebuild what is not,
 * never hand one identity's session to another, and *count* all of it — because
 * "it is warm" is otherwise a claim nobody can check.
 *
 * The clock is injected in every case. Waiting a real minute for an entry to age
 * would make this suite slow, and a test that occasionally passes because the
 * machine was busy is worse than no test.
 */

function provider(): ProviderPort {
  return {
    async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      yield { type: "cancel_ack" };
    },
  };
}

function spec(overrides: Partial<WarmSpec> = {}): WarmSpec {
  return {
    providerId: "openai-compatible",
    kind: "openai-compatible",
    model: "m1",
    endpoint: "https://one.example/v1",
    accountId: "acct-a",
    ...overrides,
  };
}

test("the second acquisition is the first provider, not a new one", () => {
  const warm = createWarmRegistry({ now: () => 0 });
  const first = warm.acquire(spec(), provider);
  const second = warm.acquire(spec(), provider);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.provider === second.provider, true, "the same object, not a look-alike");
  assert.deepEqual(warm.stats(), { builds: 1, hits: 1, rebuilds: 0, evictions: 0 });
});

test("an entry older than the window is rebuilt, not reused", () => {
  let clock = 0;
  const warm = createWarmRegistry({ now: () => clock });
  const first = warm.acquire(spec(), provider);

  clock = WARM_TTL_MS + 1;
  const second = warm.acquire(spec(), provider);

  assert.equal(first.provider === second.provider, false);
  assert.equal(second.reused, false);
  assert.deepEqual(warm.stats(), { builds: 2, hits: 0, rebuilds: 1, evictions: 0 });
});

test("a change of account is a different session, so no credential is lent across", () => {
  const warm = createWarmRegistry({ now: () => 0 });
  const forA = warm.acquire(spec({ accountId: "acct-a" }), provider);
  const forB = warm.acquire(spec({ accountId: "acct-b" }), provider);
  assert.equal(forA.provider === forB.provider, false);
  assert.equal(warm.stats().builds, 2);
  assert.equal(warm.size(), 2);
});

test("a change of endpoint or model is a different session too", () => {
  const warm = createWarmRegistry({ now: () => 0 });
  warm.acquire(spec(), provider);
  warm.acquire(spec({ endpoint: "https://two.example/v1" }), provider);
  warm.acquire(spec({ model: "m2" }), provider);
  assert.equal(warm.stats().builds, 3, "what is reused is the provider this run resolved");
});

test("enabling a reasoning summary builds a new adapter instead of reusing the silent one", () => {
  const warm = createWarmRegistry({ now: () => 0 });
  const base = spec({ kind: "openai-responses" });
  const summarized = { ...base, reasoningSummary: "auto" as const };
  const silent = warm.acquire(base, provider);
  const enabled = warm.acquire(summarized, provider);

  assert.equal(silent.provider === enabled.provider, false);
  assert.equal(warm.acquire(summarized, provider).provider === enabled.provider, true);
  assert.equal(warm.stats().builds, 2);
});

test("a session reported broken is dropped and its next turn rebuilds", () => {
  const warm = createWarmRegistry({ now: () => 0 });
  const first = warm.acquire(spec(), provider);

  warm.invalidate(spec());
  const second = warm.acquire(spec(), provider);

  assert.equal(first.provider === second.provider, false);
  assert.equal(warm.stats().evictions, 1);
  assert.equal(warm.stats().builds, 2);
});

test("invalidateAll drops everything", () => {
  const warm = createWarmRegistry({ now: () => 0 });

  warm.acquire(spec({ accountId: "a" }), provider);
  warm.acquire(spec({ accountId: "b" }), provider);
  assert.equal(warm.size(), 2);
  warm.invalidateAll();
  assert.equal(warm.size(), 0);
  assert.equal(warm.stats().evictions, 2);
});

test("the key is printable and carries no credential", () => {
  const key = warmKeyOf(spec({ accountId: "acct-a" }));
  assert.match(key, /^openai-compatible\|openai-compatible\|m1\|https:\/\/one\.example\/v1\|acct-a$/);
  // The account id is in the key; the secret never is, because nothing here ever
  // holds one — the adapter closes over it and this file only sees the id.
  assert.equal(key.includes("sk-"), false);
});

test("the ttl is configurable, and honoured", () => {
  let clock = 0;
  const warm = createWarmRegistry({ now: () => clock, ttlMs: 5 });
  const first = warm.acquire(spec(), provider);
  clock = 6;
  const second = warm.acquire(spec(), provider);
  assert.equal(first.provider === second.provider, false);
});
