import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuthTokenManager } from "./token-manager.js";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { createMemoryLedgerStore } from "../adapters/credentials/memory-ledger-store.js";
import { bindVerbs, type PortDeps } from "./verbs.js";
import type { CredentialPort, CredentialRecord } from "../ports/credentials.js";

function setupLedger(): { readonly port: CredentialPort; readonly records: () => ReadonlyArray<CredentialRecord> } {
  const store = createMemoryLedgerStore();
  const deps: PortDeps = {
    store,
    env: {},
    now: () => "2026-09-17T00:00:00.000Z",
    crypto: { randomUUID: () => "test-uuid" },
    hasProject: false,
  };

  return {
    port: bindVerbs(deps),
    records: () => {
      const res = store.read("user");
      return res.ok ? res.document.records : [];
    },
  };
}

test("Adversarial 1: 10-way concurrent 401 stampede merges into exactly ONE network refresh", async () => {
  let networkCalls = 0;
  const mockFetch: typeof globalThis.fetch = async () => {
    networkCalls += 1;
    await new Promise((r) => setTimeout(r, 20));

    return new Response(
      JSON.stringify({
        access_token: "new-access-token-456",
        refresh_token: "new-refresh-token-789",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const manager = new OAuthTokenManager({
    state: {
      providerId: "openai-compatible",
      accountId: "acc-concurrent",
      scope: "user",
      accessToken: "stale-access-token",
      refreshToken: "valid-refresh-token",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
    },
    fetchImpl: mockFetch,
  });

  // 10 concurrent requests experiencing 401 simultaneously
  const results = await Promise.all(
    Array.from({ length: 10 }, () => manager.handleAuthError(401)),
  );

  assert.equal(networkCalls, 1, "Stampede MUST merge into exactly 1 network refresh (single-flight)");

  for (const res of results) {
    assert.equal(res.refreshed, true);
    if (res.refreshed) {
      assert.equal(res.token, "new-access-token-456");
    }
  }

  assert.equal(manager.currentAccessToken, "new-access-token-456");
});

test("Adversarial 2: Expired/revoked refresh token fails closed without falling back to stale token", async () => {
  const mockFetch: typeof globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Refresh token has been revoked or expired",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };

  // The token starts out expired (constructor-owned state, injected clock),
  // so the expiry path below is exercised through the public surface rather
  // than by reaching into the manager's private state.
  const FIXED_NOW = 1_750_000_000_000;
  const manager = new OAuthTokenManager({
    state: {
      providerId: "openai-compatible",
      accountId: "acc-revoked",
      scope: "user",
      accessToken: "expired-access-token",
      refreshToken: "revoked-refresh-token",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      expiresAtMs: FIXED_NOW - 10_000,
    },
    fetchImpl: mockFetch,
    now: () => FIXED_NOW,
  });

  const res = await manager.handleAuthError(401);

  assert.equal(res.refreshed, false);

  if (!res.refreshed) {
    assert.match(res.reason, /revoked or expired/);
    assert.match(res.hint, /trylo login/);
  }

  // Attempting getValidAccessToken when expired must fail and never return stale token
  await assert.rejects(async () => {
    await manager.getValidAccessToken();
  }, /Token refresh rejected/);
});

test("Adversarial 3: Provider 401 retry is strictly bounded to 1 attempt to prevent infinite loop", async () => {
  let attempts = 0;
  const mockFetch: typeof globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      JSON.stringify({ error: { message: "Invalid token" } }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };

  let tokenManagerCalls = 0;
  const dummyTokenManager = {
    handleAuthError: async () => {
      tokenManagerCalls += 1;
      return { refreshed: true, token: `renewed-token-${tokenManagerCalls}` };
    },
  };

  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://api.openai.com/v1",
    model: "test-model",
    tokenManager: dummyTokenManager,
    fetchImpl: mockFetch,
  });

  const stream = provider.stream(
    {
      attemptId: "att-bounded-retry",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    },
    new AbortController().signal,
  );

  const events = [];

  for await (const ev of stream) {
    events.push(ev);
  }

  // 1 initial attempt + 1 retry = 2 attempts total
  assert.equal(attempts, 2, "Must retry at most once upon 401");
  assert.equal(tokenManagerCalls, 1, "Token manager must be asked to refresh once");
  const errorEvent = events.find((e) => e.type === "error");

  assert.notEqual(errorEvent, undefined);

  if (errorEvent && errorEvent.type === "error") {
    assert.equal(errorEvent.class, "auth");
    assert.match(errorEvent.message, /401/);
  }
});

test("Adversarial 4: Zero secret leaks across public entries, status, and ledger projections", () => {
  const { port } = setupLedger();
  const SECRET_KEY = "sk-super-secret-password-12345";
  const REFRESH_SECRET = "rt-refresh-secret-super-confidential";

  port.login({
    providerId: "openai-compatible",
    accountId: "sec-audit-acc",
    secret: SECRET_KEY,
    authType: "oauth",
    accessToken: SECRET_KEY,
    refreshToken: REFRESH_SECRET,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: "https://auth.openai.com/oauth/token",
  });

  // 1. Status rows: never include secret, accessToken, refreshToken
  const statusRes = port.status();

  assert.equal(statusRes.ok, true);
  const statusStr = JSON.stringify(statusRes);

  assert.equal(statusStr.includes(SECRET_KEY), false);
  assert.equal(statusStr.includes(REFRESH_SECRET), false);

  // 2. Public entries: never include secret, accessToken, refreshToken
  const listRes = port.list();

  assert.equal(listRes.ok, true);
  const listStr = JSON.stringify(listRes);

  assert.equal(listStr.includes(SECRET_KEY), false);
  assert.equal(listStr.includes(REFRESH_SECRET), false);

  // 3. Export public: never include secret, accessToken, refreshToken
  const pubRes = port.exportPublic();

  assert.equal(pubRes.ok, true);
  const pubStr = JSON.stringify(pubRes);

  assert.equal(pubStr.includes(SECRET_KEY), false);
  assert.equal(pubStr.includes(REFRESH_SECRET), false);
});

test("Adversarial 5: Multi-account isolation: account switching, deletion and protection", () => {
  const { port, records } = setupLedger();
  const TOKEN_A = "bearer-token-account-a";
  const TOKEN_B = "bearer-token-account-b";

  port.login({
    providerId: "openai-compatible",
    accountId: "account-a",
    secret: TOKEN_A,
    authType: "oauth",
    accessToken: TOKEN_A,
  });

  port.login({
    providerId: "openai-compatible",
    accountId: "account-b",
    secret: TOKEN_B,
    authType: "oauth",
    accessToken: TOKEN_B,
  });

  // Account B was added second, so it became active
  const resolvedB = port.get("openai-compatible");

  assert.equal(resolvedB.ok, true);

  if (resolvedB.ok) {
    assert.equal(resolvedB.value.accountId, "account-b");
    assert.equal(resolvedB.value.secret, TOKEN_B);
  }

  // Deleting active account must be blocked
  const delActive = port.delete({ providerId: "openai-compatible", accountId: "account-b", scope: "user" });

  assert.equal(delActive.ok, false);

  if (!delActive.ok) {
    assert.equal(delActive.code, "current_account_protected");
  }

  // Switch back to Account A
  const switchRes = port.switch({ providerId: "openai-compatible", accountId: "account-a", scope: "user" });

  assert.equal(switchRes.ok, true);

  const resolvedA = port.get("openai-compatible");

  assert.equal(resolvedA.ok, true);

  if (resolvedA.ok) {
    assert.equal(resolvedA.value.accountId, "account-a");
    assert.equal(resolvedA.value.secret, TOKEN_A);
  }

  // Now account-b is inactive, deleting it succeeds
  const delInactive = port.delete({ providerId: "openai-compatible", accountId: "account-b", scope: "user" });

  assert.equal(delInactive.ok, true);

  // Verify only account-a remains
  assert.equal(records().length, 1);
  assert.equal(records()[0]?.accountId, "account-a");
});
