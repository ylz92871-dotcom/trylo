import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_REDIRECT_HOPS,
  createFetchCache,
  decideRedirect,
  isPermittedRedirect,
  isRedirectStatus,
} from "./fetch-policy.js";

/**
 * Redirect permission and cache admission, both without a socket.
 *
 * These are the two decisions that decide whether a fetch is *allowed* and whether
 * it has to happen at all, so they are tested as pure functions: every case here
 * is a case a server would have to be stood up for otherwise, and a test that
 * needs a server cannot distinguish "the policy refused" from "the server was
 * slow".
 *
 * The cases that matter most are the ones a permissive implementation gets wrong:
 * a cross-host hop, a protocol change, credentials in the target, a relative
 * `Location` that turns absolute, and a redirect loop.
 */

test("a same-host redirect is permitted, including a www prefix in either direction", () => {
  assert.equal(isPermittedRedirect("https://example.com/a", "https://example.com/b"), true);
  assert.equal(isPermittedRedirect("https://example.com/a", "https://www.example.com/b"), true);
  assert.equal(isPermittedRedirect("https://www.example.com/a", "https://example.com/b"), true);
});

test("a redirect that changes host, scheme, port or adds credentials is refused", () => {
  assert.equal(isPermittedRedirect("https://example.com/a", "https://evil.test/a"), false);
  assert.equal(isPermittedRedirect("https://example.com/a", "http://example.com/a"), false);
  assert.equal(isPermittedRedirect("https://example.com/a", "https://example.com:8443/a"), false);
  assert.equal(
    isPermittedRedirect("https://example.com/a", "https://user:pw@example.com/a"),
    false,
    "credentials in the target are a phishing primitive, never a convenience",
  );
  assert.equal(isPermittedRedirect("not a url", "https://example.com/a"), false);
});

test("a relative Location resolves against the current URL and is then judged", () => {
  const sameHost = decideRedirect({
    current: "https://example.com/docs/a",
    location: "../b",
    status: 302,
    hops: 0,
  });

  assert.deepEqual(sameHost, { kind: "follow", url: "https://example.com/b" });

  // The dangerous case: `//evil.test/x` is scheme-relative, and joining it by
  // hand as a path string is exactly how it becomes a cross-host fetch.
  const crossHost = decideRedirect({
    current: "https://example.com/docs/a",
    location: "//evil.test/x",
    status: 302,
    hops: 0,
  });

  assert.equal(crossHost.kind, "report");
});

test("a cross-host hop is reported with both URLs, never followed", () => {
  const decision = decideRedirect({
    current: "https://example.com/a",
    location: "https://evil.test/a",
    status: 301,
    hops: 0,
  });

  assert.equal(decision.kind, "report");

  if (decision.kind === "report") {
    assert.equal(decision.refusal.from, "https://example.com/a");
    assert.equal(decision.refusal.to, "https://evil.test/a");
    assert.equal(decision.refusal.status, 301);
  }
});

test("a 3xx with no Location is reported as itself, not disguised as a hop limit", () => {
  const decision = decideRedirect({
    current: "https://example.com/a",
    location: undefined,
    status: 302,
    hops: 0,
  });

  assert.equal(decision.kind, "report");

  if (decision.kind === "report") {
    assert.equal(decision.refusal.status, 302);
  }
});

test("a redirect chain is capped, so a loop cannot hang the turn", () => {
  let decision = decideRedirect({
    current: "https://example.com/0",
    location: "https://example.com/1",
    status: 302,
    hops: MAX_REDIRECT_HOPS - 1,
  });

  assert.equal(decision.kind, "follow");
  const exhausted = decideRedirect({
    current: "https://example.com/1",
    location: "https://example.com/0",
    status: 302,
    hops: MAX_REDIRECT_HOPS,
  });

  assert.deepEqual(exhausted, { kind: "exhausted", hops: MAX_REDIRECT_HOPS });
  void decision;
});

test("only real redirect statuses count", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    assert.equal(isRedirectStatus(status), true, String(status));
  }
  for (const status of [200, 204, 304, 400, 500]) {
    assert.equal(isRedirectStatus(status), false, String(status));
  }
});

test("a cache hit is served until its TTL, then misses — on the caller's clock", () => {
  let now = 1_000;
  const cache = createFetchCache({ nowMs: () => now, ttlMs: 100 });
  const entry = { body: "hello", contentType: "text/plain", finalUrl: "https://x.test/", status: 200, bytes: 5 };

  cache.set("https://x.test/", entry);
  assert.equal(cache.get("https://x.test/")?.body, "hello");
  now = 1_099;
  assert.equal(cache.get("https://x.test/")?.body, "hello", "still inside the TTL");
  now = 1_100;
  assert.equal(cache.get("https://x.test/"), undefined, "expiry is exact, not approximate");
  assert.equal(cache.sizeBytes(), 0, "an expired entry stops occupying the budget");
});

test("a cached entry is never served stale, and an oversize entry is refused at the door", () => {
  const cache = createFetchCache({ nowMs: () => 0, maxBytes: 100 });

  cache.set("https://x.test/big", {
    body: "x".repeat(500),
    contentType: "text/plain",
    finalUrl: "https://x.test/big",
    status: 200,
    bytes: 500,
  });
  assert.equal(cache.get("https://x.test/big"), undefined);
  assert.equal(cache.sizeBytes(), 0);
});

test("the least recently used entry is evicted first", () => {
  const cache = createFetchCache({ nowMs: () => 0, maxBytes: 100 });
  const put = (name: string, bytes: number): void => {
    cache.set(name, { body: name, contentType: "text/plain", finalUrl: name, status: 200, bytes });
  };

  put("a", 40);
  put("b", 40);
  // Touching `a` makes `b` the least recently used, so `b` is what goes.
  assert.equal(cache.get("a")?.body, "a");
  put("c", 40);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a")?.body, "a");
  assert.equal(cache.get("c")?.body, "c");
});
