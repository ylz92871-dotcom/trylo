import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePkce, verifyPkce } from "./oauth-pkce.js";
import { isAllowedOAuthEndpoint } from "./oauth-endpoints.js";
import { startMockOAuthServer } from "./mock-oauth-server.js";
import { executeOAuthFlow } from "./oauth-flow.js";

test("PKCE generator and verifier enforce S256 challenge contract", () => {
  const pkce = generatePkce();

  assert.equal(pkce.method, "S256");
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
  assert.ok(pkce.challenge.length > 0);

  assert.equal(verifyPkce(pkce.verifier, pkce.challenge), true);
  assert.equal(verifyPkce("tampered-verifier-which-does-not-match-challenge-43chars!", pkce.challenge), false);
  assert.equal(verifyPkce("short", pkce.challenge), false);
});

test("OAuth endpoint allowlist rejects untrusted hosts (SSRF prevention, D3)", () => {
  assert.equal(isAllowedOAuthEndpoint("https://auth.openai.com/oauth/token"), true);
  assert.equal(isAllowedOAuthEndpoint("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(isAllowedOAuthEndpoint("http://127.0.0.1:8080/token"), true);
  assert.equal(isAllowedOAuthEndpoint("http://localhost:3000/callback"), true);

  // Rejections
  assert.equal(isAllowedOAuthEndpoint("http://auth.openai.com/token"), false, "HTTP on remote host must be rejected");
  assert.equal(isAllowedOAuthEndpoint("https://malicious-phishing.com/oauth/authorize"), false);
  assert.equal(isAllowedOAuthEndpoint("ftp://127.0.0.1/token"), false);
  assert.equal(isAllowedOAuthEndpoint("not-a-url"), false);

  const customAllowed = new Set(["internal.enterprise.com"]);

  assert.equal(isAllowedOAuthEndpoint("https://internal.enterprise.com/oauth", customAllowed), true);
});

test("executeOAuthFlow executes full PKCE round-trip against in-process MockOAuthServer", async () => {
  const mockServer = await startMockOAuthServer();
  try {
    const flowPromise = executeOAuthFlow({
      authorizeEndpoint: mockServer.authorizeEndpoint,
      tokenEndpoint: mockServer.tokenEndpoint,
      clientId: "test-client-id",
      scope: "read write",
      onAuthorizeUrl: async (authUrl) => {
        // Simulate user browser following the authorization URL
        const res = await fetch(authUrl, { redirect: "follow" });
        assert.equal(res.status, 200);
      },
    });

    const result = await flowPromise;

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.ok(result.tokens.accessToken.startsWith("at-"));
      assert.ok(result.tokens.refreshToken?.startsWith("rt-"));
      assert.ok(result.tokens.expiresAt !== undefined);
      assert.equal(result.tokens.tokenType, "Bearer");
      assert.equal(result.tokens.clientId, "test-client-id");
    }

    assert.equal(mockServer.getCodeExchangeCount(), 1);
  } finally {
    await mockServer.close();
  }
});

test("executeOAuthFlow fails closed when endpoint is not in allowlist", async () => {
  const result = await executeOAuthFlow({
    authorizeEndpoint: "https://evil.attacker.org/authorize",
    tokenEndpoint: "https://auth.openai.com/oauth/token",
    clientId: "test-client-id",
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "untrusted_endpoint");
    assert.match(result.detail, /evil\.attacker\.org/);
  }
});

test("executeOAuthFlow handles rejected authorization code from mock server", async () => {
  const mockServer = await startMockOAuthServer({ rejectAuthCode: true });
  try {
    const flowPromise = executeOAuthFlow({
      authorizeEndpoint: mockServer.authorizeEndpoint,
      tokenEndpoint: mockServer.tokenEndpoint,
      clientId: "test-client-id",
      onAuthorizeUrl: async (authUrl) => {
        await fetch(authUrl, { redirect: "follow" });
      },
    });

    const result = await flowPromise;

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "callback_failed");
      assert.match(result.detail, /access_denied/);
    }
  } finally {
    await mockServer.close();
  }
});

test("expiresAt is computed from the injected clock, not the ambient one", async () => {
  const mockServer = await startMockOAuthServer();
  try {
    const FIXED_NOW_MS = 1_750_000_000_000;
    const result = await executeOAuthFlow({
      authorizeEndpoint: mockServer.authorizeEndpoint,
      tokenEndpoint: mockServer.tokenEndpoint,
      clientId: "test-client-id",
      now: () => FIXED_NOW_MS,
      onAuthorizeUrl: async (authUrl) => {
        const res = await fetch(authUrl, { redirect: "follow" });
        assert.equal(res.status, 200);
      },
    });

    assert.equal(result.ok, true);

    if (result.ok) {
      // The mock server grants expires_in: 3600 seconds.
      assert.equal(result.tokens.expiresAt, new Date(FIXED_NOW_MS + 3600 * 1000).toISOString());
    }
  } finally {
    await mockServer.close();
  }
});
