import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuthTokenManager } from "./token-manager.js";
import { startMockOAuthServer } from "./mock-oauth-server.js";
import { computeChallenge } from "./oauth-pkce.js";

test("OAuthTokenManager returns current access token when unexpired", async () => {
  const now = Date.now();
  const manager = new OAuthTokenManager({
    state: {
      providerId: "openai-compatible",
      accountId: "acc-1",
      scope: "user",
      accessToken: "at-current",
      refreshToken: "rt-current",
      expiresAtMs: now + 3600_000,
    },
    now: () => now,
  });

  const token = await manager.getValidAccessToken();

  assert.equal(token, "at-current");
});

test("OAuthTokenManager automatically refreshes when token is near expiration", async () => {
  const mockServer = await startMockOAuthServer();
  try {
    const verifier = "dummy-verifier-value-43-chars-long-strictly-ascii";
    const challenge = computeChallenge(verifier);

    // Issue initial refresh token in mock server
    const authCode = mockServer.issueCode({
      clientId: "client-1",
      codeChallenge: challenge,
      redirectUri: "http://127.0.0.1/cb",
    });

    const exchangeRes = await fetch(mockServer.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        client_id: "client-1",
        redirect_uri: "http://127.0.0.1/cb",
        code_verifier: verifier,
      }).toString(),
    });
    const exchangeData = (await exchangeRes.json()) as { access_token: string; refresh_token: string };

    assert.ok(exchangeData.refresh_token);

    let tokenUpdated = false;
    let newIssuedToken = "";

    const now = 1000_000;
    const manager = new OAuthTokenManager({
      state: {
        providerId: "openai-compatible",
        accountId: "acc-1",
        scope: "user",
        accessToken: "at-old-expired",
        refreshToken: exchangeData.refresh_token,
        expiresAtMs: now + 10_000, // < 30s buffer -> expired
        tokenEndpoint: mockServer.tokenEndpoint,
        clientId: "client-1",
      },
      now: () => now,
      onTokenUpdated: (tokens) => {
        tokenUpdated = true;
        newIssuedToken = tokens.accessToken;
      },
    });

    const refreshed = await manager.getValidAccessToken();

    assert.equal(tokenUpdated, true);
    assert.equal(refreshed, newIssuedToken);
  } finally {
    await mockServer.close();
  }
});

test("OAuthTokenManager single-flight concurrency: 10 concurrent refreshes make exactly 1 HTTP call", async () => {
  let httpCalls = 0;
  const simulatedFetch: typeof globalThis.fetch = async () => {
    httpCalls += 1;
    // Simulate 50ms network delay
    await new Promise((r) => setTimeout(r, 50));

    return new Response(
      JSON.stringify({
        access_token: "at-single-flight-renewed",
        refresh_token: "rt-renewed",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const manager = new OAuthTokenManager({
    state: {
      providerId: "openai-compatible",
      accountId: "acc-single-flight",
      scope: "user",
      accessToken: "at-stale",
      refreshToken: "rt-initial",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      clientId: "client-sf",
    },
    fetchImpl: simulatedFetch,
  });

  // Launch 10 concurrent refresh calls
  const promises = Array.from({ length: 10 }, () => manager.refreshToken());
  const results = await Promise.all(promises);

  // All 10 callers must receive the exact same renewed token
  for (const token of results) {
    assert.equal(token, "at-single-flight-renewed");
  }

  // Exactly 1 network request was performed
  assert.equal(httpCalls, 1, "Single-flight MUST dispatch exactly 1 HTTP call for concurrent requests");
});

test("OAuthTokenManager 401 resolution: handles 401 error, single-flights, and reports failure closed if rejected", async () => {
  let fetchCallCount = 0;
  const failingFetch: typeof globalThis.fetch = async () => {
    fetchCallCount += 1;
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Refresh token revoked by user",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };

  const manager = new OAuthTokenManager({
    state: {
      providerId: "openai-compatible",
      accountId: "acc-revoked",
      scope: "user",
      accessToken: "at-stale-revoked",
      refreshToken: "rt-revoked",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
    },
    fetchImpl: failingFetch,
  });

  const res = await manager.handleAuthError(401);

  assert.equal(res.refreshed, false);

  if (!res.refreshed) {
    assert.match(res.reason, /Refresh token revoked by user/);
    assert.match(res.hint, /trylo login --provider openai-compatible/);
  }

  // Attempting again after failure can try again and does not hang
  const res2 = await manager.handleAuthError(401);

  assert.equal(res2.refreshed, false);
  assert.equal(fetchCallCount, 2);
});

test("OAuthTokenManager ignores non-401 errors", async () => {
  const manager = new OAuthTokenManager({
    state: {
      providerId: "openai-compatible",
      accountId: "acc-1",
      scope: "user",
      accessToken: "at-ok",
    },
  });

  const res = await manager.handleAuthError(500);

  assert.equal(res.refreshed, false);

  if (!res.refreshed) {
    assert.equal(res.reason, "HTTP 500");
  }
});
